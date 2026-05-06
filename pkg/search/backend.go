// Package search hosts the in-process IR daemon that powers `logsim search`.
//
// The package is split into a backend-agnostic API surface (this file) and a
// concrete DuckDB implementation. The Backend interface is the seam future
// backends (Splunk, Cribl Search, Datadog, Quickwit) plug into. To keep that
// portable the function set is deliberately small and expressible in any of
// those query languages.
package search

import (
	"context"
	"time"
)

// Event is the canonical row shape stored by every backend. It is the
// intersection of Splunk HEC, Cribl HEC, OTel logs, and OCSF — anything more
// specific lives in Fields.
type Event struct {
	ID         string         `json:"id"`
	Time       time.Time      `json:"time"`
	Host       string         `json:"host,omitempty"`
	Source     string         `json:"source,omitempty"`
	Sourcetype string         `json:"sourcetype,omitempty"`
	Index      string         `json:"index,omitempty"`
	Raw        string         `json:"raw"`
	Fields     map[string]any `json:"fields,omitempty"`
}

// Range is a half-open time window [From, To). Both ends are required.
type Range struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

// AggFn enumerates the aggregation functions supported by GetSummary. Kept
// small so every backend can implement them natively. distinct_count is in
// the set because investigators reach for it constantly ("how many unique
// users hit /login?"). Percentiles are intentionally omitted for v1 — they
// vary across backends in ways that are hard to paper over.
type AggFn string

const (
	AggCount         AggFn = "count"
	AggSum           AggFn = "sum"
	AggAvg           AggFn = "avg"
	AggMin           AggFn = "min"
	AggMax           AggFn = "max"
	AggDistinctCount AggFn = "distinct_count"
)

// Backend is the swappable seam. Every method takes a context so callers can
// cancel long queries.
type Backend interface {
	// Ingest appends events. Implementations must be safe to call concurrently.
	Ingest(ctx context.Context, events []Event) error

	// GetRaw returns events in [From, To) ordered by time ascending. Limit
	// caps the result; Offset enables pagination. Total reports the matching
	// row count (not just the returned slice) so callers know whether to
	// page.
	GetRaw(ctx context.Context, q RawQuery) (RawResult, error)

	// GetSummary applies AggFn to AggField across [From, To), optionally
	// grouped by GroupBy. With no GroupBy a single row with empty Group is
	// returned.
	GetSummary(ctx context.Context, q SummaryQuery) (SummaryResult, error)

	// GetDistribution buckets event count over time. BucketSeconds defines
	// the bucket width; rows are returned ordered by Start ascending. With
	// GroupBy each (bucket, group) pair is its own row.
	GetDistribution(ctx context.Context, q DistributionQuery) (DistributionResult, error)

	// GetTopValues returns the highest-frequency Field values in
	// [From, To) ordered by count descending.
	GetTopValues(ctx context.Context, q TopValuesQuery) (TopValuesResult, error)

	// Stats returns lightweight metadata for TUI/UI display. Cheap to call.
	Stats(ctx context.Context) (Stats, error)

	// Close releases all resources. Safe to call once; subsequent calls
	// are no-ops.
	Close() error
}

type RawQuery struct {
	Range
	Limit  int `json:"limit,omitempty"`
	Offset int `json:"offset,omitempty"`
}

type RawResult struct {
	Events []Event `json:"events"`
	Total  int64   `json:"total"`
}

type SummaryQuery struct {
	Range
	AggFn    AggFn  `json:"agg_fn"`
	AggField string `json:"agg_field,omitempty"` // empty for count
	GroupBy  string `json:"group_by,omitempty"`
}

type SummaryRow struct {
	Group string  `json:"group,omitempty"`
	Value float64 `json:"value"`
}

type SummaryResult struct {
	Rows []SummaryRow `json:"rows"`
}

type DistributionQuery struct {
	Range
	BucketSeconds int    `json:"bucket_seconds"`
	GroupBy       string `json:"group_by,omitempty"`
}

type DistributionBucket struct {
	Start time.Time `json:"start"`
	Group string    `json:"group,omitempty"`
	Count int64     `json:"count"`
}

type DistributionResult struct {
	Buckets []DistributionBucket `json:"buckets"`
}

type TopValuesQuery struct {
	Range
	Field string `json:"field"`
	Limit int    `json:"limit,omitempty"`
}

type TopValue struct {
	Value string `json:"value"`
	Count int64  `json:"count"`
}

type TopValuesResult struct {
	Values []TopValue `json:"values"`
}

type Stats struct {
	EventCount  int64     `json:"event_count"`
	OldestEvent time.Time `json:"oldest_event,omitempty"`
	NewestEvent time.Time `json:"newest_event,omitempty"`
}

// IsValidAggFn reports whether s names a supported aggregation.
func IsValidAggFn(s string) bool {
	switch AggFn(s) {
	case AggCount, AggSum, AggAvg, AggMin, AggMax, AggDistinctCount:
		return true
	}
	return false
}
