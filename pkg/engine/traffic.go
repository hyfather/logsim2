package engine

import (
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// trafficSimulator wraps the request simulator (Stage 1 of PHYSICS_PLAN.md)
// and exposes the per-tick aggregate flow view that VPC flow logs and any
// remaining flow-consuming generators rely on. Flows are derived from the
// per-request Hop chain so the two views are consistent by construction —
// a connection's RequestCount equals the number of hops on it this tick,
// and bytes are the sum of hop bytes within a small overhead envelope.
type trafficSimulator struct {
	rs *requestSimulator
}

func newTrafficSimulator(s *scenario.Scenario) *trafficSimulator {
	return &trafficSimulator{rs: newRequestSimulator(s)}
}

// Flows produces per-tick aggregate flows. Internally it generates
// Requests then aggregates the Hops by connection — so callers that only
// want the aggregate view get a consistent result without separately
// caring about the request graph.
//
// Note: callers that want both the requests and the flows should use
// RequestsAndFlows to avoid generating requests twice (and to keep
// determinism — generating twice would consume rng twice).
func (ts *trafficSimulator) Flows(
	s *scenario.Scenario,
	tickIndex int,
	tickIntervalMs int,
	r rng,
	t time.Time,
) []event.Flow {
	requests := ts.rs.Requests(s, tickIndex, tickIntervalMs, r, t)
	return flowsFromRequests(s, requests, t)
}

// RequestsAndFlows produces both views in a single rng pass. Engine.Run
// uses this so it can populate TickContext.Requests and TickContext.AllFlows
// without consuming rng twice.
func (ts *trafficSimulator) RequestsAndFlows(
	s *scenario.Scenario,
	tickIndex int,
	tickIntervalMs int,
	r rng,
	t time.Time,
) ([]event.Request, []event.Flow) {
	requests := ts.rs.Requests(s, tickIndex, tickIntervalMs, r, t)
	return requests, flowsFromRequests(s, requests, t)
}

// flowsFromRequests aggregates request Hops into per-connection per-tick
// flows. One Flow per (ConnectionIdx) — or per (src,dst,proto) tuple for
// hops with no connection index (synthesized self-traffic).
func flowsFromRequests(s *scenario.Scenario, requests []event.Request, baseTime time.Time) []event.Flow {
	type aggKey struct {
		connIdx         int
		src, dst, proto string
		port            int
	}
	type agg struct {
		req   int
		errs  int
		bsent int64
		brecv int64
		srcIP string
		dstIP string
		ts    time.Time
	}
	bucket := make(map[aggKey]*agg)
	order := make([]aggKey, 0)

	// Index connections for fast (src,dst,proto)→idx lookup.
	type ckey struct{ src, dst, proto string }
	cidx := make(map[ckey]int, len(s.Connections))
	for ci := range s.Connections {
		c := &s.Connections[ci]
		cidx[ckey{c.Source, c.Target, c.Protocol}] = ci
	}

	for ri := range requests {
		r := &requests[ri]
		for hi := range r.Hops {
			h := &r.Hops[hi]
			if h.SrcEntity == "" {
				continue
			}
			connIdx := -1
			if v, ok := cidx[ckey{h.SrcEntity, h.Entity, h.Protocol}]; ok {
				connIdx = v
			}
			var k aggKey
			if connIdx >= 0 {
				k = aggKey{connIdx: connIdx}
			} else {
				k = aggKey{connIdx: -1, src: h.SrcEntity, dst: h.Entity, proto: h.Protocol, port: h.DstPort}
			}
			a, ok := bucket[k]
			if !ok {
				a = &agg{ts: baseTime, srcIP: h.SrcIP, dstIP: h.DstIP}
				bucket[k] = a
				order = append(order, k)
			}
			a.req++
			if h.Status >= 500 {
				a.errs++
			}
			a.bsent += h.BytesIn
			a.brecv += h.BytesOut
			if h.EnteredAt.Before(a.ts) {
				a.ts = h.EnteredAt
			}
		}
	}

	out := make([]event.Flow, 0, len(order))
	for _, k := range order {
		a := bucket[k]
		flow := event.Flow{
			ConnectionIdx: k.connIdx,
			RequestCount:  a.req,
			BytesSent:     a.bsent,
			BytesReceived: a.brecv,
			ErrorCount:    a.errs,
			SrcIP:         a.srcIP,
			DstIP:         a.dstIP,
			Timestamp:     a.ts,
		}
		if k.connIdx >= 0 && k.connIdx < len(s.Connections) {
			c := s.Connections[k.connIdx]
			flow.SourceName = c.Source
			flow.TargetName = c.Target
			flow.Protocol = c.Protocol
			flow.Port = c.Port
		} else {
			flow.SourceName = k.src
			flow.TargetName = k.dst
			flow.Protocol = k.proto
			flow.Port = k.port
		}
		out = append(out, flow)
	}
	return out
}

// defaultServiceRPS is the baseline arrival rate synthesized at services
// with no upstream user_clients reaching them, so a canvas containing only
// services still produces logs. Picked so a single service produces ~10
// logs/sec — enough to feel "live" without spamming.
const defaultServiceRPS = 10.0
