// Package event defines the shared types that flow between the engine,
// generators, and sinks so none of those packages need to import each other.
package event

import (
	"time"

	"github.com/nikhilm/logsim2/pkg/scenario"
)

// LogEntry is one emitted log line.
type LogEntry struct {
	ID         string         `json:"id"`
	TS         string         `json:"ts"`         // RFC3339Nano
	Source     string         `json:"source"`     // e.g. "vpc.subnet.host.svc"
	Level      string         `json:"level"`      // DEBUG | INFO | WARN | ERROR | FATAL
	Sourcetype string         `json:"sourcetype"` // "nodejs" | "mysql" | "vpc-flow" | ...
	// Class is a generator-supplied hint that classifies the event for
	// schema-aware encoders (OCSF/UDM/ASIM). Empty means "unclassified" and
	// encoders fall back to a generic shape. Values are defined in
	// pkg/encoders to avoid an import cycle from generators.
	Class string `json:"class,omitempty"`
	// TraceID is the end-to-end identifier of the request this log is part
	// of. Empty for logs not produced by a request walk (lifecycle, infra,
	// background jobs). When non-empty, every log emitted by every component
	// touched by the same request carries the same TraceID — that's what
	// makes cross-source-type correlation work.
	TraceID string `json:"trace_id,omitempty"`
	// SpanID is the per-hop identifier for this log within its trace. Two
	// logs with the same TraceID can carry different SpanIDs when emitted by
	// different components observing the same request.
	SpanID string `json:"span_id,omitempty"`
	// CauseIDs are the scenario.Cause IDs whose causal closure includes
	// this log entry. Used as ground-truth labels in training data. The
	// field is omitted from JSON when empty so legacy sinks see no schema
	// difference for cause-free scenarios.
	CauseIDs []string       `json:"cause_ids,omitempty"`
	Raw      string         `json:"raw"`              // the rendered log line
	Fields   map[string]any `json:"fields,omitempty"` // structured form of Raw
}

// Flow represents synthesized network traffic on one connection for one tick.
// Stage 1 of PHYSICS_PLAN.md: Flow is now derived from per-request Hops
// rather than being the source of truth. It is retained as a per-tick
// aggregate view that VPC flow logs and legacy generators can still consume.
type Flow struct {
	ConnectionIdx int    // index into scenario.Connections
	SourceName    string // scenario entity name
	TargetName    string // scenario entity name
	Protocol      string
	Port          int
	RequestCount  int
	BytesSent     int64
	BytesReceived int64
	ErrorCount    int
	SrcIP         string
	DstIP         string
	Timestamp     time.Time
}

// Request is one logical request walking the connection graph from a
// user_clients entry point through the topology. It is the unit of the
// causal request graph (Stage 1 of PHYSICS_PLAN.md). Every log emitted by
// every component this request touches carries the same TraceID and a
// SpanID corresponding to its hop. Path/method/user identity are picked
// once at entry and immutable thereafter so layers agree on the same
// request.
type Request struct {
	TraceID   string    // ULID-like, unique per request
	StartedAt time.Time // global frame; entry into the system

	// Picked once at entry, immutable thereafter.
	Method    string
	Path      string
	UserAgent string
	ClientIP  string
	SessionID string // same SessionID → same UA + ClientIP

	// EntryNode is the user_clients (or originating) node name.
	EntryNode string

	// Hops are the per-component records of this request, in causal order.
	Hops []Hop

	// Failure is non-nil on a failed request; carries the offending hop and
	// reason. Stage 1 only sets this from terminal-hop status; Stage 2+ adds
	// timeout, pool exhaustion, and other failure modes.
	Failure *RequestFailure
}

// Hop is one component's record of one Request — what that component saw
// and what it did. Generators emit logs as projections of these.
type Hop struct {
	Entity     string    // node or service name
	SpanID     string    // unique per hop
	ParentSpan string    // empty for the entry hop
	EnteredAt  time.Time // arrival at this component
	LeftAt     time.Time // departure (= EnteredAt for synchronous in-memory components)

	// Connection identity — stable per (src,dst,proto) within a session, so
	// VPC flow records show consistent 5-tuples for the same logical
	// connection across multiple flows.
	SrcEntity string
	SrcIP     string
	DstIP     string
	SrcPort   int
	DstPort   int
	Protocol  string

	// Outcome at this hop. Can differ from the upstream/downstream view in
	// Stage 2+ (e.g. LB returns 502 because backend timed out → Status=502
	// here while the backend Hop has Status=0 and the request has
	// Failure="timeout"). Stage 1: status propagates uniformly.
	Status int

	// Wire bytes at this hop. Reconcilable across layers within a per-protocol
	// overhead envelope.
	BytesIn  int64
	BytesOut int64

	// LatencyMs is the time spent at this component itself (not including
	// downstream calls). Stage 2 will derive this from queueing.
	LatencyMs int

	// Children are explicit downstream calls this hop made (e.g. database
	// queries). Stage 1 populates these from the inbound connection graph
	// when a service has a connection to a database. Stage 3 makes them
	// declarable per-endpoint in YAML.
	Children []ChildCall

	// CauseIDs are the IDs of any scenario.Cause whose causal closure
	// includes this hop — i.e. the cause(s) a downstream investigator
	// should be able to identify as responsible for this hop's behaviour.
	// Empty when no causes are active. Used by generators to tag emitted
	// log entries for ground-truth labelling.
	CauseIDs []string
}

// ChildCall is one explicit downstream call from a Hop — typically a
// database query or cache lookup that the parent hop synchronously waited
// on. The parent Hop's wall-clock time includes the sum of its child call
// durations.
type ChildCall struct {
	TargetService string        // scenario service name
	Operation     string        // e.g. "SELECT users WHERE id = ?"
	StartedAt     time.Time
	Duration      time.Duration
	BytesIn       int64
	BytesOut      int64
	Error         string // empty on success
	SpanID        string // unique per child call
}

// RequestFailure describes how a Request failed (when it did). The
// OffendingHop names the entity at which the failure originated; Reason is
// a short symbolic string ("timeout", "5xx", "pool_exhausted", ...).
type RequestFailure struct {
	OffendingHop string
	Reason       string
}

// HopAt returns the Hop for the named entity in this request, or nil if
// this request didn't visit it. Convenience for generators projecting a
// request to their own component's view.
func (r *Request) HopAt(entity string) *Hop {
	for i := range r.Hops {
		if r.Hops[i].Entity == entity {
			return &r.Hops[i]
		}
	}
	return nil
}

// TickContext is handed to every generator on each tick.
type TickContext struct {
	TickIndex      int
	Timestamp      time.Time
	TickIntervalMs int
	Rng            interface {
		Float64() float64
		Intn(int) int
	}
	// AllFlows is the per-tick aggregated network view, derived from
	// Requests. Kept for VPC flow logs and any generator that hasn't yet
	// migrated to consuming Requests directly.
	AllFlows []Flow
	// Requests is the per-tick causal record produced by the request
	// simulator. Each log a generator emits should derive its facts (path,
	// method, status, bytes, trace_id) from a Request rather than rolling
	// dice independently — that's what makes cross-source-type correlation
	// hold up.
	Requests []Request
	// Override is the timeline-resolved behavior override for the target
	// being generated. Identity (LatencyMul=1, LogVolMul=1, no error rate)
	// when no timeline block is active.
	Override scenario.Override
}
