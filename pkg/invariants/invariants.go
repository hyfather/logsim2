// Package invariants asserts structural properties on a batch of emitted
// log entries. Each invariant corresponds to a §7 entry in PHYSICS_PLAN.md
// and is callable from tests and from the validation rig.
//
// A failing invariant is a bug in the engine or generators, not in the
// invariant — these are the "physics debug overlay" of the simulator.
package invariants

import (
	"fmt"

	"github.com/nikhilm/logsim2/pkg/event"
)

// Result reports whether an invariant held over a batch.
type Result struct {
	Name      string
	OK        bool
	Violations []string // empty when OK; capped to keep error output tractable
	Stats     map[string]any
}

// Error returns a non-nil error when the invariant didn't hold.
func (r Result) Error() error {
	if r.OK {
		return nil
	}
	return fmt.Errorf("invariant %q failed: %d violations (showing %d): %v",
		r.Name, len(r.Violations), min(len(r.Violations), 5), r.Violations[:min(len(r.Violations), 5)])
}

const maxViolations = 100

// Run executes a slate of invariants over a batch and aggregates results.
type Slate struct {
	Checkers []Checker
}

// Checker is one named invariant.
type Checker interface {
	Name() string
	Check(batch []event.LogEntry) Result
}

// Default returns the structural invariant slate from §7.1: TraceClosure,
// StatusPairing, ByteConservation, NoOrphanChildren. Stage 1 ships these.
func Default() Slate {
	return Slate{
		Checkers: []Checker{
			TraceClosure{},
			StatusPairing{},
			ByteConservation{ToleranceFraction: 0.30},
			ConnectionIdentity{},
		},
	}
}

// RunAll runs every checker and returns one Result per checker.
func (s Slate) RunAll(batch []event.LogEntry) []Result {
	out := make([]Result, 0, len(s.Checkers))
	for _, c := range s.Checkers {
		out = append(out, c.Check(batch))
	}
	return out
}

// ----- TraceClosure ---------------------------------------------------------

// TraceClosure asserts that every TraceID present in any LB log has at
// least one matching downstream log line (any sourcetype other than
// nginx/vpc-flow). The test is "if a request reached an LB, did anything
// downstream record it?" — the structural property at the heart of
// cross-source-type correlation.
type TraceClosure struct{}

func (TraceClosure) Name() string { return "TraceClosure" }

func (TraceClosure) Check(batch []event.LogEntry) Result {
	r := Result{Name: "TraceClosure", OK: true, Stats: map[string]any{}}

	// trace_id → set of sourcetypes that recorded it.
	seen := make(map[string]map[string]bool)
	for i := range batch {
		e := &batch[i]
		if e.TraceID == "" {
			continue
		}
		if seen[e.TraceID] == nil {
			seen[e.TraceID] = map[string]bool{}
		}
		seen[e.TraceID][e.Sourcetype] = true
	}

	totalLBTraces := 0
	missing := 0
	for tid, sts := range seen {
		if !sts["nginx"] {
			continue
		}
		totalLBTraces++
		// We expect at least one non-LB, non-VPC sourcetype downstream.
		downstream := false
		for st := range sts {
			if st != "nginx" && st != "vpc-flow" {
				downstream = true
				break
			}
		}
		if !downstream {
			missing++
			if len(r.Violations) < maxViolations {
				r.Violations = append(r.Violations, fmt.Sprintf("trace %s: LB log present, no downstream", tid))
			}
		}
	}
	r.Stats["lb_traces"] = totalLBTraces
	r.Stats["lb_traces_missing_downstream"] = missing
	r.OK = missing == 0
	return r
}

// ----- StatusPairing --------------------------------------------------------

// StatusPairing asserts that for every 5xx in an LB log there is either
// (a) a matching 5xx log at the same TraceID downstream, or
// (b) no downstream log at all (the modeled-timeout case).
//
// Catches the common bug "LB returns 502 but the backend log says 200 for
// the same trace_id" — the most visible form of layers disagreeing.
type StatusPairing struct{}

func (StatusPairing) Name() string { return "StatusPairing" }

func (StatusPairing) Check(batch []event.LogEntry) Result {
	r := Result{Name: "StatusPairing", OK: true, Stats: map[string]any{}}

	type entryKey struct{ trace, sourcetype string }
	statuses := make(map[entryKey][]int)
	for i := range batch {
		e := &batch[i]
		if e.TraceID == "" || e.Fields == nil {
			continue
		}
		s, ok := statusFromFields(e.Fields)
		if !ok {
			continue
		}
		k := entryKey{e.TraceID, e.Sourcetype}
		statuses[k] = append(statuses[k], s)
	}

	totalLB5xx := 0
	mismatch := 0
	for k, codes := range statuses {
		if k.sourcetype != "nginx" {
			continue
		}
		for _, c := range codes {
			if c < 500 {
				continue
			}
			totalLB5xx++
			// Look for any non-nginx downstream record at this trace.
			hasDownstream := false
			downstreamOK := false
			for k2, codes2 := range statuses {
				if k2.trace != k.trace || k2.sourcetype == "nginx" || k2.sourcetype == "vpc-flow" {
					continue
				}
				hasDownstream = true
				for _, c2 := range codes2 {
					if c2 >= 500 {
						downstreamOK = true
					}
				}
			}
			if hasDownstream && !downstreamOK {
				mismatch++
				if len(r.Violations) < maxViolations {
					r.Violations = append(r.Violations,
						fmt.Sprintf("trace %s: LB %d has downstream non-5xx", k.trace, c))
				}
			}
		}
	}
	r.Stats["lb_5xx"] = totalLB5xx
	r.Stats["lb_5xx_mismatched"] = mismatch
	r.OK = mismatch == 0
	return r
}

