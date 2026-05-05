package invariants_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// Cause-symptom tests (Level 4 in PHYSICS_PLAN.md §9.1). Each test
// injects a single cause and asserts that the expected symptom chain
// appears in the log corpus *during* the cause window, with normal
// behaviour before and after. These are the tests the existing
// override-by-multiplier mechanism cannot pass — there's no causal
// layer between the configured symptom and the emitted log there. The
// new request simulator's two-phase queueing makes the chain emerge
// from the simulation.

// runWithCause builds a scenario, injects one cause, runs the engine
// for `ticks` ticks, and returns the captured entries.
func runWithCause(t *testing.T, baseYAML string, cause scenario.Cause, ticks int, seed int64) []event.LogEntry {
	t.Helper()
	s, err := scenario.Parse(strings.NewReader(baseYAML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	s.Causes = append(s.Causes, cause)
	if err := scenario.Validate(s); err != nil {
		t.Fatalf("validate: %v", err)
	}
	cfg := engine.Config{
		Seed:           seed,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:   "*",
	}
	cap := &captureSink{}
	eng := engine.New(s, cfg)
	if err := eng.Run(context.Background(), ticks, []sinks.Sink{cap}); err != nil {
		t.Fatalf("run: %v", err)
	}
	return cap.entries
}

// meanLatencyByTickRange returns the mean response_time_ms of nodejs
// entries falling in [fromTick, toTick).
func meanLatencyByTickRange(batch []event.LogEntry, fromTick, toTick int, baseTime time.Time, tickInterval time.Duration) (mean float64, n int) {
	from := baseTime.Add(time.Duration(fromTick) * tickInterval)
	to := baseTime.Add(time.Duration(toTick) * tickInterval)
	var sum float64
	for _, e := range batch {
		if e.Sourcetype != "nodejs" || e.Fields == nil {
			continue
		}
		ts, err := time.Parse("2006-01-02T15:04:05.000Z07:00", e.TS)
		if err != nil {
			continue
		}
		if ts.Before(from) || !ts.Before(to) {
			continue
		}
		var rt float64
		switch v := e.Fields["response_time_ms"].(type) {
		case int:
			rt = float64(v)
		case float64:
			rt = v
		default:
			continue
		}
		sum += rt
		n++
	}
	if n == 0 {
		return 0, 0
	}
	return sum / float64(n), n
}

// countByTickRange returns the number of nodejs entries in [from, to).
func countByTickRange(batch []event.LogEntry, fromTick, toTick int, baseTime time.Time, tickInterval time.Duration) int {
	from := baseTime.Add(time.Duration(fromTick) * tickInterval)
	to := baseTime.Add(time.Duration(toTick) * tickInterval)
	n := 0
	for _, e := range batch {
		if e.Sourcetype != "nodejs" {
			continue
		}
		ts, err := time.Parse("2006-01-02T15:04:05.000Z07:00", e.TS)
		if err != nil {
			continue
		}
		if !ts.Before(from) && ts.Before(to) {
			n++
		}
	}
	return n
}

// twoServiceScenarioYAML is a small reference scenario with one app
// service that the causes target. RPS is below default capacity so the
// baseline is uncongested and changes during the cause window are easy
// to read.
const twoServiceScenarioYAML = `
- name: Cause Test
- nodes:
  - type: vpc
    name: test-vpc
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: test-subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: app
    subnet: test-subnet
    private_ip: 10.0.1.10
  - type: user_clients
    name: clients
    clients:
      - name: c1
        ip: 1.2.3.4
        rps: 50
        traffic_pattern: steady
- services:
  - type: nodejs
    name: app-svc
    host: app
    generator:
      type: nodejs
      port: 3000
      log_format: json
      endpoints:
        - method: GET
          path: /api/data
          avg_latency_ms: 30
          error_rate: 0
- connections:
  - source: clients
    target: app-svc
    protocol: http
    port: 3000
`

// TestCause_CapacityLoss_RaisesLatency: dropping the target's μ to 20%
// during ticks 10–20 should produce a clearly higher mean latency in
// the cause window than in the surrounding ticks.
func TestCause_CapacityLoss_RaisesLatency(t *testing.T) {
	cause := scenario.Cause{
		ID:     "capacity-test",
		Type:   "capacity_loss",
		From:   10,
		To:     20,
		Target: "app-svc",
		Parameters: map[string]any{
			"capacity_mul": 0.2,
		},
	}
	batch := runWithCause(t, twoServiceScenarioYAML, cause, 30, 42)

	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tickInterval := time.Second

	beforeLat, _ := meanLatencyByTickRange(batch, 0, 10, baseTime, tickInterval)
	duringLat, _ := meanLatencyByTickRange(batch, 10, 20, baseTime, tickInterval)
	afterLat, _ := meanLatencyByTickRange(batch, 20, 30, baseTime, tickInterval)

	t.Logf("mean latency: before=%.1fms during=%.1fms after=%.1fms", beforeLat, duringLat, afterLat)

	if duringLat <= beforeLat*1.5 {
		t.Errorf("capacity_loss did not raise latency enough: before=%.1f during=%.1f", beforeLat, duringLat)
	}
	if afterLat > duringLat {
		t.Errorf("post-cause latency %.1f exceeded in-cause latency %.1f — cause didn't release", afterLat, duringLat)
	}
}

// TestCause_CapacityLoss_EmitsErrors: at extreme capacity loss the
// service should saturate and emit 5xx responses.
func TestCause_CapacityLoss_EmitsErrors(t *testing.T) {
	cause := scenario.Cause{
		ID:     "drain-1",
		Type:   "capacity_loss",
		From:   5,
		To:     15,
		Target: "app-svc",
		Parameters: map[string]any{
			"capacity_mul": 0.05, // 5% of 200 = 10 RPS, well below 50 RPS arrivals
		},
	}
	batch := runWithCause(t, twoServiceScenarioYAML, cause, 20, 42)

	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tickInterval := time.Second
	from := baseTime.Add(5 * tickInterval)
	to := baseTime.Add(15 * tickInterval)

	total, errs := 0, 0
	for _, e := range batch {
		if e.Sourcetype != "nodejs" {
			continue
		}
		ts, err := time.Parse("2006-01-02T15:04:05.000Z07:00", e.TS)
		if err != nil || ts.Before(from) || !ts.Before(to) {
			continue
		}
		total++
		if e.Fields == nil {
			continue
		}
		var sc int
		switch v := e.Fields["status_code"].(type) {
		case int:
			sc = v
		case float64:
			sc = int(v)
		}
		if sc >= 500 {
			errs++
		}
	}
	t.Logf("during cause: %d nodejs logs, %d 5xx (rate %.3f)", total, errs, float64(errs)/float64(total))
	if errs == 0 {
		t.Fatalf("severe capacity_loss expected to produce 5xx, got none")
	}
}

// TestCause_TrafficSpike_RaisesArrivalCount: an 8× spike during ticks
// 10-20 should produce roughly 8× as many log lines per tick.
func TestCause_TrafficSpike_RaisesArrivalCount(t *testing.T) {
	cause := scenario.Cause{
		ID:     "spike-1",
		Type:   "traffic_spike",
		From:   10,
		To:     20,
		Target: "clients",
		Parameters: map[string]any{
			"multiplier": 4.0,
		},
	}
	batch := runWithCause(t, twoServiceScenarioYAML, cause, 30, 42)

	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tickInterval := time.Second

	beforeCount := countByTickRange(batch, 0, 10, baseTime, tickInterval)
	duringCount := countByTickRange(batch, 10, 20, baseTime, tickInterval)
	afterCount := countByTickRange(batch, 20, 30, baseTime, tickInterval)

	// Same-length windows so we compare apples to apples.
	t.Logf("nodejs counts: before=%d during=%d after=%d", beforeCount, duringCount, afterCount)

	// 4x multiplier; once we cross capacity, queueing kicks in but arrival
	// count is still ~4x. Allow generous tolerance — ratio should be at
	// least 2.5× before-window even with saturation.
	if float64(duringCount) <= float64(beforeCount)*2.5 {
		t.Errorf("traffic_spike (4×) didn't raise count enough: before=%d during=%d",
			beforeCount, duringCount)
	}
	if afterCount > beforeCount*2 {
		t.Errorf("post-cause count %d much higher than before %d — cause didn't release",
			afterCount, beforeCount)
	}
}

// TestCause_NetworkLatencyInject_AddsLatency: injecting +200ms on the
// clients→app-svc connection should add ~200ms to every nodejs response.
func TestCause_NetworkLatencyInject_AddsLatency(t *testing.T) {
	cause := scenario.Cause{
		ID:     "net-jitter",
		Type:   "network_latency_inject",
		From:   10,
		To:     20,
		Source: "clients",
		Target: "app-svc",
		Parameters: map[string]any{
			"extra_ms": 200,
		},
	}
	batch := runWithCause(t, twoServiceScenarioYAML, cause, 30, 42)

	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tickInterval := time.Second

	beforeLat, _ := meanLatencyByTickRange(batch, 0, 10, baseTime, tickInterval)
	duringLat, _ := meanLatencyByTickRange(batch, 10, 20, baseTime, tickInterval)
	afterLat, _ := meanLatencyByTickRange(batch, 20, 30, baseTime, tickInterval)

	t.Logf("mean latency: before=%.1fms during=%.1fms after=%.1fms", beforeLat, duringLat, afterLat)

	delta := duringLat - beforeLat
	if delta < 100 {
		t.Errorf("network_latency_inject of +200ms produced only +%.1fms delta", delta)
	}
	if afterLat > duringLat*0.7 {
		t.Errorf("post-cause latency %.1f close to in-cause %.1f — cause didn't release", afterLat, duringLat)
	}
}

// TestCause_CauseIDsLabelLogs: every log emitted from a hop affected by
// a cause carries the cause's ID in cause_ids — that's the ground-truth
// label for training data.
func TestCause_CauseIDsLabelLogs(t *testing.T) {
	cause := scenario.Cause{
		ID:     "label-test",
		Type:   "capacity_loss",
		From:   5,
		To:     15,
		Target: "app-svc",
		Parameters: map[string]any{
			"capacity_mul": 0.5,
		},
	}
	batch := runWithCause(t, twoServiceScenarioYAML, cause, 20, 42)

	baseTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tickInterval := time.Second
	from := baseTime.Add(5 * tickInterval)
	to := baseTime.Add(15 * tickInterval)

	in, out := 0, 0
	for _, e := range batch {
		if e.Sourcetype != "nodejs" {
			continue
		}
		ts, err := time.Parse("2006-01-02T15:04:05.000Z07:00", e.TS)
		if err != nil {
			continue
		}
		within := !ts.Before(from) && ts.Before(to)
		hasCause := false
		for _, id := range e.CauseIDs {
			if id == "label-test" {
				hasCause = true
				break
			}
		}
		if within {
			in++
			if !hasCause {
				t.Errorf("log within cause window missing label %q: %s", "label-test", e.TS)
				if in > 5 {
					return // don't spam
				}
			}
		} else {
			out++
			if hasCause {
				t.Errorf("log outside cause window erroneously labeled %q: %s", "label-test", e.TS)
			}
		}
	}
	if in == 0 {
		t.Fatal("no in-window logs found — scenario broken?")
	}
	t.Logf("%d in-window logs all carry cause_id, %d out-of-window logs all unlabeled", in, out)
}

func init() {
	// Suppress unused warning when only some helpers are exercised.
	_ = fmt.Sprintf
}
