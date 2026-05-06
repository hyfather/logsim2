package search

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MemoryBackend is the pure-Go Backend implementation. It satisfies the same
// interface as DuckDBBackend so the chi server doesn't care which is used —
// `logsim search` (CLI, CGO) wires DuckDB; `api/search/...` (Vercel, no CGO)
// wires this. See backend.go for the contract.
//
// The implementation is intentionally simple: an append-only []Event guarded
// by a mutex, sorted lazily on the first query after each ingest. Session
// sizes are O(10k–50k) events; sorting is microseconds at that scale.
type MemoryBackend struct {
	mu     sync.Mutex
	events []Event
	sorted bool // false means the next query must re-sort
	closed bool
}

func NewMemoryBackend() *MemoryBackend { return &MemoryBackend{} }

func (m *MemoryBackend) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	m.events = nil
	return nil
}

func (m *MemoryBackend) Ingest(_ context.Context, evs []Event) error {
	if len(evs) == 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errors.New("backend closed")
	}
	for i := range evs {
		if evs[i].Time.IsZero() {
			evs[i].Time = time.Now().UTC()
		}
	}
	m.events = append(m.events, evs...)
	m.sorted = false
	return nil
}

// snapshot returns a sorted slice and the matching range subset. Caller
// holds the mutex.
func (m *MemoryBackend) snapshotLocked() {
	if m.sorted {
		return
	}
	sort.SliceStable(m.events, func(i, j int) bool {
		return m.events[i].Time.Before(m.events[j].Time)
	})
	m.sorted = true
}

// rangeSliceLocked returns the slice of events in [from, to). Caller holds
// the mutex; events must already be sorted.
func (m *MemoryBackend) rangeSliceLocked(from, to time.Time) []Event {
	// Binary-search both bounds since events are sorted by time.
	lo := sort.Search(len(m.events), func(i int) bool { return !m.events[i].Time.Before(from) })
	hi := sort.Search(len(m.events), func(i int) bool { return !m.events[i].Time.Before(to) })
	return m.events[lo:hi]
}

func (m *MemoryBackend) Stats(_ context.Context) (Stats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Stats{}, errors.New("backend closed")
	}
	m.snapshotLocked()
	s := Stats{EventCount: int64(len(m.events))}
	if n := len(m.events); n > 0 {
		s.OldestEvent = m.events[0].Time
		s.NewestEvent = m.events[n-1].Time
	}
	return s, nil
}

func (m *MemoryBackend) GetRaw(_ context.Context, q RawQuery) (RawResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return RawResult{}, errors.New("backend closed")
	}
	m.snapshotLocked()
	matches := m.rangeSliceLocked(q.From, q.To)
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	out := RawResult{Events: []Event{}, Total: int64(len(matches))}
	if q.Offset >= len(matches) {
		return out, nil
	}
	end := q.Offset + limit
	if end > len(matches) {
		end = len(matches)
	}
	// Defensive copy so the caller can't observe later writes.
	out.Events = append([]Event(nil), matches[q.Offset:end]...)
	return out, nil
}

func (m *MemoryBackend) GetSummary(_ context.Context, q SummaryQuery) (SummaryResult, error) {
	if !IsValidAggFn(string(q.AggFn)) {
		return SummaryResult{}, fmt.Errorf("invalid agg_fn %q", q.AggFn)
	}
	if q.AggFn != AggCount && q.AggField == "" {
		return SummaryResult{}, fmt.Errorf("%s requires agg_field", q.AggFn)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return SummaryResult{}, errors.New("backend closed")
	}
	m.snapshotLocked()
	matches := m.rangeSliceLocked(q.From, q.To)

	// Group events by GroupBy value (or "" when no grouping).
	type bucket struct {
		count    int64
		sum      float64
		min, max float64
		seenNum  bool
		distinct map[string]struct{}
	}
	groups := map[string]*bucket{}
	keys := []string{} // preserve first-seen order so ties are stable

	for i := range matches {
		e := &matches[i]
		var grp string
		if q.GroupBy != "" {
			v, ok := eventFieldValue(e, q.GroupBy)
			if !ok {
				continue // events lacking the group-by field don't contribute
			}
			grp = anyToString(v)
		}
		b := groups[grp]
		if b == nil {
			b = &bucket{distinct: map[string]struct{}{}}
			groups[grp] = b
			keys = append(keys, grp)
		}
		b.count++

		if q.AggFn == AggCount {
			continue
		}
		v, ok := eventFieldValue(e, q.AggField)
		if !ok {
			continue
		}
		switch q.AggFn {
		case AggDistinctCount:
			b.distinct[anyToString(v)] = struct{}{}
		case AggSum, AggAvg, AggMin, AggMax:
			f, ok := anyToFloat(v)
			if !ok {
				continue
			}
			if !b.seenNum {
				b.seenNum = true
				b.min, b.max = f, f
			} else {
				if f < b.min {
					b.min = f
				}
				if f > b.max {
					b.max = f
				}
			}
			b.sum += f
		}
	}

	out := SummaryResult{Rows: []SummaryRow{}}
	for _, k := range keys {
		b := groups[k]
		var v float64
		switch q.AggFn {
		case AggCount:
			v = float64(b.count)
		case AggSum:
			v = b.sum
		case AggAvg:
			if b.count > 0 {
				v = b.sum / float64(b.count)
			}
		case AggMin:
			v = b.min
		case AggMax:
			v = b.max
		case AggDistinctCount:
			v = float64(len(b.distinct))
		}
		out.Rows = append(out.Rows, SummaryRow{Group: k, Value: v})
	}
	// Same ordering convention as DuckDB: ungrouped → single row (already
	// in keys); grouped → DESC by value.
	if q.GroupBy != "" {
		sort.SliceStable(out.Rows, func(i, j int) bool {
			return out.Rows[i].Value > out.Rows[j].Value
		})
	}
	return out, nil
}

