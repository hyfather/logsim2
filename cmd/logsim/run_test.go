package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/config"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

func writeDotfile(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "destinations.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Setenv("LOGSIM_CONFIG", path)
	return path
}

const dotfileTwo = `
destinations:
  - name: alpha
    type: cribl_hec
    enabled: true
    url: https://a.example.com/services/collector/event
    token: ta
  - name: beta
    type: cribl_hec
    enabled: true
    url: https://b.example.com/services/collector/event
    token: tb
  - name: disabled-one
    type: cribl_hec
    enabled: false
    url: https://c.example.com/services/collector/event
    token: tc
`

const dotfileOne = `
destinations:
  - name: solo
    type: cribl_hec
    enabled: true
    url: https://only.example.com/services/collector/event
    token: tok
`

// fanout via --to=name1,name2 should produce two sinks.
func TestBuildSinks_ToFanout(t *testing.T) {
	writeDotfile(t, dotfileTwo)
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		To:     "alpha,beta",
		Quiet:  true,
		Stderr: &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 2 {
		t.Errorf("expected 2 sinks, got %d", len(got))
	}
}

// --to=all should include only enabled destinations.
func TestBuildSinks_ToAllSkipsDisabled(t *testing.T) {
	writeDotfile(t, dotfileTwo)
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		To:     "all",
		Quiet:  true,
		Stderr: &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 2 {
		t.Errorf("expected 2 enabled sinks, got %d", len(got))
	}
}

// --to of a disabled destination errors with a helpful message.
func TestBuildSinks_ToDisabledIsError(t *testing.T) {
	writeDotfile(t, dotfileTwo)
	_, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		To:     "disabled-one",
		Quiet:  true,
	})
	if err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("expected disabled error, got %v", err)
	}
}

// --to of an unknown destination errors.
func TestBuildSinks_ToUnknown(t *testing.T) {
	writeDotfile(t, dotfileTwo)
	_, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		To:     "ghost",
		Quiet:  true,
	})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not-found error, got %v", err)
	}
}

// With no output flags, default is stdout — even when a single enabled
// destination exists in the dotfile. Destinations are opt-in via --to.
func TestBuildSinks_DefaultIsStdoutWithSingleDestination(t *testing.T) {
	writeDotfile(t, dotfileOne)
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Stderr: &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 stdout sink, got %d", len(got))
	}
	if strings.Contains(stderr.String(), "forwarding to") {
		t.Errorf("did not expect auto-forwarding hint, got %q", stderr.String())
	}
}

// Stdout is silent — no apologetic warning about un-used destinations.
func TestBuildSinks_DefaultIsSilentWithMultipleDestinations(t *testing.T) {
	writeDotfile(t, dotfileTwo)
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Stderr: &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 stdout sink, got %d", len(got))
	}
	if stderr.String() != "" {
		t.Errorf("expected silent default, got stderr %q", stderr.String())
	}
}

// With no dotfile at all, the default is plain stdout with no hint about
// setting a destination up — destinations are entirely optional.
func TestBuildSinks_DefaultIsSilentWithNoDotfile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Stderr: &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 stdout sink, got %d", len(got))
	}
	if stderr.String() != "" {
		t.Errorf("expected silent default, got stderr %q", stderr.String())
	}
}

// --out PATH alone (no --output) should write to a file, not silently fall to stdout.
func TestBuildSinks_OutPathImpliesFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	outPath := filepath.Join(dir, "logs.jsonl")
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Out:    []string{outPath},
		Quiet:  true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 file sink, got %d", len(got))
	}
	if _, err := os.Stat(outPath); err != nil {
		t.Errorf("file not created: %v", err)
	}
}

// --path alone (legacy) should imply file output too — fixes the prior
// silent-drop where --path without --output=file produced stdout.
func TestBuildSinks_LegacyPathImpliesFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	outPath := filepath.Join(dir, "legacy.jsonl")
	got, err := buildSinks(buildSinksOpts{
		Format:   "jsonl",
		FilePath: outPath,
		Quiet:    true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 file sink, got %d", len(got))
	}
	if _, err := os.Stat(outPath); err != nil {
		t.Errorf("file not created: %v", err)
	}
}

