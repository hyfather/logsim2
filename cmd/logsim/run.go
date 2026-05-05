package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/nikhilm/logsim2/pkg/config"
	"github.com/nikhilm/logsim2/pkg/encoders"
	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// validFormats is the canonical set accepted by --format. Order is the order
// shown in --help and in error messages.
var validFormats = []string{"jsonl", "raw", "ocsf", "otel", "udm", "asim"}

func isValidFormat(s string) bool {
	for _, f := range validFormats {
		if f == s {
			return true
		}
	}
	return false
}

func newRunCmd() *cobra.Command {
	var (
		scenarioPath string
		ticks        int
		tickInterval string
		force        bool

		// Modern, intent-driven flags.
		out     []string // -o/--out: "-" stdout, path = file, may repeat / comma-split
		to      string   // dotfile destination(s) by name; "all" = every enabled
		tee     string   // additional file copy
		useOCSF bool     // shortcut for --format=ocsf
		useOTEL bool     // shortcut for --format=otel

		// Legacy escape hatches retained for back-compat.
		output      string
		filePath    string
		appendMode  bool
		destination string

		configPath   string
		sourceFilter string
		seed         int64
		format       string
		quiet        bool
		listFormats  bool
	)

	cmd := &cobra.Command{
		Use:   "run [scenario.yaml | https://…/scenario.yaml | <slug>]",
		Short: "Run a simulation and emit logs",
		Long: `Run executes a scenario and emits log entries.

The scenario is the primary argument — pass it positionally as a local file
path, an http(s) URL, or a bare catalog slug (see ` + "`logsim list`" + `). Slugs
resolve to ` + scenario.DefaultBaseURL + `/s/<slug>.yaml; remote scenarios are
fetched, capped at 4 MiB, and parsed exactly like local files.

By default, Run plays the entire scenario — every tick declared by
` + "`duration:`" + ` in the YAML, at the cadence in ` + "`tick_interval_ms:`" + `. Pass --ticks
to truncate, or --tick-interval to override pacing.

Stdout is the default — pipe or redirect as you like. Pass -o/--out to write
to a file (or "-" for stdout), or --to to forward to one or more named
destinations. With --to, Run does NOT print log lines; it streams the
forwarding status (POST → status code, batch size, latency) to stderr and
finishes with a one-line confirmation listing events sent per destination.

Examples:
  # play the whole scenario to stdout (full duration from the YAML)
  logsim run scenarios/web-service.yaml | jq .

  # run a catalog scenario by slug — see ` + "`logsim list`" + ` for the full set
  logsim run db-slowdown-cascade

  # or pass the URL explicitly
  logsim run https://logsim2.vercel.app/s/db-slowdown-cascade.yaml

  # truncate to a sample
  logsim run cache-failure-cascade --ticks 60

  # emit OCSF or OTEL to stdout
  logsim run scenarios/web-service.yaml --ocsf
  logsim run scenarios/web-service.yaml --otel

  # write to a file (format inferred from .ocsf.* / .otel.* suffix)
  logsim run scenarios/web-service.yaml -o /tmp/logs.jsonl
  logsim run scenarios/web-service.yaml -o /tmp/logs.ocsf.json

  # forward to a configured destination — prints HEC status, not log lines
  logsim run cache-failure-cascade --to prod-cribl
  logsim run cache-failure-cascade --to all

  # forward and keep a local copy
  logsim run scenarios/web-service.yaml --to prod-cribl -o ./trace.jsonl`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if listFormats {
				for _, f := range validFormats {
					fmt.Fprintln(cmd.OutOrStdout(), f)
				}
				return nil
			}

			// Resolve scenario from the positional arg or legacy --scenario flag.
			switch {
			case len(args) == 1 && scenarioPath == "":
				scenarioPath = args[0]
			case len(args) == 1 && scenarioPath != "" && scenarioPath != args[0]:
				return fmt.Errorf("scenario specified twice: positional %q and --scenario %q",
					args[0], scenarioPath)
			case len(args) == 0 && scenarioPath == "":
				return errors.New("scenario is required: pass it positionally (`logsim run path/to/scenario.yaml`, `logsim run https://…/scenario.yaml`, or `logsim run <slug>` — see `logsim list`) or via --scenario")
			}

			// Resolve format shortcuts before validation.
			if useOCSF && useOTEL {
				return errors.New("--ocsf and --otel are mutually exclusive")
			}
			explicitFormat := cmd.Flags().Changed("format")
			switch {
			case useOCSF:
				if explicitFormat && format != "ocsf" {
					return fmt.Errorf("--ocsf conflicts with --format=%s", format)
				}
				format = "ocsf"
			case useOTEL:
				if explicitFormat && format != "otel" {
					return fmt.Errorf("--otel conflicts with --format=%s", format)
				}
				format = "otel"
			}

			if !isValidFormat(format) {
				return fmt.Errorf("--format %q: must be one of %s",
					format, strings.Join(validFormats, ", "))
			}

			s, err := scenario.LoadAndValidate(scenarioPath)
			if err != nil {
				return fmt.Errorf("scenario: %w", err)
			}

			// Tick interval: explicit flag wins, then scenario.tick_interval_ms,
			// then a 1s default. Same shape for total ticks: explicit --ticks wins,
			// then scenario.duration, then 100. Running the *whole* scenario by
			// default — not a 100-tick stub — is what users expect when they say
			// `logsim run <slug>`.
			intervalMs, err := resolveTickIntervalMs(tickInterval, cmd.Flags().Changed("tick-interval"), s.TickIntervalMs)
			if err != nil {
				return err
			}
			totalTicks := resolveTicks(ticks, cmd.Flags().Changed("ticks"), s.Duration)

			if seed == 0 {
				seed = rand.New(rand.NewSource(time.Now().UnixNano())).Int63()
			}

			cfg := engine.Config{
				Seed:           seed,
				StartTime:      time.Now(),
				TickIntervalMs: intervalMs,
				SourceFilter:   sourceFilter,
			}

			// Long scenarios (cache-failure-cascade is 1080 ticks → ~55k logs)
			// can dump a *lot* of output. Sample one tick to estimate the total
			// and prompt before continuing if it's beyond the threshold;
			// --force / --quiet / non-tty stdin all skip the prompt.
			estimated := estimateLogCount(s, cfg, totalTicks)
			if estimated > promptThreshold && !force && shouldPrompt(cmd.InOrStdin(), quiet) {
				if !confirmYesNo(cmd.InOrStdin(), cmd.ErrOrStderr(),
					fmt.Sprintf("logsim: %q will produce ~%d log lines over %d ticks. continue? [y/N] ",
						s.Name, estimated, totalTicks)) {
					return errors.New("aborted")
				}
			}

			eng := engine.New(s, cfg)

			sinkList, err := buildSinks(buildSinksOpts{
				Output:         output,
				Format:         format,
				FormatExplicit: explicitFormat || useOCSF || useOTEL,
				FilePath:       filePath,
				Out:            out,
				AppendMode:     appendMode,
				Destination:    destination,
				To:             to,
				Tee:            tee,
				ConfigPath:     configPath,
				Quiet:          quiet,
				Stderr:         cmd.ErrOrStderr(),
				Stdin:          cmd.InOrStdin(),
			})
			if err != nil {
				return err
			}
			// Close-once guard: the happy path closes sinks explicitly before
			// summarising (Cribl's partial-batch flush has to fire the observer
			// before the summary reads its counters), but an early error must
			// still close. The closure reads `sinkList` lazily so the explicit
			// close can null it out.
			defer func() { closeSinks(sinkList) }()

			// When forwarding to destinations, the user wants HEC visibility,
			// not log lines. attachForwardingReporter wires the per-attempt
			// observer; Summarize prints the final tally.
			reporter := attachForwardingReporter(sinkList, cmd.ErrOrStderr(), quiet)

			if !quiet {
				fmt.Fprintf(cmd.ErrOrStderr(), "logsim: running %d ticks for %q (seed=%d)\n", totalTicks, s.Name, seed)
			}
			runErr := eng.Run(context.Background(), totalTicks, sinkList)
			// Flush the trailing partial batch before reading observer counters
			// so the summary line reflects every event, including the tail.
			closeSinks(sinkList)
			sinkList = nil
			reporter.Summarize(cmd.ErrOrStderr())
			return runErr
		},
	}

	cmd.Flags().StringVar(&scenarioPath, "scenario", "", "path or http(s) URL of the scenario YAML (or pass it positionally)")
	cmd.Flags().IntVar(&ticks, "ticks", 0, "number of ticks to emit (default: scenario duration; falls back to 100)")
	cmd.Flags().StringVar(&tickInterval, "tick-interval", "", "simulated time per tick (default: scenario tick_interval_ms; falls back to 1s)")
	cmd.Flags().BoolVar(&force, "force", false, "skip the >5k-log confirmation prompt")

	// Modern outputs.
	cmd.Flags().StringSliceVarP(&out, "out", "o", nil,
		"output target: a file path, or \"-\" for stdout (repeat or comma-separate to fan out)")
	cmd.Flags().StringVar(&to, "to", "",
		"comma-separated list of dotfile destinations (or `all`)")
	cmd.Flags().StringVar(&tee, "tee", "",
		"additionally write a copy of every log line to this file")

	// Format selection.
	cmd.Flags().StringVarP(&format, "format", "f", "jsonl",
		"line format: "+strings.Join(validFormats, " | "))
	cmd.Flags().BoolVar(&useOCSF, "ocsf", false, "shortcut for --format=ocsf")
	cmd.Flags().BoolVar(&useOTEL, "otel", false, "shortcut for --format=otel")
	cmd.Flags().BoolVar(&listFormats, "list-formats", false, "print supported --format values and exit")
	cmd.MarkFlagsMutuallyExclusive("ocsf", "otel")

	// Legacy / explicit forms.
	cmd.Flags().StringVar(&output, "output", "",
		"explicit output kind: stdout | file | destination (legacy; prefer --out / --to)")
	cmd.Flags().StringVar(&filePath, "path", "", "output file path (alias for --out when --output is unset)")
	cmd.Flags().BoolVar(&appendMode, "append", false, "append to file instead of truncating")
	cmd.Flags().StringVar(&destination, "destination", "", "destination name (legacy; prefer --to)")
	cmd.Flags().StringVar(&configPath, "config", "", "destinations YAML (overrides the dotfile)")

	cmd.Flags().StringVar(&sourceFilter, "source-filter", "*", "source path glob filter")
	cmd.Flags().Int64Var(&seed, "seed", 0, "RNG seed (0 = random)")
	cmd.Flags().BoolVar(&quiet, "quiet", false, "suppress informational log lines on stderr")

	return cmd
}

