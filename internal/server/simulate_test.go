package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/internal/event"
)

const minimalYAML = `
- name: Test Scenario
- nodes:
  - type: vpc
    name: Test VPC
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: Test Subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server
    subnet: Test Subnet
    private_ip: 10.0.1.10
  - type: user_clients
    name: Clients
    clients:
      - name: Client 1
        ip: 1.2.3.4
        rps: 5
        traffic_pattern: steady
- services:
  - type: nodejs
    name: App Service
    host: App Server
    generator:
      type: nodejs
      port: 3000
      log_format: json
      endpoints:
        - {method: GET, path: /health, avg_latency_ms: 10, error_rate: 0.0}
- connections:
  - {source: Clients, target: App Service, protocol: http, port: 3000}
`

func newTestServer(t *testing.T) *Server {
	t.Helper()
	return New("*", "")
}

func simulateRequest(yaml string, ticks int, seed int64) *bytes.Buffer {
	body := map[string]any{
		"scenario_yaml": yaml,
		"ticks":         ticks,
		"tick_interval": "1s",
		"seed":          seed,
	}
	b, _ := json.Marshal(body)
	return bytes.NewBuffer(b)
}

func TestSimulate_SSEFraming(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate", simulateRequest(minimalYAML, 3, 42))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	ct := w.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/event-stream") {
		t.Errorf("expected text/event-stream, got %q", ct)
	}

	body := w.Body.String()
	if !strings.Contains(body, "event: batch") {
		t.Error("expected at least one 'event: batch' SSE event")
	}
	if !strings.Contains(body, "event: done") {
		t.Error("expected terminal 'event: done' SSE event")
	}
}

func TestSimulate_BatchesContainLogEntries(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate", simulateRequest(minimalYAML, 3, 1))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	// Parse SSE events.
	var batches [][]event.LogEntry
	scanner := bufio.NewScanner(strings.NewReader(w.Body.String()))
	var currentEvent string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			currentEvent = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") && currentEvent == "batch" {
			data := strings.TrimPrefix(line, "data: ")
			var entries []event.LogEntry
			if err := json.Unmarshal([]byte(data), &entries); err != nil {
				t.Errorf("unmarshal batch: %v (data: %s)", err, data)
				continue
			}
			batches = append(batches, entries)
			currentEvent = ""
		}
	}

	if len(batches) == 0 {
		t.Fatal("no batches received")
	}
	total := 0
	for _, b := range batches {
		total += len(b)
	}
	t.Logf("received %d batches, %d total entries", len(batches), total)
	if total == 0 {
		t.Error("expected log entries in batches")
	}
}

func TestSimulate_InvalidBody(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate", strings.NewReader(`not json`))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSimulate_MissingScenario(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	body := `{"ticks":3}`
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestSimulate_ClientDisconnect(t *testing.T) {
	// Use a channel-based approach: start with many ticks but cancel quickly.
	srv := newTestServer(t)

	body := map[string]any{
		"scenario_yaml": minimalYAML,
		"ticks":         1000,
		"tick_interval": "1ms", // fast, so we produce output quickly
		"seed":          99,
	}
	b, _ := json.Marshal(body)

	// httptest.Recorder doesn't support streaming + cancellation cleanly,
	// so use a real server + http.Client.
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Post(ts.URL+"/v1/simulate", "application/json", bytes.NewBuffer(b))
	if err != nil {
		// Timeout is expected — the client cancelled.
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}
