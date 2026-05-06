//go:build cgo

package search

import (
	"context"
	"testing"
	"time"
)

func mustDB(t *testing.T) *DuckDBBackend {
	t.Helper()
	b, err := NewDuckDBBackend()
	if err != nil {
		t.Fatalf("NewDuckDBBackend: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b
}

// fixture seeds 10 events across two sourcetypes with status_code in fields,
// timestamps stepped by 1s. Used by every IR test below.
func seed(t *testing.T, b *DuckDBBackend) (start time.Time) {
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
			ID:         time.Now().Format(time.RFC3339Nano),
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

func TestDuckDB_ingestAndStats(t *testing.T) {
	b := mustDB(t)
	start := seed(t, b)
	s, err := b.Stats(context.Background())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if s.EventCount != 10 {
		t.Errorf("EventCount = %d, want 10", s.EventCount)
	}
	if !s.OldestEvent.Equal(start) {
		t.Errorf("OldestEvent = %v, want %v", s.OldestEvent, start)
	}
	if !s.NewestEvent.Equal(start.Add(9 * time.Second)) {
		t.Errorf("NewestEvent = %v, want %v", s.NewestEvent, start.Add(9*time.Second))
	}
}

func TestDuckDB_getRaw_paging(t *testing.T) {
	b := mustDB(t)
	start := seed(t, b)
	q := RawQuery{
		Range: Range{From: start, To: start.Add(time.Minute)},
		Limit: 3,
	}
	res, err := b.GetRaw(context.Background(), q)
	if err != nil {
		t.Fatalf("GetRaw: %v", err)
	}
	if res.Total != 10 {
		t.Errorf("Total = %d, want 10", res.Total)
	}
	if len(res.Events) != 3 {
		t.Errorf("len(Events) = %d, want 3", len(res.Events))
	}
	// Ordered by time ascending.
	if !res.Events[0].Time.Equal(start) {
		t.Errorf("first event time = %v, want %v", res.Events[0].Time, start)
	}
	if !res.Events[2].Time.Equal(start.Add(2 * time.Second)) {
		t.Errorf("third event time = %v", res.Events[2].Time)
	}

	q.Offset = 3
	res2, _ := b.GetRaw(context.Background(), q)
	if !res2.Events[0].Time.Equal(start.Add(3 * time.Second)) {
		t.Errorf("offset=3 first event time = %v", res2.Events[0].Time)
	}
}

func TestDuckDB_summary(t *testing.T) {
	b := mustDB(t)
	start := seed(t, b)
	rng := Range{From: start, To: start.Add(time.Minute)}

	// count, no group by → single row, value=10.
	res, err := b.GetSummary(context.Background(), SummaryQuery{Range: rng, AggFn: AggCount})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0].Value != 10 {
		t.Fatalf("count rows = %+v", res.Rows)
	}

	// count grouped by sourcetype → two rows.
	res, err = b.GetSummary(context.Background(), SummaryQuery{
		Range: rng, AggFn: AggCount, GroupBy: "sourcetype",
	})
	if err != nil {
		t.Fatalf("count by st: %v", err)
	}
	got := map[string]float64{}
	for _, r := range res.Rows {
		got[r.Group] = r.Value
	}
	if got["nodejs"] != 5 || got["mysql"] != 5 {
		t.Errorf("by sourcetype = %+v", got)
	}

	// avg over a JSON field.
	res, err = b.GetSummary(context.Background(), SummaryQuery{
		Range: rng, AggFn: AggAvg, AggField: "status_code",
	})
	if err != nil {
		t.Fatalf("avg: %v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("avg rows = %+v", res.Rows)
	}
	// 4 of 10 have status 500 (i=0,3,6,9), 6 have 200. avg = (4*500 + 6*200)/10 = 320.
	if want := 320.0; res.Rows[0].Value != want {
		t.Errorf("avg status_code = %v, want %v", res.Rows[0].Value, want)
	}
}

func TestDuckDB_distribution(t *testing.T) {
	b := mustDB(t)
	start := seed(t, b)
	rng := Range{From: start, To: start.Add(time.Minute)}

	res, err := b.GetDistribution(context.Background(), DistributionQuery{
		Range: rng, BucketSeconds: 3,
	})
	if err != nil {
		t.Fatalf("distribution: %v", err)
	}
	// 10 events stepped 1s, bucketed at 3s → buckets at 0–2 (3), 3–5 (3), 6–8 (3), 9 (1).
	if len(res.Buckets) != 4 {
		t.Fatalf("got %d buckets, want 4: %+v", len(res.Buckets), res.Buckets)
	}
	wantCounts := []int64{3, 3, 3, 1}
	for i, b := range res.Buckets {
		if b.Count != wantCounts[i] {
			t.Errorf("bucket[%d].Count = %d, want %d", i, b.Count, wantCounts[i])
		}
	}
}

func TestDuckDB_topValues(t *testing.T) {
	b := mustDB(t)
	start := seed(t, b)
	rng := Range{From: start, To: start.Add(time.Minute)}

	res, err := b.GetTopValues(context.Background(), TopValuesQuery{
		Range: rng, Field: "sourcetype", Limit: 5,
	})
	if err != nil {
		t.Fatalf("top_values: %v", err)
	}
	if len(res.Values) != 2 {
		t.Fatalf("got %d values, want 2", len(res.Values))
	}
	if res.Values[0].Count != 5 || res.Values[1].Count != 5 {
		t.Errorf("counts = %+v", res.Values)
	}

	// JSON field path.
	res, err = b.GetTopValues(context.Background(), TopValuesQuery{
		Range: rng, Field: "status_code", Limit: 5,
	})
	if err != nil {
		t.Fatalf("top_values status: %v", err)
	}
	got := map[string]int64{}
	for _, v := range res.Values {
		got[v.Value] = v.Count
	}
	if got["200"] != 6 || got["500"] != 4 {
		t.Errorf("top values = %+v", got)
	}
}