type buildSinksOpts struct {
	Output         string
	Format         string
	FormatExplicit bool
	FilePath       string
	Out            []string
	AppendMode     bool
	Destination    string
	To             string
	Tee            string
	ConfigPath     string
	Quiet          bool
	Stderr         io.Writer
	Stdin          io.Reader
}

// buildSinks resolves CLI flags into a concrete sink list. Resolution order:
//
//  1. Legacy --output (stdout|file|destination) is honored verbatim.
//  2. --out and/or --path open file/stdout sinks.
//  3. --to (or legacy --destination) adds dotfile destination sinks.
//  4. With no output flags set, default to stdout. Stdout is a first-class
//     mode (pipe into another tool, redirect, etc.) — destinations are
//     entirely opt-in via --to and never auto-selected.
//  5. --tee always appends a file sink.
//
// Format inference: if a single file path is given without an explicit
// --format, a `.ocsf.*` or `.otel.*` suffix is honored.
func buildSinks(opts buildSinksOpts) ([]sinks.Sink, error) {
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	// --path is an alias for --out when --output isn't the explicit "file" form.
	// This fixes the silent-drop bug where --path alone produced stdout.
	outs := append([]string(nil), opts.Out...)
	if opts.FilePath != "" && opts.Output != "file" {
		outs = append(outs, opts.FilePath)
	}
	outs = splitAndTrim(outs)

	// Format inference from a single file path.
	fmtType := sinks.Format(opts.Format)
	if !opts.FormatExplicit && len(outs) == 1 && outs[0] != "-" {
		if inferred := inferFormatFromPath(outs[0]); inferred != "" {
			fmtType = sinks.Format(inferred)
			if !opts.Quiet {
				fmt.Fprintf(stderr, "logsim: inferred --format=%s from %s\n", inferred, outs[0])
			}
		}
	}

	dotPath := config.DefaultPath()
	if opts.ConfigPath != "" {
		dotPath = opts.ConfigPath
	}
	dotCfg, _, err := loadDotOrConfig(opts.ConfigPath)
	if err != nil {
		return nil, err
	}

	var (
		picked []sinks.Sink
		closer []sinks.Sink
	)
	addAndTrack := func(s sinks.Sink) {
		picked = append(picked, s)
		closer = append(closer, s)
	}

	// (1) Legacy --output handling.
	switch opts.Output {
	case "stdout":
		picked = append(picked, sinks.NewStdout(fmtType))
	case "file":
		fs, err := openFileSink(opts.FilePath, fmtType, opts.AppendMode)
		if err != nil {
			return nil, err
		}
		addAndTrack(fs)
	case "destination":
		if opts.Destination == "" {
			closeSinks(closer)
			return nil, errors.New("--destination is required when --output=destination")
		}
		s, err := sinkForName(dotCfg, opts.Destination, dotPath)
		if err != nil {
			closeSinks(closer)
			return nil, err
		}
		addAndTrack(s)
	case "":
		// Modern path: combine --out + --to.
		for _, target := range outs {
			if target == "-" {
				picked = append(picked, sinks.NewStdout(fmtType))
				continue
			}
			fs, err := openFileSink(target, fmtType, opts.AppendMode)
			if err != nil {
				closeSinks(closer)
				return nil, err
			}
			addAndTrack(fs)
		}

		switch {
		case opts.To != "":
			names := splitNames(opts.To, dotCfg)
			if len(names) == 0 {
				closeSinks(closer)
				return nil, errors.New("--to resolved to zero destinations")
			}
			for _, n := range names {
				s, err := sinkForName(dotCfg, n, dotPath)
				if err != nil {
					closeSinks(closer)
					return nil, err
				}
				addAndTrack(s)
			}
		case opts.Destination != "":
			s, err := sinkForName(dotCfg, opts.Destination, dotPath)
			if err != nil {
				closeSinks(closer)
				return nil, err
			}
			addAndTrack(s)
		case len(picked) == 0:
			// No output flags. Default is stdout — destinations are opt-in
			// via --to and never auto-selected.
			picked = append(picked, sinks.NewStdout(fmtType))
		}
	default:
		closeSinks(closer)
		return nil, fmt.Errorf("unknown --output %q (expected stdout, file, or destination)", opts.Output)
	}

	// (5) --tee always layers in a file sink.
	if opts.Tee != "" {
		fs, err := openFileSink(opts.Tee, fmtType, opts.AppendMode)
		if err != nil {
			closeSinks(closer)
			return nil, err
		}
		addAndTrack(fs)
		if !opts.Quiet {
			fmt.Fprintf(stderr, "logsim: tee → %s\n", opts.Tee)
		}
	}

	if len(picked) == 0 {
		picked = append(picked, sinks.NewStdout(fmtType))
	}
	_ = closer
	return picked, nil
}

