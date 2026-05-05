package engine

import (
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// Component capacity defaults for Stage 2 of PHYSICS_PLAN.md (§4.2).
//
// Capacity is the service rate μ in requests per second. For Stage 2 it
// sets the denominator in the utilization calculation; once arrivals
// approach μ, latency rises along an M/M/1-shaped curve, and beyond μ the
// component saturates. Capacity is currently a per-type default; a YAML
// override (`generator.capacity_rps`) is a Stage 2.5 follow-up.

const (
	// Above this utilization we clamp to avoid 1/0; in real systems this
	// is the regime where queues overflow and 503s appear.
	saturationCutoff = 0.95
	// At full saturation we apply this multiplier to the base service
	// time. 50× makes the saturation knee very visible without producing
	// nonsense like 100-second responses for routine endpoints.
	saturationMultiplier = 50.0
)

// defaultServiceCapacity returns the per-tick request capacity for a
// service type — a coarse sense of "how many RPS can one instance of this
// service handle before queue effects kick in." Numbers are picked to be
// in the right order of magnitude for typical scenarios; tighter
// calibration is a Stage 5 task once we have real-corpus baselines.
func defaultServiceCapacity(t scenario.ServiceType) float64 {
	switch t {
	case scenario.ServiceTypeNodejs, scenario.ServiceTypeGolang:
		return 200 // single instance, mid-range CPU-bound endpoints
	case scenario.ServiceTypeMySQL, scenario.ServiceTypePostgres:
		return 500 // mix of point lookups and small writes
	case scenario.ServiceTypeRedis:
		return 20000
	case scenario.ServiceTypeNginx:
		return 5000 // standalone nginx as application server
	}
	return 1000
}

// defaultNodeCapacity returns the per-tick request capacity for a
// routing/balancing node type. LBs are intentionally high — they should
// almost never saturate in a typical scenario, and when they do the
// upstream is what's actually breaking.
func defaultNodeCapacity(t scenario.NodeType) float64 {
	switch t {
	case scenario.NodeTypeLoadBalancer:
		return 10000
	}
	return 0
}

// queueLatencyMul returns the latency multiplier for a given utilization
// ρ = arrival_rate / service_rate. Below ~0.5 it's nearly 1 (queue is
// short); approaching 1 it rises sharply; above the saturation cutoff it
// clamps so we don't divide by zero.
//
// Closed form: classical M/M/1 says total time = service_time / (1 − ρ).
// We use that shape as a multiplier on configured base latency. This is
// what Level 3 oracle tests check the engine against.
func queueLatencyMul(utilization float64) float64 {
	if utilization <= 0 {
		return 1
	}
	if utilization >= saturationCutoff {
		return saturationMultiplier
	}
	return 1.0 / (1.0 - utilization)
}

// saturationErrorRate returns the fraction of arrivals at this entity
// that should be marked as saturation errors (503 / 504) given a
// utilization ρ. Below 0.85 we assume the residual baseline error rate
// dominates; from 0.85→1.0 saturation errors grow steeply; at and above
// 1.0 we lose the surplus to overflow.
func saturationErrorRate(utilization float64) float64 {
	if utilization < 0.85 {
		return 0
	}
	if utilization >= 1.0 {
		return 1.0 - 1.0/utilization // queue cannot keep up; surplus drops
	}
	// Linear ramp from 0 at 0.85 → 0.20 at 1.0.
	return (utilization - 0.85) * (0.20 / 0.15)
}