// "-" as an --out value resolves to stdout.
func TestBuildSinks_OutDashIsStdout(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Out:    []string{"-"},
		Quiet:  true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 stdout sink, got %d", len(got))
	}
}

// --out fans out across multiple files when comma-separated or repeated.
func TestBuildSinks_OutFanout(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	a := filepath.Join(dir, "a.jsonl")
	b := filepath.Join(dir, "b.jsonl")
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Out:    []string{a + "," + b},
		Quiet:  true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 2 {
		t.Errorf("expected 2 file sinks, got %d", len(got))
	}
}

// --out + --to combine — file copy plus destination forwarding.
func TestBuildSinks_OutCombinesWithTo(t *testing.T) {
	writeDotfile(t, dotfileOne)
	dir := t.TempDir()
	outPath := filepath.Join(dir, "copy.jsonl")
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl",
		Out:    []string{outPath},
		To:     "solo",
		Quiet:  true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 2 {
		t.Errorf("expected file + destination sinks, got %d", len(got))
	}
}

// Format inference: a "logs.ocsf.json" filename without --format should pick OCSF.
func TestBuildSinks_FormatInferredFromExtension(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	outPath := filepath.Join(dir, "logs.ocsf.json")
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format: "jsonl", // default, FormatExplicit=false
		Out:    []string{outPath},
		Stderr: &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if !strings.Contains(stderr.String(), "inferred --format=ocsf") {
		t.Errorf("expected inference hint, got %q", stderr.String())
	}
}

