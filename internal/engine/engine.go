package engine

import (
	"context"
	"math/rand"
	"sort"
	"time"

	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/generators"
	"github.com/nikhilm/logsim2/internal/scenario"
	"github.com/nikhilm/logsim2/internal/sinks"
)

// Config controls how the engine runs.
type Config struct {
	Seed           int64
	StartTime      time.Time
	TickIntervalMs int     // simulated milliseconds per tick (default 1000)
	Rate           float64 // wall-clock pacing: 0 = instant, 1.0 = real-time
	SourceFilter   string  // glob on the source path; "" or "*" means all
}

// Engine orchestrates the tick loop for a scenario.
type Engine struct {
	scenario *scenario.Scenario
	cfg      Config
	traffic  *trafficSimulator
	channels SourceMap
	rng      *rand.Rand

	// Pre-built list of (target, generator) pairs — computed once at construction.
	targets []generatorEntry
}

type generatorEntry struct {
	target    generators.Target
	generator generators.Generator
}

// New creates an Engine ready to run.
func New(s *scenario.Scenario, cfg Config) *Engine {
	if cfg.TickIntervalMs == 0 {
		cfg.TickIntervalMs = 1000
	}
	if cfg.StartTime.IsZero() {
		cfg.StartTime = time.Now()
	}
	if cfg.SourceFilter == "" {
		cfg.SourceFilter = "*"
	}

	e := &Engine{
		scenario: s,
		cfg:      cfg,
		traffic:  newTrafficSimulator(s),
		channels: BuildSources(s),
		rng:      rand.New(rand.NewSource(cfg.Seed)),
	}
	e.buildTargets()
	return e
}

func (e *Engine) buildTargets() {
	// Services first (most generators live here).
	for i := range e.scenario.Services {
		svc := &e.scenario.Services[i]
		gen := generators.ForService(svc.Type)
		if gen == nil {
			continue
		}
		e.targets = append(e.targets, generatorEntry{
			target: generators.Target{
				Service: svc,
				Source: e.channels[svc.Name],
			},
			generator: gen,
		})
	}
	// Node-level generators (VPC flow logs, load balancers).
	for i := range e.scenario.Nodes {
		n := &e.scenario.Nodes[i]
		gen := generators.ForNode(n)
		if gen == nil {
			continue
		}
		// VPC flow logs use a dedicated channel key: "<VpcName>/flow"
		channel := e.channels[n.Name]
		if n.Type == scenario.NodeTypeVPC {
			channel = e.channels[n.Name+"/flow"]
		}
		e.targets = append(e.targets, generatorEntry{
			target: generators.Target{
				Node:    n,
				Source: channel,
			},
			generator: gen,
		})
	}
}

// Run advances the simulation for totalTicks ticks, writing all log entries
// to every sink. Respects ctx cancellation.
func (e *Engine) Run(ctx context.Context, totalTicks int, sinkList []sinks.Sink) error {
	tickInterval := time.Duration(e.cfg.TickIntervalMs) * time.Millisecond
	var sleepDur time.Duration
	if e.cfg.Rate > 0 {
		sleepDur = time.Duration(float64(tickInterval) / e.cfg.Rate)
	}

	for tick := 0; tick < totalTicks; tick++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		ts := e.cfg.StartTime.Add(time.Duration(tick) * tickInterval)
		flows := e.traffic.Flows(e.scenario, tick, e.cfg.TickIntervalMs, e.rng, ts)
		tickCtx := event.TickContext{
			TickIndex:      tick,
			Timestamp:      ts,
			TickIntervalMs: e.cfg.TickIntervalMs,
			Rng:            e.rng,
			AllFlows:       flows,
		}
		entries := e.generateTick(flows, tickCtx)

		for _, s := range sinkList {
			if err := s.Write(entries); err != nil {
				return err
			}
		}

		if sleepDur > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(sleepDur):
			}
		}
	}

	for _, s := range sinkList {
		if err := s.Flush(); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) generateTick(flows []event.Flow, ctx event.TickContext) []event.LogEntry {
	// Index flows by target name for O(1) lookup.
	flowsByTarget := make(map[string][]event.Flow, len(flows))
	for _, f := range flows {
		flowsByTarget[f.TargetName] = append(flowsByTarget[f.TargetName], f)
	}

	var all []event.LogEntry
	for _, entry := range e.targets {
		inbound := flowsByTarget[entry.target.Name()]
		logs := entry.generator.Generate(entry.target, inbound, ctx)

		// Apply channel filter.
		for _, l := range logs {
			if matchesSourceFilter(l.Source, e.cfg.SourceFilter) {
				all = append(all, l)
			}
		}
	}

	// Sort by timestamp so output is chronological within a tick.
	sort.Slice(all, func(i, j int) bool {
		return all[i].TS < all[j].TS
	})
	return all
}

// matchesSourceFilter returns true if the source path matches the glob pattern.
// Only * wildcards are supported for now (no ? or character classes).
func matchesSourceFilter(source, pattern string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	return globMatch(pattern, source)
}

// globMatch supports * as multi-segment wildcard and nothing else.
func globMatch(pattern, s string) bool {
	// Split on * and match each segment in order.
	if pattern == "*" {
		return true
	}
	parts := splitGlob(pattern)
	idx := 0
	for i, part := range parts {
		if part == "" {
			continue
		}
		pos := indexOf(s[idx:], part)
		if pos == -1 {
			return false
		}
		// First segment must match from the start if pattern doesn't start with *.
		if i == 0 && pattern[0] != '*' && pos != 0 {
			return false
		}
		idx += pos + len(part)
	}
	// If pattern doesn't end with *, the last segment must consume everything.
	if len(pattern) > 0 && pattern[len(pattern)-1] != '*' {
		last := parts[len(parts)-1]
		return last != "" && len(s)-len(last) >= 0 && s[len(s)-len(last):] == last
	}
	return true
}

func splitGlob(pattern string) []string {
	var parts []string
	start := 0
	for i, c := range pattern {
		if c == '*' {
			parts = append(parts, pattern[start:i])
			start = i + 1
		}
	}
	parts = append(parts, pattern[start:])
	return parts
}

func indexOf(s, sub string) int {
	if sub == "" {
		return 0
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