// ----- ByteConservation -----------------------------------------------------

// ByteConservation asserts that VPC flow log byte totals reconcile with
// HTTP body bytes in upstream logs within a layer-aware envelope.
//
// In a multi-layer topology a single HTTP body crosses multiple TCP
// connections (UC→LB, LB→App, App→DB), and VPC flow logs see bytes once
// per connection. So total VPC bytes scale with the number of network
// layers, not with HTTP body bytes alone. This invariant uses a
// MaxLayerFactor bound: VPC bytes ≤ MaxLayerFactor × HTTP_body_bytes.
//
// Stage 2's stricter per-connection reconciliation will tighten this.
type ByteConservation struct {
	// ToleranceFraction is reserved for Stage 2 per-connection checks.
	ToleranceFraction float64
	// MaxLayerFactor is the upper multiple of HTTP body bytes that VPC
	// bytes may reach. Default 20 — covers up to ~6 layers each carrying
	// req+resp with overhead. Set lower in scenarios known to be flat.
	MaxLayerFactor float64
}

func (ByteConservation) Name() string { return "ByteConservation" }

func (b ByteConservation) Check(batch []event.LogEntry) Result {
	r := Result{Name: "ByteConservation", OK: true, Stats: map[string]any{}}

	var httpBodyBytes int64
	var vpcBytes int64
	for i := range batch {
		e := &batch[i]
		switch e.Sourcetype {
		case "nginx":
			if v, ok := numField(e.Fields, "body_bytes"); ok {
				httpBodyBytes += v
			}
		case "vpc-flow":
			if v, ok := numField(e.Fields, "bytes"); ok {
				vpcBytes += v
			}
		}
	}
	r.Stats["http_body_bytes"] = httpBodyBytes
	r.Stats["vpc_bytes"] = vpcBytes

	if httpBodyBytes == 0 || vpcBytes == 0 {
		return r
	}
	maxFactor := b.MaxLayerFactor
	if maxFactor <= 0 {
		maxFactor = 20
	}

	// Lower bound: VPC must see at least the response bytes (the LB
	// connection alone carries them), modulo a small absolute floor for
	// short bursts.
	floor := int64(2000)
	if vpcBytes+floor < httpBodyBytes {
		r.OK = false
		r.Violations = append(r.Violations,
			fmt.Sprintf("VPC bytes %d less than HTTP body bytes %d", vpcBytes, httpBodyBytes))
	}
	upper := int64(float64(httpBodyBytes)*maxFactor) + floor
	if vpcBytes > upper {
		r.OK = false
		r.Violations = append(r.Violations,
			fmt.Sprintf("VPC bytes %d > %.1f× HTTP body bytes %d (upper bound %d)",
				vpcBytes, maxFactor, httpBodyBytes, upper))
	}
	r.Stats["ratio_vpc_over_http"] = float64(vpcBytes) / float64(httpBodyBytes)
	return r
}

// ----- ConnectionIdentity ---------------------------------------------------

// ConnectionIdentity asserts that within one batch, a given (src_ip,
// dst_ip, dst_port, protocol) triple uses a stable src_port across all
// VPC flow records — what a real persistent TCP connection produces.
type ConnectionIdentity struct{}

func (ConnectionIdentity) Name() string { return "ConnectionIdentity" }

func (ConnectionIdentity) Check(batch []event.LogEntry) Result {
	r := Result{Name: "ConnectionIdentity", OK: true, Stats: map[string]any{}}

	type triple struct {
		src, dst string
		dstPort  int
		proto    int
	}
	srcPorts := make(map[triple]map[int]bool)
	for i := range batch {
		e := &batch[i]
		if e.Sourcetype != "vpc-flow" || e.Fields == nil {
			continue
		}
		src, _ := strField(e.Fields, "src_ip")
		dst, _ := strField(e.Fields, "dst_ip")
		dstPort, _ := intField(e.Fields, "dst_port")
		proto, _ := intField(e.Fields, "protocol")
		srcPort, _ := intField(e.Fields, "src_port")
		k := triple{src, dst, dstPort, proto}
		if srcPorts[k] == nil {
			srcPorts[k] = map[int]bool{}
		}
		srcPorts[k][srcPort] = true
	}
	unstable := 0
	for k, ports := range srcPorts {
		if len(ports) > 1 {
			unstable++
			if len(r.Violations) < maxViolations {
				r.Violations = append(r.Violations,
					fmt.Sprintf("triple %s→%s:%d proto=%d had %d distinct src_ports",
						k.src, k.dst, k.dstPort, k.proto, len(ports)))
			}
		}
	}
	r.Stats["unstable_5tuples"] = unstable
	r.OK = unstable == 0
	return r
}

// ----- helpers --------------------------------------------------------------

func statusFromFields(f map[string]any) (int, bool) {
	if v, ok := intField(f, "status_code"); ok {
		return v, true
	}
	return 0, false
}

func intField(f map[string]any, key string) (int, bool) {
	v, ok := f[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		return int(x), true
	}
	return 0, false
}

func numField(f map[string]any, key string) (int64, bool) {
	v, ok := f[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int64:
		return x, true
	case float64:
		return int64(x), true
	}
	return 0, false
}

func strField(f map[string]any, key string) (string, bool) {
	v, ok := f[key]
	if !ok {
		return "", false
	}
	if s, isStr := v.(string); isStr {
		return s, true
	}
	return "", false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
