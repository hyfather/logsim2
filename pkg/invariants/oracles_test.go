package invariants_test

import (
	"context"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// Closed-form oracle tests (Level 3 in PHYSICS_PLAN.md §9). These pin
// the simulator's dynamical claims to textbook predictions: feed in a
// known load, get out a predicted latency curve. If the engine's queue
// model drifts away from M/M/1, these tests catch it.
//
// The reference oracle is M/M/1 steady-state mean response time:
//
//     W = 1 / (μ − λ)   for ρ = λ/μ < 1
//
// Equivalently, the latency multiplier as a function of utilization is
// 1 / (1 − ρ). At ρ=0.2 → 1.25×, at ρ=0.5 → 2×, at ρ=0.8 → 5×, at
// ρ=0.95 → 20×. That curve is what `engine.queueLatencyMul` produces
// and what these tests check for in the emitted log corpus.

// singleServiceScenarioYAML builds a one-service scenario at a known
// arrival rate so the oracle has a clean signal.
func singleServiceScenarioYAML(rps float64, baseLatencyMs int) string {
	return fmt.Sprintf(`
- name: Capacity Test
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
        rps: %g
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
          avg_latency_ms: %d
          error_rate: 0
- connections:
  - source: clients
    target: app-svc
    protocol: http
    port: 3000
`, rps, baseLatencyMs)
}

// measureMeanLatency runs the engine for `ticks` seconds at the given
// arrival rate and returns the mean response_time_ms reported on
// successful (status=200) nodejs logs at the target service.
func measureMeanLatency(t *testing.T, rps float64, baseLatencyMs int, ticks int, seed int64) float64 {
	t.Helper()
	yaml := singleServiceScenarioYAML(rps, baseLatencyMs)
	s, err := scenario.Parse(strings.NewReader(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
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

	var sum float64
	var n int
	for _, e := range cap.entries {
		if e.Sourcetype != "nodejs" || e.Fields == nil {
			continue
		}
		sc, _ := e.Fields["status_code"].(int)
		if sc != 200 {
			// Be tolerant of how the int comes back from JSON-ish maps.
			if scF, ok := e.Fields["status_code"].(float64); ok {
				sc = int(scF)
			}
		}
		if sc != 0 && sc != 200 {
			continue
		}
		var rt float64
		switch v := e.Fields["response_time_ms"].(type) {
		case int:
			rt = float64(v)
		case int64:
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
		t.Fatalf("no successful nodejs logs at rps=%g — scenario broken?", rps)
	}
	return sum / float64(n)
}

func TestOracle_UtilizationLatencyCurve(t *testing.T) {
	// nodejs default capacity is 200 RPS (engine/components.go).
	// A 50ms base latency makes the curve easy to read.
	const capacityRPS = 200.0
	const baseLatencyMs = 50

	// Sweep utilizations. We pick well-separated points to keep the
	// signal-to-noise high without making the test slow. Points near
	// saturation (ρ→1) are intentionally excluded — variance there is
	// huge and the closed form is least trustworthy.
	utilizations := []float64{0.20, 0.50, 0.80}
	measured := make([]float64, len(utilizations))
	for i, rho := range utilizations {
		rps := rho * capacityRPS
		// 20 ticks of warm-up + measurement gives stable mean estimates
		// at our typical per-tick RPS without making the test slow.
		measured[i] = measureMeanLatency(t, rps, baseLatencyMs, 20, 42)
		predicted := float64(baseLatencyMs) / (1 - rho)
		t.Logf("ρ=%.2f  rps=%g  measured=%.1fms  predicted=%.1fms",
			rho, rps, measured[i], predicted)
	}

	// Test 1: monotonicity — latency must not decrease as utilization
	// rises. (Trivial check that something is going on.)
	for i := 1; i < len(utilizations); i++ {
		if measured[i] <= measured[i-1] {
			t.Errorf("non-monotone latency: ρ=%.2f → %.1fms, ρ=%.2f → %.1fms",
				utilizations[i-1], measured[i-1], utilizations[i], measured[i])
		}
	}

	// Test 2: ratio of measured(ρ=0.8) to measured(ρ=0.2) should
	// approximate the M/M/1 prediction (1 − 0.2) / (1 − 0.8) = 4×.
	// Tolerance is wide because: (a) we sample log-normal not exponential,
	// (b) per-tick aggregation isn't a true continuous-time queue, and
	// (c) sample size is finite. 2× either side of the predicted ratio
	// is a real signal; tighter is sharpening, looser is broken.
	predRatio := (1 - utilizations[0]) / (1 - utilizations[len(utilizations)-1])
	measRatio := measured[len(utilizations)-1] / measured[0]
	t.Logf("predicted ratio (high/low) = %.2f, measured = %.2f", predRatio, measRatio)

	if measRatio < predRatio*0.5 {
		t.Errorf("measured ratio %.2f << predicted %.2f — queueing not engaged",
			measRatio, predRatio)
	}
	if measRatio > predRatio*2.5 {
		t.Errorf("measured ratio %.2f >> predicted %.2f — over-amplifying",
			measRatio, predRatio)
	}
}

// TestOracle_LowUtilizationIsBaseLatency confirms that at very low
// utilization the engine produces near-baseline latency — no spurious
// queue effect when the system is idle.
func TestOracle_LowUtilizationIsBaseLatency(t *testing.T) {
	const capacityRPS = 200.0
	const baseLatencyMs = 50
	measured := measureMeanLatency(t, 0.02*capacityRPS, baseLatencyMs, 20, 42)
	// At ρ=0.02 the multiplier is 1.02 — so measured should be very close
	// to the base. We also draw from a log-normal so allow ~30% spread.
	if measured > float64(baseLatencyMs)*1.5 {
		t.Errorf("low-utilization latency %.1fms is too high; expected ~%dms",
			measured, baseLatencyMs)
	}
	t.Logf("low-utilization latency: measured=%.1fms base=%dms", measured, baseLatencyMs)
}

// TestOracle_SaturationProducesErrors confirms that pushing the service
// past its capacity actually generates 5xx responses — the second half
// of the M/M/1 story (queue overflow → drops).
func TestOracle_SaturationProducesErrors(t *testing.T) {
	const capacityRPS = 200.0
	// Above capacity by 20% — saturation error rate should engage.
	rps := capacityRPS * 1.2
	yaml := singleServiceScenarioYAML(rps, 50)
	s, err := scenario.Parse(strings.NewReader(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := scenario.Validate(s); err != nil {
		t.Fatalf("validate: %v", err)
	}
	cfg := engine.Config{
		Seed:           123,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:   "*",
	}
	cap := &captureSink{}
	eng := engine.New(s, cfg)
	if err := eng.Run(context.Background(), 5, []sinks.Sink{cap}); err != nil {
		t.Fatalf("run: %v", err)
	}

	total, errs := countResponses(cap.entries, "nodejs")
	t.Logf("saturated run: %d nodejs logs, %d 5xx (rate %.3f)",
		total, errs, float64(errs)/math.Max(1, float64(total)))
	if total < 100 {
		t.Fatalf("expected lots of nodejs logs, got %d", total)
	}
	if errs == 0 {
		t.Errorf("at ρ=1.2× capacity, expected saturation 5xx, got none")
	}
}

func countResponses(batch []event.LogEntry, sourcetype string) (total, errs int) {
	for _, e := range batch {
		if e.Sourcetype != sourcetype {
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
	return
}
