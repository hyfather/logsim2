package engine

import (
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// causeRegistry resolves which scenario.Causes are active per tick and
// computes the aggregate effect each cause type has on the request
// simulator. Stage 3 of PHYSICS_PLAN.md.
//
// Three cause types are wired in this round:
//
//   - capacity_loss: multiplies the target entity's μ by params.capacity_mul
//     (default 0.1). Drives latency up via the M/M/1 envelope from Stage 2,
//     and once ρ crosses the saturation cutoff, 5xx start flowing.
//
//   - traffic_spike: multiplies arrivals at the target user_clients node by
//     params.multiplier (default 5.0). Pure load-test shape; symptoms
//     emerge from queueing if arrival rate exceeds capacity.
//
//   - network_latency_inject: adds params.extra_ms (default 100) to every
//     hop on a connection where Source matches cause.Source and Target
//     matches cause.Target. Decoupled from utilization — pure timing
//     shift.
type causeRegistry struct {
	all []scenario.Cause
}

func newCauseRegistry(causes []scenario.Cause) *causeRegistry {
	cp := make([]scenario.Cause, len(causes))
	copy(cp, causes)
	return &causeRegistry{all: cp}
}

// activeAt returns the indices of causes active at the given tick.
// Returning indices (rather than copies) lets callers mutate the slice
// without churn; everyone treats them as read-only.
func (cr *causeRegistry) activeAt(tick int) []int {
	if cr == nil {
		return nil
	}
	out := make([]int, 0, 4)
	for i := range cr.all {
		if cr.all[i].Active(tick) {
			out = append(out, i)
		}
	}
	return out
}

// capacityMultiplier returns the multiplier on an entity's nominal
// capacity at the given tick from any active capacity_loss cause that
// targets it. 1.0 = normal. Multiple stacking causes multiply together.
func (cr *causeRegistry) capacityMultiplier(entity string, tick int) float64 {
	if cr == nil {
		return 1.0
	}
	mul := 1.0
	for i := range cr.all {
		c := &cr.all[i]
		if !c.Active(tick) || c.Type != "capacity_loss" {
			continue
		}
		if !targetMatches(c.Target, entity) {
			continue
		}
		m := c.FloatParam("capacity_mul", 0.1)
		if m < 0 {
			m = 0
		}
		mul *= m
	}
	return mul
}

// trafficMultiplier returns the multiplier on arrival rate at a
// user_clients entity from any active traffic_spike cause.
func (cr *causeRegistry) trafficMultiplier(entity string, tick int) float64 {
	if cr == nil {
		return 1.0
	}
	mul := 1.0
	for i := range cr.all {
		c := &cr.all[i]
		if !c.Active(tick) || c.Type != "traffic_spike" {
			continue
		}
		if !targetMatches(c.Target, entity) {
			continue
		}
		m := c.FloatParam("multiplier", 5.0)
		if m < 0 {
			m = 0
		}
		mul *= m
	}
	return mul
}

// networkLatencyAdd returns extra latency in ms to add at a hop with
// the given (src, dst) entities, from any active network_latency_inject
// cause.
func (cr *causeRegistry) networkLatencyAdd(srcEntity, dstEntity string, tick int) int {
	if cr == nil {
		return 0
	}
	total := 0
	for i := range cr.all {
		c := &cr.all[i]
		if !c.Active(tick) || c.Type != "network_latency_inject" {
			continue
		}
		if c.Source != "" && !targetMatches(c.Source, srcEntity) {
			continue
		}
		if c.Target != "" && !targetMatches(c.Target, dstEntity) {
			continue
		}
		total += c.IntParam("extra_ms", 100)
	}
	return total
}

// causeIDsForHop returns the IDs of causes that touched this entity at
// this tick — used to tag emitted log entries with the cause that
// caused them, for ground-truth output.
func (cr *causeRegistry) causeIDsForHop(entity, srcEntity string, tick int) []string {
	if cr == nil {
		return nil
	}
	var out []string
	for i := range cr.all {
		c := &cr.all[i]
		if !c.Active(tick) {
			continue
		}
		switch c.Type {
		case "capacity_loss":
			if targetMatches(c.Target, entity) {
				out = append(out, c.ID)
			}
		case "traffic_spike":
			if targetMatches(c.Target, entity) {
				out = append(out, c.ID)
			}
		case "network_latency_inject":
			srcOk := c.Source == "" || targetMatches(c.Source, srcEntity)
			dstOk := c.Target == "" || targetMatches(c.Target, entity)
			if srcOk && dstOk {
				out = append(out, c.ID)
			}
		}
	}
	return out
}

// targetMatches returns true when an entity name matches a target
// pattern. Stage 3 supports exact match and "*" wildcard. Glob support
// lands when scenarios get bigger and need it.
func targetMatches(pattern, name string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	return pattern == name
}
