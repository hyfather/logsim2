package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nikhilm/logsim2/pkg/config"
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

// With a single enabled destination in the dotfile, no flags → that destination.
func TestBuildSinks_AutoSingleDestination(t *testing.T) {
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
		t.Errorf("expected 1 sink, got %d", len(got))
	}
	if !strings.Contains(stderr.String(), `forwarding to "solo"`) {
		t.Errorf("expected stderr hint, got %q", stderr.String())
	}
}

// With two enabled destinations and no --to, default to stdout (and warn).
func TestBuildSinks_AutoMultipleFallsBackToStdout(t *testing.T) {
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
	if !strings.Contains(stderr.String(), "use --to") {
		t.Errorf("expected --to hint, got %q", stderr.String())
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