// Explicit --format wins over filename inference.
func TestBuildSinks_ExplicitFormatBeatsInference(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	outPath := filepath.Join(dir, "logs.ocsf.json")
	var stderr bytes.Buffer
	got, err := buildSinks(buildSinksOpts{
		Format:         "jsonl",
		FormatExplicit: true,
		Out:            []string{outPath},
		Stderr:         &stderr,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if strings.Contains(stderr.String(), "inferred") {
		t.Errorf("did not expect inference when --format was explicit, got %q", stderr.String())
	}
}

// inferFormatFromPath is the unit-level check for the helper.
func TestInferFormatFromPath(t *testing.T) {
	cases := map[string]string{
		"logs.ocsf.json":         "ocsf",
		"/tmp/x.ocsf.jsonl":      "ocsf",
		"events.OTEL.json":       "otel",
		"plain.json":             "",
		"no-extension":           "",
		"weird.ocsf":             "",
		"logs.tar.gz":            "",
	}
	for in, want := range cases {
		if got := inferFormatFromPath(in); got != want {
			t.Errorf("inferFormatFromPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// --tee always layers in a file sink alongside the chosen output.
func TestBuildSinks_TeeAlongsideStdout(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	teePath := filepath.Join(dir, "tee.jsonl")
	got, err := buildSinks(buildSinksOpts{
		Output: "stdout",
		Format: "jsonl",
		Tee:    teePath,
		Quiet:  true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 2 {
		t.Errorf("expected stdout + tee, got %d sinks", len(got))
	}
	if _, err := os.Stat(teePath); err != nil {
		t.Errorf("tee file missing: %v", err)
	}
}

// --output=destination still works for backwards compatibility.
func TestBuildSinks_LegacyOutputDestination(t *testing.T) {
	writeDotfile(t, dotfileOne)
	got, err := buildSinks(buildSinksOpts{
		Output:      "destination",
		Destination: "solo",
		Format:      "jsonl",
		Quiet:      true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 sink, got %d", len(got))
	}
}

// --output=destination requires --destination.
func TestBuildSinks_LegacyOutputDestinationRequiresName(t *testing.T) {
	writeDotfile(t, dotfileOne)
	_, err := buildSinks(buildSinksOpts{
		Output: "destination",
		Format: "jsonl",
		Quiet:  true,
	})
	if err == nil || !strings.Contains(err.Error(), "--destination is required") {
		t.Fatalf("expected required-flag error, got %v", err)
	}
}

// Unknown --output value errors.
func TestBuildSinks_UnknownOutput(t *testing.T) {
	_, err := buildSinks(buildSinksOpts{
		Output: "kafka",
		Format: "jsonl",
		Quiet:  true,
	})
	if err == nil || !strings.Contains(err.Error(), "unknown --output") {
		t.Fatalf("expected unknown-output error, got %v", err)
	}
}

// Explicit --config (rather than the dotfile) is used to resolve --to.
func TestBuildSinks_ExplicitConfigOverridesDotfile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "missing.yaml"))
	cfgPath := filepath.Join(dir, "explicit.yaml")
	if err := os.WriteFile(cfgPath, []byte(dotfileOne), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := buildSinks(buildSinksOpts{
		ConfigPath: cfgPath,
		To:         "solo",
		Format:     "jsonl",
		Quiet:      true,
	})
	if err != nil {
		t.Fatalf("buildSinks: %v", err)
	}
	defer closeSinks(got)
	if len(got) != 1 {
		t.Errorf("expected 1 sink, got %d", len(got))
	}
}

// Sanity-check that splitNames trims whitespace and resolves "all" correctly.
func TestSplitNames(t *testing.T) {
	cfg := &config.DestinationsConfig{Destinations: []config.Destination{
		{Name: "a", Enabled: true},
		{Name: "b", Enabled: false},
		{Name: "c", Enabled: true},
	}}
	if got := splitNames(" a , b , c", cfg); len(got) != 3 || got[0] != "a" || got[2] != "c" {
		t.Errorf("trim/split broke: %v", got)
	}
	if got := splitNames("ALL", cfg); len(got) != 2 || got[0] != "a" || got[1] != "c" {
		t.Errorf("all should select enabled only: %v", got)
	}
}

// resolveTicks: the headline behavior change is that omitting --ticks now
// runs the entire scenario rather than truncating at 100.
func TestResolveTicks(t *testing.T) {
	cases := []struct {
		name             string
		flag             int
		flagSet          bool
		scenarioDuration int
		want             int
	}{
		{"flag wins over scenario", 50, true, 1080, 50},
		{"flag set to 0 falls through", 0, true, 1080, 1080},
		{"unset uses scenario duration", 0, false, 1080, 1080},
		{"unset, no duration, falls back to 100", 0, false, 0, 100},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveTicks(c.flag, c.flagSet, c.scenarioDuration); got != c.want {
				t.Errorf("resolveTicks(%d, %v, %d) = %d, want %d",
					c.flag, c.flagSet, c.scenarioDuration, got, c.want)
			}
		})
	}
}

// resolveTickIntervalMs: prefers explicit flag, then scenario, then 1s.
func TestResolveTickIntervalMs(t *testing.T) {
	cases := []struct {
		name       string
		flagVal    string
		flagSet    bool
		scenarioMs int
		want       int
		wantErr    bool
	}{
		{"flag wins", "500ms", true, 1000, 500, false},
		{"unset uses scenario", "", false, 1000, 1000, false},
		{"unset, no scenario, defaults to 1s", "", false, 0, 1000, false},
		{"invalid flag returns error", "garbage", true, 0, 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := resolveTickIntervalMs(c.flagVal, c.flagSet, c.scenarioMs)
			if (err != nil) != c.wantErr {
				t.Errorf("err = %v, wantErr %v", err, c.wantErr)
			}
			if !c.wantErr && got != c.want {
				t.Errorf("got %d, want %d", got, c.want)
			}
		})
	}
}

// formatAttempt produces single-line traces for stderr. The shape is part
// of the CLI contract — scripts/operators read these, so lock them in.
func TestFormatAttempt(t *testing.T) {
	ok := sinks.SendResult{StatusCode: 200, BatchSize: 50, Duration: 142 * time.Millisecond, Attempt: 1, Final: true}
	if got := formatAttempt(ok); !strings.Contains(got, "POST → 200") || !strings.Contains(got, "50 events") {
		t.Errorf("ok line missing pieces: %q", got)
	}

	retrying := sinks.SendResult{StatusCode: 503, BatchSize: 50, Err: errors.New("server error 503"), Final: false}
	if got := formatAttempt(retrying); !strings.Contains(got, "503") || !strings.Contains(got, "retrying") {
		t.Errorf("retry line missing pieces: %q", got)
	}

	dropped := sinks.SendResult{StatusCode: 401, BatchSize: 50, Err: errors.New("client error 401"), Final: true}
	if got := formatAttempt(dropped); !strings.Contains(got, "401") || !strings.Contains(got, "dropped") {
		t.Errorf("drop line missing pieces: %q", got)
	}

	transport := sinks.SendResult{BatchSize: 50, Err: errors.New("dial tcp: refused"), Final: true}
	if got := formatAttempt(transport); !strings.Contains(got, "ERR") || !strings.Contains(got, "gave up") {
		t.Errorf("transport line missing pieces: %q", got)
	}
}

// End-to-end: when --to is set against a working HEC server, the reporter
// prints the per-batch trace and the closing summary; in quiet mode the
// per-batch chatter is gone but the summary stays so scripts can grep it.
func TestForwardingReporter_EndToEnd(t *testing.T) {
	for _, quiet := range []bool{false, true} {
		quiet := quiet
		t.Run(map[bool]string{false: "verbose", true: "quiet"}[quiet], func(t *testing.T) {
			var hits int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&hits, 1)
				w.WriteHeader(http.StatusOK)
			}))
			defer srv.Close()

			c := sinks.NewCribl(srv.URL, "tok", 5, 0)
			c.SetName("demo")

			var stderr bytes.Buffer
			reporter := attachForwardingReporter([]sinks.Sink{c}, &stderr, quiet)

			// 12 entries over batch size 5 → 2 full batches + 1 partial on close.
			entries := make([]event.LogEntry, 12)
			for i := range entries {
				entries[i] = event.LogEntry{ID: "e", Sourcetype: "nodejs", Raw: "log"}
			}
			if err := c.Write(entries); err != nil {
				t.Fatalf("write: %v", err)
			}
			if err := c.Close(); err != nil {
				t.Fatalf("close: %v", err)
			}
			reporter.Summarize(&stderr)

			out := stderr.String()
			if !strings.Contains(out, "sent 12 events to demo in 3 batches") {
				t.Errorf("missing summary: %q", out)
			}
			if quiet && strings.Contains(out, "POST → 200") {
				t.Errorf("quiet mode should suppress per-attempt lines; got %q", out)
			}
			if !quiet {
				if !strings.Contains(out, "POST → 200") {
					t.Errorf("verbose mode should show per-attempt lines; got %q", out)
				}
				if !strings.Contains(out, "forwarding → demo") {
					t.Errorf("verbose mode should show forwarding header; got %q", out)
				}
			}
			if int(atomic.LoadInt32(&hits)) != 3 {
				t.Errorf("expected 3 HTTP hits, got %d", hits)
			}
		})
	}
}

