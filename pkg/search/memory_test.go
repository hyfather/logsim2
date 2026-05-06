package search

import (
	"context"
	"testing"
	"time"
)

// seedMem mirrors the seed() helper in duckdb_test.go but for MemoryBackend.
// Same fixture so the two backends are tested against an identical contract.
func seedMem(t *testing.T, b *MemoryBackend) (start time.Time) {
	t.Helper()
	start = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	events := make([]Event, 0, 10)
	for i := 0; i < 10; i++ {
		st := "nodejs"
		status := 200
		if i%3 == 0 {
			status = 500
		}
		if i >= 5 {
			st = "mysql"
		}
		events = append(events, Event{
			ID:         "e" + time.Now().Format(time.RFC3339Nano),
			Time:       start.Add(time.Duration(i) * time.Second),
			Host:       "h",
			Source:     "app",
			Sourcetype: st,
			Raw:        "log line",
			Fields:     map[string]any{"status_code": status, "level": "INFO"},
		})
	}
	if err := b.Ingest(context.Background(), events); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	return start
}

func TestMemory_statsAndRaw(t *testing.T) {
	b := NewMemoryBackend()
	defer b.Close()
	start := seedMem(t, b)

	s, _ := b.Stats(context.Background())
	if s.EventCount != 10 {
		t.Fatalf("EventCount=%d", s.EventCount)
	}
	if !s.OldestEvent.Equal(start) {
		t.Errorf("oldest=%v", s.OldestEvent)
	}
	if !s.NewestEvent.Equal(start.Add(9 * time.Second)) {
		t.Errorf("newest=%v", s.NewestEvent)
	}

	res, _ := b.GetRaw(context.Background(), RawQuery{
		Range: Range{From: start, To: start.Add(time.Minute)}, Limit: 3,
	})
	if res.Total != 10 || len(res.Events) != 3 {
		t.Fatalf("paging: total=%d, n=%d", res.Total, len(res.Events))
	}
	if !res.Events[0].Time.Equal(start) {
		t.Errorf("first event time=%v", res.Events[0].Time)
	}

	// Offset.
	res, _ = b.GetRaw(context.Background(), RawQuery{
		Range: Range{From: start, To: start.Add(time.Minute)}, Limit: 2, Offset: 7,
	})
	if len(res.Events) != 2 {
		t.Fatalf("offset events=%d", len(res.Events))
	}
	if !res.Events[0].Time.Equal(start.Add(7 * time.Second)) {
		t.Errorf("offset first=%v", res.Events[0].Time)
	}
}

func TestMemory_summary(t *testing.T) {
	b := NewMemoryBackend()
	defer b.Close()
	start := seedMem(t, b)
	rng := Range{From: start, To: start.Add(time.Minute)}

	res, _ := b.GetSummary(context.Background(), SummaryQuery{Range: rng, AggFn: AggCount})
	if len(res.Rows) != 1 || res.Rows[0].Value != 10 {
		t.Fatalf("count: %+v", res.Rows)
	}

	res, _ = b.GetSummary(context.Background(), SummaryQuery{
		Range: rng, AggFn: AggCount, GroupBy: "sourcetype",
	})
	got := map[string]float64{}
	for _, r := range res.Rows {
		got[r.Group] = r.Value
	}
	if got["nodejs"] != 5 || got["mysql"] != 5 {
		t.Errorf("by sourcetype=%+v", got)
	}

	// avg of JSON field — same expected value as DuckDB test (320).
	res, _ = b.GetSummary(context.Background(), SummaryQuery{
		Range: rng, AggFn: AggAvg, AggField: "status_code",
	})
	if got, want := res.Rows[0].Value, 320.0; got != want {
		t.Errorf("avg=%v want %v", got, want)
	}

	// distinct_count of level should be 1 (all "INFO").
	res, _ = b.GetSummary(context.Background(), SummaryQuery{
		Range: rng, AggFn: AggDistinctCount, AggField: "level",
	})
	if res.Rows[0].Value != 1 {
		t.Errorf("distinct_count level=%v", res.Rows[0].Value)
	}
}

func TestMemory_distribution(t *testing.T) {
	b := NewMemoryBackend()
	defer b.Close()
	start := seedMem(t, b)
	rng := Range{From: start, To: start.Add(time.Minute)}

	res, _ := b.GetDistribution(context.Background(), DistributionQuery{
		Range: rng, BucketSeconds: 3,
	})
	// 10 events at 1s steps → buckets [0..2]:3, [3..5]:3, [6..8]:3, [9..11]:1.
	if len(res.Buckets) != 4 {
		t.Fatalf("buckets=%d", len(res.Buckets))
	}
	wantCounts := []int64{3, 3, 3, 1}
	for i, b := range res.Buckets {
		if b.Count != wantCounts[i] {
			t.Errorf("bucket[%d]=%d, want %d", i, b.Count, wantCounts[i])
		}
	}
}

func TestMemory_topValues(t *testing.T) {
	b := NewMemoryBackend()
	defer b.Close()
	start := seedMem(t, b)
	rng := Range{From: start, To: start.Add(time.Minute)}

	res, _ := b.GetTopValues(context.Background(), TopValuesQuery{
		Range: rng, Field: "sourcetype", Limit: 5,
	})
	if len(res.Values) != 2 {
		t.Fatalf("got %d", len(res.Values))
	}
	if res.Values[0].Count != 5 || res.Values[1].Count != 5 {
		t.Errorf("top=%+v", res.Values)
	}

	res, _ = b.GetTopValues(context.Background(), TopValuesQuery{
		Range: rng, Field: "status_code", Limit: 5,
	})
	got := map[string]int64{}
	for _, v := range res.Values {
		got[v.Value] = v.Count
	}
	if got["200"] != 6 || got["500"] != 4 {
		t.Errorf("top status_code=%+v", got)
	}
}

func TestMemory_emptyResultsAreEmptySlices(t *testing.T) {
	b := NewMemoryBackend()
	defer b.Close()
	res, _ := b.GetTopValues(context.Background(), TopValuesQuery{
		Range: Range{From: time.Now(), To: time.Now().Add(time.Hour)}, Field: "anything",
	})
	if res.Values == nil {
		t.Fatalf("Values must be non-nil empty slice, got nil")
	}
	rs, _ := b.GetSummary(context.Background(), SummaryQuery{
		Range: Range{From: time.Now(), To: time.Now().Add(time.Hour)},
		AggFn: AggCount, GroupBy: "host",
	})
	if rs.Rows == nil {
		t.Fatalf("Rows must be non-nil empty slice, got nil")
	}
}
