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
	Source     string         `json:"source"`     // e.g. "web-service.vpc.subnet.host.svc"
	Level      string         `json:"level"`      // DEBUG | INFO | WARN | ERROR | FATAL
	Sourcetype string         `json:"sourcetype"` // "nodejs" | "mysql" | "vpc-flow" | ...
	Raw        string         `json:"raw"`        // the rendered log line
	Fields     map[string]any `json:"fields,omitempty"` // structured form of Raw
}

// Flow represents synthesized network traffic on one connection for one tick.
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

// TickContext is handed to every generator on each tick.
type TickContext struct {
	TickIndex      int
	Timestamp      time.Time
	TickIntervalMs int
	Rng            interface{ Float64() float64; Intn(int) int }
	// AllFlows contains every flow generated this tick.
	// Node-level generators (VPC flow logs, load balancers) use this
	// instead of the inbound-only slice passed as the second argument.
	AllFlows []Flow
	// Override is the timeline-resolved behavior override for the target
	// being generated. Identity (LatencyMul=1, LogVolMul=1, no error rate)
	// when no timeline block is active.
	Override scenario.Override
}
