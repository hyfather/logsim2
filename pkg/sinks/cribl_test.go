package sinks

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
)

func makeEntries(n int) []event.LogEntry {
	entries := make([]event.LogEntry, n)
	for i := range entries {
		entries[i] = event.LogEntry{
			ID:         "id",
			Sourcetype: "nodejs",
			Raw:        "log line",
		}
	}
	return entries
}

// collectingServer returns a test server that records every request body.
func collectingServer(t *testing.T) (*httptest.Server, *[]string, *int32) {
	t.Helper()
	var bodies []string
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"text":"Success","code":0}`))
	}))
	return srv, &bodies, &hits
}

func TestCribl_AuthHeader(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := NewCribl(srv.URL, "my-token", 10, 0)
	if err := s.Write(makeEntries(10)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	if gotAuth != "Splunk my-token" {
		t.Errorf("Authorization header: got %q, want %q", gotAuth, "Splunk my-token")
	}
}

func TestCribl_Batching(t *testing.T) {
	srv, bodies, hits := collectingServer(t)
	defer srv.Close()

	s := NewCribl(srv.URL, "tok", 5, 0)
	// Write 12 entries: expect 2 batches of 5, remainder buffered.
	if err := s.Write(makeEntries(12)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if atomic.LoadInt32(hits) != 2 {
		t.Errorf("expected 2 HTTP requests for 12 entries with batchSize=5, got %d", atomic.LoadInt32(hits))
	}

	// Flush the remaining 2.
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if atomic.LoadInt32(hits) != 3 {
		t.Errorf("expected 3 total HTTP requests after close, got %d", atomic.LoadInt32(hits))
	}

	// Each body should be valid ndjson with the right count.
	lineCounts := []int{5, 5, 2}
	for i, body := range *bodies {
		lines := strings.Split(strings.TrimSpace(body), "\n")
		if len(lines) != lineCounts[i] {
			t.Errorf("batch %d: expected %d lines, got %d", i, lineCounts[i], len(lines))
		}
		// Each line should be valid JSON.
		for _, l := range lines {
			var v map[string]any
			if err := json.Unmarshal([]byte(l), &v); err != nil {
				t.Errorf("batch %d: invalid JSON line %q: %v", i, l, err)
			}
		}
	}
}

func TestCribl_HECEnvelope(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	entry := event.LogEntry{
		ID:         "abc",
		TS:         "2026-04-21T03:11:38.110Z",
		Source:     "prod.vpc.subnet.host.app",
		Level:      "INFO",
		Sourcetype: "mysql",
		Raw:        "hello world",
	}
	s := NewCribl(srv.URL, "tok", 1, 0)
	_ = s.Write([]event.LogEntry{entry})
	_ = s.Close()

	var env map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(gotBody)), &env); err != nil {
		t.Fatalf("unmarshal HEC envelope: %v", err)
	}
	// sourcetype must be mapped to Splunk convention (mysql → mysql:query),
	// not the raw generator name.
	if env["sourcetype"] != "mysql:query" {
		t.Errorf("sourcetype: got %v, want mysql:query", env["sourcetype"])
	}
	if env["host"] != "prod.vpc.subnet.host.app" {
		t.Errorf("host: got %v, want channel path", env["host"])
	}
	if env["source"] != "prod.vpc.subnet.host.app" {
		t.Errorf("source: got %v, want channel path", env["source"])
	}
	if env["index"] != "main" {
		t.Errorf("index: got %v, want main", env["index"])
	}
	// event must be the raw log string (so _raw in Splunk is the log line,
	// not a nested JSON blob).
	if env["event"] != "hello world" {
		t.Errorf("event: got %v, want raw log string", env["event"])
	}
	// indexed fields must carry the channel/level/generator metadata
	fields, ok := env["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields: want object, got %T", env["fields"])
	}
	if fields["channel"] != "prod.vpc.subnet.host.app" {
		t.Errorf("fields.channel: got %v", fields["channel"])
	}
	if fields["level"] != "INFO" {
		t.Errorf("fields.level: got %v", fields["level"])
	}
	if fields["generator"] != "mysql" {
		t.Errorf("fields.generator: got %v", fields["generator"])
	}
	if fields["id"] != "abc" {
		t.Errorf("fields.id: got %v", fields["id"])
	}
	// time must be epoch seconds (float), not an ISO string
	if _, ok := env["time"].(float64); !ok {
		t.Errorf("time: want float64 epoch seconds, got %T (%v)", env["time"], env["time"])
	}
}

func TestCribl_RetryOn5xx(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := NewCribl(srv.URL, "tok", 1, 0)
	// Override client timeout to allow fast retries in tests.
	s.client = &http.Client{Timeout: 5 * time.Second}
	_ = s.Write(makeEntries(1))
	_ = s.Close()

	if atomic.LoadInt32(&attempts) != 3 {
		t.Errorf("expected 3 attempts (2 failures + 1 success), got %d", atomic.LoadInt32(&attempts))
	}
}

func TestCribl_DropOn4xx(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusUnauthorized) // permanent failure
	}))
	defer srv.Close()

	s := NewCribl(srv.URL, "bad-token", 1, 0)
	_ = s.Write(makeEntries(1))
	_ = s.Close()

	// Should not retry on 4xx — only 1 attempt.
	if atomic.LoadInt32(&attempts) != 1 {
		t.Errorf("expected 1 attempt for 4xx, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestCribl_FlushInterval(t *testing.T) {
	srv, _, hits := collectingServer(t)
	defer srv.Close()

	s := NewCribl(srv.URL, "tok", 1000, 50) // large batch; flush every 50ms
	_ = s.Write(makeEntries(3))

	// Wait for interval flush.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(hits) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = s.Close()

	if atomic.LoadInt32(hits) == 0 {
		t.Error("expected interval flush to trigger at least one HTTP request")
	}
}
