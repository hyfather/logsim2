package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/nikhilm/logsim2/pkg/config"
	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

func newRunCmd() *cobra.Command {
	var (
		scenarioPath string
		ticks        int
		tickInterval string
		rate         float64

		// Output selection. Two ergonomic flags layered on top of the
		// explicit --output: --to <name>[,<name>] picks dotfile destinations,
		// --tee <path> additionally writes JSONL to a file.
		output      string
		filePath    string
		appendMode  bool
		destination string // legacy single-name; --to is the modern form
		to          string
		tee         string

		configPath   string
		sourceFilter string
		seed         int64
		format       string
		quiet        bool
	)

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run a simulation and emit logs",
		Long: "Run executes a scenario and writes the resulting log entries to one\n" +
			"or more sinks. With no flags, output goes to stdout — unless exactly\n" +
			"one enabled destination exists in the dotfile, in which case it is\n" +
			"used. Use --to to pick destinations explicitly, --tee to also write\n" +
			"a copy to a file, or --output for the explicit stdout/file/destination form.",
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := scenario.ValidateFile(scenarioPath)
			if err != nil {
				return fmt.Errorf("scenario: %w", err)
			}

			interval, err := time.ParseDuration(tickInterval)
			if err != nil {
				return fmt.Errorf("--tick-interval: %w", err)
			}

			if seed == 0 {
				seed = rand.New(rand.NewSource(time.Now().UnixNano())).Int63()
			}

			cfg := engine.Config{
				Seed:           seed,
				StartTime:      time.Now(),
				TickIntervalMs: int(interval.Milliseconds()),
				Rate:           rate,
				SourceFilter:   sourceFilter,
			}
			eng := engine.New(s, cfg)

			sinkList, err := buildSinks(buildSinksOpts{
				Output:      output,
				Format:      format,
				FilePath:    filePath,
				AppendMode:  appendMode,
				Destination: destination,
				To:          to,
				Tee:         tee,
				ConfigPath:  configPath,
				Quiet:       quiet,
				Stderr:      cmd.ErrOrStderr(),
				Stdin:       cmd.InOrStdin(),
			})
			if err != nil {
				return err
			}
			defer closeSinks(sinkList)

			if !quiet {
				fmt.Fprintf(os.Stderr, "logsim: running %d ticks for %q (seed=%d)\n", ticks, s.Name, seed)
			}
			return eng.Run(context.Background(), ticks, sinkList)
		},
	}

	cmd.Flags().StringVar(&scenarioPath, "scenario", "", "path to scenario YAML (required)")
	_ = cmd.MarkFlagRequired("scenario")
	cmd.Flags().IntVar(&ticks, "ticks", 100, "number of ticks to emit")
	cmd.Flags().StringVar(&tickInterval, "tick-interval", "1s", "simulated time per tick")
	cmd.Flags().Float64Var(&rate, "rate", 0, "wall-clock pacing multiplier (0 = instant)")

	cmd.Flags().StringVar(&output, "output", "", "explicit output kind: stdout | file | destination (auto-detected when omitted)")
	cmd.Flags().StringVar(&filePath, "path", "", "output file path (when --output=file)")
	cmd.Flags().BoolVar(&appendMode, "append", false, "append to file instead of truncating (when writing to a file)")
	cmd.Flags().StringVar(&destination, "destination", "", "destination name (when --output=destination); prefer --to")
	cmd.Flags().StringVar(&to, "to", "", "comma-separated list of destination names from the dotfile (or `all` for every enabled one)")
	cmd.Flags().StringVar(&tee, "tee", "", "additionally write a copy of every log line to this file (JSONL by default; respects --format)")
	cmd.Flags().StringVar(&configPath, "config", "", "destinations YAML (overrides the dotfile)")

	cmd.Flags().StringVar(&sourceFilter, "source-filter", "*", "source path glob filter")
	cmd.Flags().Int64Var(&seed, "seed", 0, "RNG seed (0 = random)")
	cmd.Flags().StringVar(&format, "format", "jsonl", "line format: jsonl | raw | ocsf | otel | udm | asim")
	cmd.Flags().BoolVar(&quiet, "quiet", false, "suppress informational log lines on stderr")

	return cmd
}

type buildSinksOpts struct {
	Output      string
	Format      string
	FilePath    string
	AppendMode  bool
	Destination string
	To          string
	Tee         string
	ConfigPath  string
	Quiet       bool
	Stderr      io.Writer
	Stdin       io.Reader
}