// confirmYesNo: only "y"/"yes" (case-insensitive) advance.
func TestConfirmYesNo(t *testing.T) {
	cases := map[string]bool{
		"y\n":   true,
		"Y\n":   true,
		"yes\n": true,
		"YES\n": true,
		"n\n":   false,
		"\n":    false,
		"":      false,
		"foo\n": false,
	}
	for in, want := range cases {
		var stderr bytes.Buffer
		got := confirmYesNo(strings.NewReader(in), &stderr, "go? ")
		if got != want {
			t.Errorf("input %q: got %v, want %v", in, got, want)
		}
		if !strings.Contains(stderr.String(), "go? ") {
			t.Errorf("input %q: prompt missing from stderr (%q)", in, stderr.String())
		}
	}
}

// shouldPrompt: quiet mode + non-tty stdin both suppress the prompt.
func TestShouldPrompt(t *testing.T) {
	if shouldPrompt(strings.NewReader(""), false) {
		t.Errorf("non-tty Reader should never prompt")
	}
	if shouldPrompt(strings.NewReader(""), true) {
		t.Errorf("quiet mode should never prompt")
	}
	// A regular file is not a char-device; same path as a pipe.
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open devnull: %v", err)
	}
	defer f.Close()
	if shouldPrompt(f, false) {
		t.Errorf("regular file (not a tty) should not prompt")
	}
}