func (m *MemoryBackend) GetDistribution(_ context.Context, q DistributionQuery) (DistributionResult, error) {
	if q.BucketSeconds <= 0 {
		return DistributionResult{}, fmt.Errorf("bucket_seconds must be > 0")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return DistributionResult{}, errors.New("backend closed")
	}
	m.snapshotLocked()
	matches := m.rangeSliceLocked(q.From, q.To)

	bucket := time.Duration(q.BucketSeconds) * time.Second
	type key struct {
		start time.Time
		group string
	}
	counts := map[key]int64{}
	order := []key{} // first-seen order

	for i := range matches {
		e := &matches[i]
		// Floor to nearest bucket. UnixNano so sub-second buckets work too.
		floor := time.Unix(0, (e.Time.UnixNano()/int64(bucket))*int64(bucket)).UTC()
		var grp string
		if q.GroupBy != "" {
			v, ok := eventFieldValue(e, q.GroupBy)
			if !ok {
				continue
			}
			grp = anyToString(v)
		}
		k := key{start: floor, group: grp}
		if _, exists := counts[k]; !exists {
			order = append(order, k)
		}
		counts[k]++
	}

	out := DistributionResult{Buckets: []DistributionBucket{}}
	for _, k := range order {
		out.Buckets = append(out.Buckets, DistributionBucket{
			Start: k.start, Group: k.group, Count: counts[k],
		})
	}
	// Sort by Start ASC; within a bucket, group by Count DESC.
	sort.SliceStable(out.Buckets, func(i, j int) bool {
		if !out.Buckets[i].Start.Equal(out.Buckets[j].Start) {
			return out.Buckets[i].Start.Before(out.Buckets[j].Start)
		}
		return out.Buckets[i].Count > out.Buckets[j].Count
	})
	return out, nil
}

func (m *MemoryBackend) GetTopValues(_ context.Context, q TopValuesQuery) (TopValuesResult, error) {
	if q.Field == "" {
		return TopValuesResult{}, fmt.Errorf("field is required")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 10
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return TopValuesResult{}, errors.New("backend closed")
	}
	m.snapshotLocked()
	matches := m.rangeSliceLocked(q.From, q.To)

	counts := map[string]int64{}
	for i := range matches {
		v, ok := eventFieldValue(&matches[i], q.Field)
		if !ok {
			continue
		}
		counts[anyToString(v)]++
	}
	type kv struct {
		v string
		n int64
	}
	all := make([]kv, 0, len(counts))
	for k, n := range counts {
		all = append(all, kv{k, n})
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].n != all[j].n {
			return all[i].n > all[j].n
		}
		return all[i].v < all[j].v // tiebreak alphabetical for determinism
	})
	if len(all) > limit {
		all = all[:limit]
	}
	out := TopValuesResult{Values: []TopValue{}}
	for _, x := range all {
		out.Values = append(out.Values, TopValue{Value: x.v, Count: x.n})
	}
	return out, nil
}

// --- field / value helpers --------------------------------------------

// eventFieldValue mirrors DuckDB's fieldExpr in pure Go. Returns (value, ok)
// where ok is false for missing/empty fields so the query can skip them.
func eventFieldValue(e *Event, name string) (any, bool) {
	switch strings.ToLower(name) {
	case "host":
		return e.Host, e.Host != ""
	case "source":
		return e.Source, e.Source != ""
	case "sourcetype":
		return e.Sourcetype, e.Sourcetype != ""
	case "index":
		return e.Index, e.Index != ""
	case "raw":
		return e.Raw, e.Raw != ""
	case "time":
		return e.Time, !e.Time.IsZero()
	case "":
		return nil, false
	}
	if e.Fields == nil {
		return nil, false
	}
	v, ok := e.Fields[name]
	if !ok {
		return nil, false
	}
	if s, isStr := v.(string); isStr && s == "" {
		return nil, false
	}
	return v, true
}

// anyToString renders a JSON-decoded value as a string for grouping/top-N.
// JSON numbers come back as float64; render integers without trailing .0
// so `200` stays `"200"`, not `"200.000000"`.
func anyToString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// anyToFloat coerces a JSON-decoded value to float64 for sum/avg/min/max.
// Returns ok=false when the value is not numeric (so the aggregator can
// skip it instead of polluting the result).
func anyToFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		if f, err := strconv.ParseFloat(x, 64); err == nil {
			return f, true
		}
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}