// buildSinks resolves CLI flags into a concrete sink list. The decision tree
// (in priority order):
//
//  1. --output is set → strict legacy behavior (stdout|file|destination).
//  2. --to is set → fan out to those dotfile destinations.
//  3. --destination + --config or --destination alone (with dotfile) →
//     single dotfile destination.
//  4. Dotfile exists with exactly one enabled destination → use it.
//  5. Dotfile is missing entirely and we're on a TTY → onboard, then re-resolve.
//  6. Otherwise → stdout.
//
// --tee is orthogonal; it always appends a file sink to whatever else was picked.
func buildSinks(opts buildSinksOpts) ([]sinks.Sink, error) {
	fmtType := sinks.Format(opts.Format)
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	var (
		picked []sinks.Sink
		closer []sinks.Sink // tracked for cleanup on later error
	)
	addAndTrack := func(s sinks.Sink) {
		picked = append(picked, s)
		closer = append(closer, s)
	}

	// Resolve the destinations config once (dotfile or explicit --config).
	dotPath := config.DefaultPath()
	if opts.ConfigPath != "" {
		dotPath = opts.ConfigPath
	}
	dotCfg, dotExists, err := loadDotOrConfig(opts.ConfigPath)
	if err != nil {
		return nil, err
	}

	switch {
	case opts.Output == "stdout":
		picked = append(picked, sinks.NewStdout(fmtType))
	case opts.Output == "file":
		fs, err := openFileSink(opts.FilePath, fmtType, opts.AppendMode)
		if err != nil {
			return nil, err
		}
		addAndTrack(fs)
	case opts.Output == "destination":
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
	case opts.Output != "":
		closeSinks(closer)
		return nil, fmt.Errorf("unknown --output %q", opts.Output)

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
		// Backwards-compatible: --destination alone uses dotfile.
		s, err := sinkForName(dotCfg, opts.Destination, dotPath)
		if err != nil {
			closeSinks(closer)
			return nil, err
		}
		addAndTrack(s)

	default:
		// Auto-detect from dotfile.
		if !dotExists {
			if maybeOnboard(stderr, opts.Stdin, dotPath) {
				// Re-load after onboarding completes.
				dotCfg, dotExists, err = loadDotOrConfig("")
				if err != nil {
					return nil, err
				}
			}
		}
		enabled := dotCfg.EnabledDestinations()
		switch {
		case len(enabled) == 1:
			s, err := sinkBuild(&enabled[0])
			if err != nil {
				return nil, err
			}
			addAndTrack(s)
			if !opts.Quiet {
				fmt.Fprintf(stderr, "logsim: forwarding to %q from %s (--to to override)\n", enabled[0].Name, dotPath)
			}
		case len(enabled) > 1:
			if !opts.Quiet {
				names := destNames(enabled)
				fmt.Fprintf(stderr, "logsim: %d enabled destinations in %s (%s); use --to to pick — defaulting to stdout\n",
					len(enabled), dotPath, strings.Join(names, ","))
			}
			picked = append(picked, sinks.NewStdout(fmtType))
		default:
			picked = append(picked, sinks.NewStdout(fmtType))
		}
	}

	// --tee always layers in a file sink.
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
		// Should be unreachable, but guard anyway.
		picked = append(picked, sinks.NewStdout(fmtType))
	}
	_ = closer
	return picked, nil
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
		return nil, fmt.Errorf("destination %q not found in %s", name, sourcePath)
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

func destNames(ds []config.Destination) []string {
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.Name)
	}
	return out
}

func closeSinks(list []sinks.Sink) {
	for _, s := range list {
		_ = s.Close()
	}
}

// maybeOnboard runs an interactive prompt offering to add a first destination.
// Returns true iff a destination was added (caller should reload). Falls
// through silently when stdin/stderr aren't a TTY so scripted use of `logsim
// run` is never blocked by a prompt.
func maybeOnboard(stderr io.Writer, stdin io.Reader, dotPath string) bool {
	if !isInteractive(stdin, stderr) {
		return false
	}

	var add bool
	confirm := huh.NewConfirm().
		Title("No destinations configured.").
		Description(fmt.Sprintf("Add one now? (writes to %s)", dotPath)).
		Affirmative("Yes, add one").
		Negative("No, just stdout").
		Value(&add)
	if err := huh.NewForm(huh.NewGroup(confirm)).Run(); err != nil {
		fmt.Fprintf(stderr, "logsim: onboarding skipped: %v\n", err)
		return false
	}
	if !add {
		return false
	}

	cfg, _, _, _ := config.LoadDefault()
	d, err := promptDestination(cfg)
	if err != nil {
		fmt.Fprintf(stderr, "logsim: onboarding aborted: %v\n", err)
		return false
	}
	cfg.Upsert(d)
	if err := cfg.Save(dotPath); err != nil {
		fmt.Fprintf(stderr, "logsim: failed to save destination: %v\n", err)
		return false
	}
	fmt.Fprintf(stderr, "logsim: saved destination %q to %s\n", d.Name, dotPath)
	return true
}

func isInteractive(stdin io.Reader, stderr io.Writer) bool {
	in, ok := stdin.(*os.File)
	if !ok {
		return false
	}
	out, ok := stderr.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(in.Fd())) && term.IsTerminal(int(out.Fd()))
}
