package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// memBackend is a CGO-free Backend implementation used by the server tests so
// they pass on `CGO_ENABLED=0 go test ./pkg/search/`. Production wires the
// server to NewDuckDBBackend.
type memBackend struct {
	mu     sync.Mutex
	events []Event
}

func (m *memBackend) Ingest(_ context.Context, evs []Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, evs...)
	return nil
}
func (m *memBackend) GetRaw(_ context.Context, q RawQuery) (RawResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var matched []Event
	for _, e := range m.events {
		if (e.Time.Equal(q.From) || e.Time.After(q.From)) && e.Time.Before(q.To) {
			matched = append(matched, e)
		}
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	end := q.Offset + limit
	if end > len(matched) {
		end = len(matched)
	}
	if q.Offset > len(matched) {
		q.Offset = len(matched)
	}
	return RawResult{Events: matched[q.Offset:end], Total: int64(len(matched))}, nil
}
func (m *memBackend) GetSummary(_ context.Context, _ SummaryQuery) (SummaryResult, error) {
	return SummaryResult{Rows: []SummaryRow{{Value: float64(len(m.events))}}}, nil
}
func (m *memBackend) GetDistribution(_ context.Context, _ DistributionQuery) (DistributionResult, error) {
	return DistributionResult{}, nil
}
func (m *memBackend) GetTopValues(_ context.Context, _ TopValuesQuery) (TopValuesResult, error) {
	return TopValuesResult{}, nil
}
func (m *memBackend) Stats(_ context.Context) (Stats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := Stats{EventCount: int64(len(m.events))}
	if len(m.events) > 0 {
		s.OldestEvent = m.events[0].Time
		s.NewestEvent = m.events[len(m.events)-1].Time
	}
	return s, nil
}
func (m *memBackend) Close() error { return nil }

func newMemServer() (*httptest.Server, *Registry) {
	reg := NewRegistry(func() (Backend, error) { return &memBackend{}, nil })
	return httptest.NewServer(NewServer(reg).Handler()), reg
}

func TestServer_createListDeleteDB(t *testing.T) {
	ts, _ := newMemServer()
	defer ts.Close()

	// Create with explicit code.
	body := bytes.NewBufferString(`{"code":"abc123"}`)
	resp, err := http.Post(ts.URL+"/dbs", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d", resp.StatusCode)
	}

	// Duplicate → 409.
	body = bytes.NewBufferString(`{"code":"abc123"}`)
	resp, _ = http.Post(ts.URL+"/dbs", "application/json", body)
	if resp.StatusCode != 409 {
		t.Errorf("dup create: got %d, want 409", resp.StatusCode)
	}

	// Bad code → 400.
	body = bytes.NewBufferString(`{"code":"BAD"}`)
	resp, _ = http.Post(ts.URL+"/dbs", "application/json", body)
	if resp.StatusCode != 400 {
		t.Errorf("bad create: got %d, want 400", resp.StatusCode)
	}

	// Auto code (no body).
	resp, _ = http.Post(ts.URL+"/dbs", "application/json", nil)
	if resp.StatusCode != 201 {
		t.Errorf("auto create: got %d", resp.StatusCode)
	}
	var auto struct{ Code string }
	json.NewDecoder(resp.Body).Decode(&auto)
	resp.Body.Close()
	if matched, _ := NormalizeCode(auto.Code); matched != auto.Code {
		t.Errorf("auto code %q didn't normalise", auto.Code)
	}

	// List.
	resp, _ = http.Get(ts.URL + "/dbs")
	var list struct{ DBs []Snapshot `json:"dbs"` }
	json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if len(list.DBs) != 2 {
		t.Errorf("list has %d dbs, want 2", len(list.DBs))
	}

	// Delete.
	req, _ := http.NewRequest("DELETE", ts.URL+"/dbs/abc123", nil)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 204 {
		t.Errorf("delete: %d", resp.StatusCode)
	}
}

func TestServer_HECIngestAndQuery(t *testing.T) {
	ts, _ := newMemServer()
	defer ts.Close()

	// HEC ingest auto-creates the db.
	body := strings.Join([]string{
		`{"time":1700000000,"event":"hello","host":"h"}`,
		`{"time":1700000001,"event":"world","host":"h"}`,
	}, "\n") + "\n"
	resp, err := http.Post(ts.URL+"/dbs/abc123/services/collector/event",
		"application/x-ndjson", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("ingest: %d %s", resp.StatusCode, string(b))
	}

	// IR get_raw without explicit time range falls back to a wide window.
	resp, err = http.Post(ts.URL+"/dbs/abc123/get_raw", "application/json",
		strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	var got RawResult
	json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if got.Total != 2 {
		t.Errorf("Total = %d, want 2", got.Total)
	}
	if len(got.Events) != 2 {
		t.Errorf("Events = %d", len(got.Events))
	}

	// 404 for unknown db on read.
	resp, _ = http.Post(ts.URL+"/dbs/zzzzzz/get_raw", "application/json",
		strings.NewReader(`{}`))
	if resp.StatusCode != 404 {
		t.Errorf("missing db: got %d, want 404", resp.StatusCode)
	}
}

func TestServer_summaryFromBody(t *testing.T) {
	ts, _ := newMemServer()
	defer ts.Close()

	// Pre-create + ingest one event.
	http.Post(ts.URL+"/dbs", "application/json", strings.NewReader(`{"code":"sumtst"}`))
	http.Post(ts.URL+"/dbs/sumtst/services/collector/event", "application/x-ndjson",
		strings.NewReader(`{"time":1700000000,"event":"x"}`+"\n"))

	body := fmt.Sprintf(`{"from":%q,"to":%q,"agg_fn":"count"}`,
		time.Unix(1699999999, 0).UTC().Format(time.RFC3339Nano),
		time.Unix(1700000001, 0).UTC().Format(time.RFC3339Nano),
	)
	resp, _ := http.Post(ts.URL+"/dbs/sumtst/get_summary", "application/json",
		strings.NewReader(body))
	if resp.StatusCode != 200 {
		t.Fatalf("summary: %d", resp.StatusCode)
	}
}

func TestRegistry_GetOrCreateRace(t *testing.T) {
	calls := 0
	reg := NewRegistry(func() (Backend, error) {
		calls++
		return &memBackend{}, nil
	})
	const code = "racing"

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := reg.GetOrCreate(code); err != nil {
				t.Errorf("GetOrCreate: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls != 1 {
		t.Errorf("factory called %d times, want 1", calls)
	}
}

func TestRegistry_NotFound(t *testing.T) {
	reg := NewRegistry(func() (Backend, error) { return &memBackend{}, nil })
	if _, err := reg.Get("missin"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get(missing) = %v, want ErrNotFound", err)
	}
}
