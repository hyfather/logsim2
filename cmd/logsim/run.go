package main

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"time"

	"github.com/nikhilm/logsim2/pkg/config"
	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
	"github.com/spf13/cobra"
)

func newRunCmd() *cobra.Command {
	var (
		scenarioPath  string
		ticks         int
		tickInterval  string
		rate          float64
		output        string
		filePath      string
		appendMode    bool
		destination   string
		configPath    string
		sourceFilter string
		seed          int64
		format        string
	)

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run a simulation and emit logs",
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
				SourceFilter:  sourceFilter,
			}

			eng := engine.New(s, cfg)

			var sink sinks.Sink
			switch output {
			case "stdout":
				sink = sinks.NewStdout(sinks.Format(format))
			case "file":
				if filePath == "" {
					return fmt.Errorf("--path is required when --output=file")
				}
				fs, err := sinks.NewFile(filePath, sinks.Format(format), appendMode)
				if err != nil {
					return err
				}
				defer fs.Close()
				sink = fs
			case "destination":
				if destination == "" {
					return fmt.Errorf("--destination is required when --output=destination")
				}
				if configPath == "" {
					return fmt.Errorf("--config is required when --output=destination")
				}
				dcfg, err := config.ParseFile(configPath)
				if err != nil {
					return fmt.Errorf("destinations config: %w", err)
				}
				d := dcfg.Get(destination)
				if d == nil {
					return fmt.Errorf("destination %q not found in %s", destination, configPath)
				}
				if !d.Enabled {
					return fmt.Errorf("destination %q is disabled", destination)
				}
				ds, err := sinks.ForDestination(d)
				if err != nil {
					return fmt.Errorf("build sink: %w", err)
				}
				defer ds.Close()
				sink = ds
			default:
				return fmt.Errorf("unknown --output %q", output)
			}
			_ = destination
			_ = configPath

			fmt.Fprintf(os.Stderr, "logsim: running %d ticks for %q (seed=%d)\n", ticks, s.Name, seed)
			return eng.Run(context.Background(), ticks, []sinks.Sink{sink})
		},
	}

	cmd.Flags().StringVar(&scenarioPath, "scenario", "", "path to scenario YAML (required)")
	_ = cmd.MarkFlagRequired("scenario")
	cmd.Flags().IntVar(&ticks, "ticks", 100, "number of ticks to emit")
	cmd.Flags().StringVar(&tickInterval, "tick-interval", "1s", "simulated time per tick")
	cmd.Flags().Float64Var(&rate, "rate", 0, "wall-clock pacing multiplier (0 = instant)")
	cmd.Flags().StringVar(&output, "output", "stdout", "output kind: stdout | file | destination")
	cmd.Flags().StringVar(&filePath, "path", "", "output file path (when --output=file)")
	cmd.Flags().BoolVar(&appendMode, "append", false, "append to file instead of truncating (when --output=file)")
	cmd.Flags().StringVar(&destination, "destination", "", "destination name (when --output=destination)")
	cmd.Flags().StringVar(&configPath, "config", "", "destinations YAML (when --output=destination)")
	cmd.Flags().StringVar(&sourceFilter, "source-filter", "*", "source path glob filter")
	cmd.Flags().Int64Var(&seed, "seed", 0, "RNG seed (0 = random)")
	cmd.Flags().StringVar(&format, "format", "jsonl", "line format: jsonl | raw")

	return cmd
}
