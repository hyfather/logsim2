package invariants_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/invariants"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// referenceScenarioYAML is a small scenario exercising LB + nodejs +
// MySQL + VPC flow logs all together so the invariants have something to
// stress.
const referenceScenarioYAML = `
- name: Web Service
- nodes:
  - type: vpc
    name: Web Service VPC
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: Web Service Subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server 1
    subnet: Web Service Subnet
    private_ip: 10.0.1.10
  - type: virtual_server
    name: Database Server
    subnet: Web Service Subnet
    private_ip: 10.0.1.12
  - type: load_balancer
    name: Load Balancer
    subnet: Web Service Subnet
    private_ip: 10.0.1.13
  - type: user_clients
    name: User Clients
    clients:
      - name: Web Client 1
        ip: 45.45.45.1
        rps: 20
        traffic_pattern: steady
- services:
  - type: nodejs
    name: User Directory Service
    host: App Server 1
    generator:
      type: nodejs
      port: 3000
      log_format: json
      endpoints:
        - method: GET
          path: /api/users
          avg_latency_ms: 100
          error_rate: 0.01
        - method: POST
          path: /api/users
          avg_latency_ms: 500
          error_rate: 0.01
  - type: mysql
    name: App Database
    host: Database Server
    generator:
      type: mysql
      port: 3306
      database: users
      slow_query_threshold: 1000
- connections:
  - source: User Clients
    target: Load Balancer
    protocol: https
    port: 443
  - source: Load Balancer
    target: User Directory Service
    protocol: http
    port: 3000
  - source: User Directory Service
    target: App Database
    protocol: mysql
    port: 3306
`

// generateBatch runs the engine on the reference scenario and collects the
// emitted log entries into a slice. Returns the structured LogEntry slice
// (preserving Fields) — invariant checks rely on Fields, so we capture
// them from a captureSink rather than parsing serialized JSON.
func generateBatch(t *testing.T, ticks int, seed int64) []event.LogEntry {
	t.Helper()
	s, err := scenario.Parse(strings.NewReader(referenceScenarioYAML))
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
	return cap.entries
}

// captureSink stores LogEntry values in-memory for invariant checks.
type captureSink struct {
	entries []event.LogEntry
}

func (c *captureSink) Write(entries []event.LogEntry) error {
	c.entries = append(c.entries, entries...)
	return nil
}
func (c *captureSink) Flush() error { return nil }
func (c *captureSink) Close() error { return nil }

func TestInvariants_TraceClosure(t *testing.T) {
	batch := generateBatch(t, 5, 42)
	r := invariants.TraceClosure{}.Check(batch)
	if !r.OK {
		t.Fatalf("TraceClosure failed: %v\nstats=%v", r.Violations[:min(len(r.Violations), 5)], r.Stats)
	}
	if r.Stats["lb_traces"].(int) == 0 {
		t.Fatal("no LB traces in batch — invariant trivially passes; scenario broken?")
	}
	t.Logf("TraceClosure: %d LB traces all have downstream logs", r.Stats["lb_traces"])
}

func TestInvariants_StatusPairing(t *testing.T) {
	// Higher seed sweep to make sure we hit 5xx in some run.
	for _, seed := range []int64{42, 7, 13, 100, 999} {
		batch := generateBatch(t, 10, seed)
		r := invariants.StatusPairing{}.Check(batch)
		if !r.OK {
			t.Fatalf("StatusPairing failed (seed=%d): %v", seed, r.Violations[:min(len(r.Violations), 5)])
		}
	}
}

func TestInvariants_ByteConservation(t *testing.T) {
	batch := generateBatch(t, 10, 42)
	r := invariants.ByteConservation{ToleranceFraction: 0.50}.Check(batch)
	if !r.OK {
		t.Fatalf("ByteConservation failed: %v\nstats=%v", r.Violations, r.Stats)
	}
	t.Logf("ByteConservation: http=%d vpc=%d", r.Stats["http_body_bytes"], r.Stats["vpc_bytes"])
}

func TestInvariants_ConnectionIdentity(t *testing.T) {
	batch := generateBatch(t, 10, 42)
	r := invariants.ConnectionIdentity{}.Check(batch)
	if !r.OK {
		t.Fatalf("ConnectionIdentity failed: %v\nstats=%v",
			r.Violations[:min(len(r.Violations), 5)], r.Stats)
	}
}

func TestInvariants_AllPass_OnReferenceScenario(t *testing.T) {
	batch := generateBatch(t, 10, 42)
	results := invariants.Default().RunAll(batch)
	for _, r := range results {
		if !r.OK {
			t.Errorf("%s: %d violations\nstats=%v\nfirst few=%v",
				r.Name, len(r.Violations), r.Stats,
				r.Violations[:min(len(r.Violations), 3)])
		}
	}
}

// TestInvariants_TraceIDsPropagate spot-checks one particular structural
// claim: a single trace_id touched by the LB must also appear on the
// nodejs and mysql sourcetype lines for the same trace.
func TestInvariants_TraceIDsPropagate(t *testing.T) {
	batch := generateBatch(t, 5, 42)

	// Find any nginx trace and verify it appears on nodejs and mysql.
	traceSourcetypes := make(map[string]map[string]bool)
	for _, e := range batch {
		if e.TraceID == "" {
			continue
		}
		if traceSourcetypes[e.TraceID] == nil {
			traceSourcetypes[e.TraceID] = map[string]bool{}
		}
		traceSourcetypes[e.TraceID][e.Sourcetype] = true
	}
	got := 0
	for tid, sts := range traceSourcetypes {
		if sts["nginx"] && sts["nodejs"] {
			got++
			t.Logf("trace %s: %v", tid, sts)
			if got >= 3 {
				break
			}
		}
	}
	if got == 0 {
		t.Fatal("no trace_id was found at both nginx and nodejs — Stage 1 propagation is broken")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