// inferFormatFromPath returns "ocsf"/"otel" when the path's stem ends in
// ".ocsf" or ".otel" (e.g. logs.ocsf.json), else "".
func inferFormatFromPath(p string) string {
	base := strings.ToLower(filepath.Base(p))
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	switch {
	case strings.HasSuffix(stem, ".ocsf"):
		return string(encoders.FormatOCSF)
	case strings.HasSuffix(stem, ".otel"):
		return string(encoders.FormatOTEL)
	}
	return ""
}

// splitAndTrim flattens comma-separated values inside any individual entry and
// drops empties so callers can pass a mixed bag of `-o a,b -o c` and `-o a -o b`.
func splitAndTrim(in []string) []string {
	var out []string
	for _, raw := range in {
		for _, p := range strings.Split(raw, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

func openFileSink(path string, format sinks.Format, appendMode bool) (sinks.Sink, error) {
	if path == "" {
		return nil, errors.New("file path is required")
	}
	return sinks.NewFile(path, format, appendMode)
}

func loadDotOrConfig(explicit string) (*config.DestinationsConfig, bool, error) {
	if explicit != "" {
		cfg, err := config.ParseFile(explicit)
		if err != nil {
			return nil, false, fmt.Errorf("destinations config: %w", err)
		}
		return cfg, true, nil
	}
	cfg, _, ok, err := config.LoadDefault()
	return cfg, ok, err
}

func sinkForName(cfg *config.DestinationsConfig, name, sourcePath string) (sinks.Sink, error) {
	d := cfg.Get(name)
	if d == nil {
		return nil, fmt.Errorf("destination %q not found in %s — try `logsim destinations list`", name, sourcePath)
	}
	if !d.Enabled {
		return nil, fmt.Errorf("destination %q is disabled (run `logsim destinations enable %s`)", name, name)
	}
	return sinkBuild(d)
}

func sinkBuild(d *config.Destination) (sinks.Sink, error) {
	s, err := sinks.ForDestination(d)
	if err != nil {
		return nil, fmt.Errorf("build sink for %q: %w", d.Name, err)
	}
	return s, nil
}

func splitNames(spec string, cfg *config.DestinationsConfig) []string {
	if strings.EqualFold(strings.TrimSpace(spec), "all") {
		var out []string
		for _, d := range cfg.EnabledDestinations() {
			out = append(out, d.Name)
		}
		sort.Strings(out)
		return out
	}
	var out []string
	for _, n := range strings.Split(spec, ",") {
		n = strings.TrimSpace(n)
		if n != "" {
			out = append(out, n)
		}
	}
	return out
}

func closeSinks(list []sinks.Sink) {
	for _, s := range list {
		_ = s.Close()
	}
}

// resolveTicks decides how many ticks the engine should run.
//
//	explicit --ticks  → honour it verbatim (lets you sample a long scenario)
//	scenario.duration → run the entire episode end-to-end
//	otherwise         → 100, the legacy default
//
// "Run the whole scenario" is the default users expect from
// `logsim run cache-failure-cascade` — anything less truncates the story.
func resolveTicks(flag int, flagSet bool, scenarioDuration int) int {
	if flagSet && flag > 0 {
		return flag
	}
	if scenarioDuration > 0 {
		return scenarioDuration
	}
	if flag > 0 { // user passed a non-zero value via --ticks=N (legacy form)
		return flag
	}
	return 100
}

// resolveTickIntervalMs picks the simulated-time-per-tick value, mirroring
// resolveTicks: explicit flag wins, then scenario.tick_interval_ms, then 1s.
func resolveTickIntervalMs(flagVal string, flagSet bool, scenarioMs int) (int, error) {
	if flagSet && strings.TrimSpace(flagVal) != "" {
		d, err := time.ParseDuration(flagVal)
		if err != nil {
			return 0, fmt.Errorf("--tick-interval: %w", err)
		}
		return int(d.Milliseconds()), nil
	}
	if scenarioMs > 0 {
		return scenarioMs, nil
	}
	if strings.TrimSpace(flagVal) != "" {
		d, err := time.ParseDuration(flagVal)
		if err != nil {
			return 0, fmt.Errorf("--tick-interval: %w", err)
		}
		return int(d.Milliseconds()), nil
	}
	return 1000, nil
}

// forwardingReporter prints HEC progress for every CriblSink in the list:
// one "POST → <status>" trace per HTTP attempt, plus a closing per-sink
// summary. Quiet mode silences the per-attempt chatter but keeps the
// summary so scripts can grep the final tally.
type forwardingReporter struct {
	sinks  []*sinks.CriblSink
	stderr io.Writer
	quiet  bool
}

func attachForwardingReporter(sinkList []sinks.Sink, stderr io.Writer, quiet bool) *forwardingReporter {
	r := &forwardingReporter{stderr: stderr, quiet: quiet}
	for _, s := range sinkList {
		c, ok := s.(*sinks.CriblSink)
		if !ok {
			continue
		}
		r.sinks = append(r.sinks, c)
		if !quiet {
			fmt.Fprintf(stderr, "logsim: forwarding → %s\n", labelOrURL(c))
		}
		c.SetObserver(r.onAttempt)
	}
	return r
}

func (r *forwardingReporter) onAttempt(res sinks.SendResult) {
	if r.quiet {
		return
	}
	fmt.Fprintln(r.stderr, formatAttempt(res))
}

// Summarize prints a closing tally per sink. Always emitted — quiet mode
// only silences the per-attempt chatter.
func (r *forwardingReporter) Summarize(w io.Writer) {
	for _, c := range r.sinks {
		events, batches, failed := c.EventsSent(), c.BatchesSent(), c.BatchesFailed()
		if failed > 0 {
			fmt.Fprintf(w, "logsim: sent %d events to %s in %d batches (%d batch(es) failed — see above)\n",
				events, labelOrURL(c), batches, failed)
			continue
		}
		fmt.Fprintf(w, "logsim: sent %d events to %s in %d batches\n", events, labelOrURL(c), batches)
	}
}

func labelOrURL(c *sinks.CriblSink) string {
	if n := c.Name(); n != "" {
		return n
	}
	return c.URL()
}

// formatAttempt renders one HTTP attempt as a single stderr line. The shape
// is part of the CLI contract.
func formatAttempt(r sinks.SendResult) string {
	took := r.Duration.Round(time.Millisecond)
	head := fmt.Sprintf("%d %s", r.StatusCode, http.StatusText(r.StatusCode))
	if r.StatusCode == 0 {
		head = fmt.Sprintf("ERR %v", r.Err)
	}
	return fmt.Sprintf("logsim:   POST → %s (%d events, %s)%s",
		head, r.BatchSize, took, attemptSuffix(r))
}

func attemptSuffix(r sinks.SendResult) string {
	if r.Err == nil {
		return ""
	}
	if !r.Final {
		return " — retrying"
	}
	if r.StatusCode >= 400 && r.StatusCode < 500 {
		return " — dropped"
	}
	return " — gave up"
}

// promptThreshold is the log-count above which `logsim run` asks for
// confirmation. Tuned so a typical short scenario (web-service, ~150 ticks)
// runs unprompted while long catalog episodes (cache-failure-cascade, etc.)
// surface a heads-up.
const promptThreshold = 5000

// estimateLogCount samples one tick of the scenario into a counter sink and
// extrapolates to totalTicks. A new engine is spun up so the real run starts
// with fresh RNG state.
func estimateLogCount(s *scenario.Scenario, cfg engine.Config, totalTicks int) int {
	if totalTicks <= 0 {
		return 0
	}
	sample := engine.New(s, cfg)
	c := &countingSink{}
	if err := sample.Run(context.Background(), 1, []sinks.Sink{c}); err != nil {
		return 0
	}
	return c.count * totalTicks
}

type countingSink struct{ count int }

func (c *countingSink) Write(entries []event.LogEntry) error { c.count += len(entries); return nil }
func (c *countingSink) Flush() error                          { return nil }
func (c *countingSink) Close() error                          { return nil }

// shouldPrompt is false in quiet mode and when stdin isn't a terminal —
// pipelines and scripts should never block on a prompt. Callers must also
// respect --force.
func shouldPrompt(stdin io.Reader, quiet bool) bool {
	if quiet {
		return false
	}
	f, ok := stdin.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}

// confirmYesNo writes the prompt and reads one line; returns true only on
// "y"/"yes" (case-insensitive).
func confirmYesNo(stdin io.Reader, stderr io.Writer, prompt string) bool {
	fmt.Fprint(stderr, prompt)
	var line string
	if _, err := fmt.Fscanln(stdin, &line); err != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}
