package run

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/nikhilm/logsim2/pkg/apihelp"
)

// loadTestScenario returns a YAML-on-disk scenario the api can parse end to end.
func loadTestScenario(t *testing.T) string {
	t.Helper()
	body, err := os.ReadFile("../../scenarios/web-service.yaml")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return string(body)
}

// post runs Handler on a synthesized request and returns the parsed NDJSON
// frames so tests can assert on the wire shape.
func post(t *testing.T, req Request) []map[string]any {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/run", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	Handler(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var frames []map[string]any
	dec := json.NewDecoder(rec.Body)
	for {
		var frame map[string]any
		if err := dec.Decode(&frame); err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("decode frame: %v", err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// Happy path: a small request fits comfortably under the budget and ends
// with a `done` frame, not a `partial` one.
func TestHandler_FitsUnderBudget(t *testing.T) {
	yaml := loadTestScenario(t)
	frames := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       5,
		TickIntervalMs: 1000,
		Seed:           42,
	})

	last := frames[len(frames)-1]
	if last["done"] != true {
		t.Fatalf("last frame should be done; got %v", last)
	}
	for _, f := range frames[:len(frames)-1] {
		if _, ok := f["partial"]; ok {
			t.Errorf("did not expect partial frames under budget; got %v", f)
		}
	}
}

// Tight-budget path: with a tiny budget the handler should bail before the
// requested duration and emit `partial` with a next_tick that moves forward
// from where we started — so the client can resume cleanly.
func TestHandler_PartialFrameWhenBudgetExhausted(t *testing.T) {
	original := maxResponseBytes
	maxResponseBytes = 1024 // ~1 KiB; one or two ticks of NDJSON tops
	t.Cleanup(func() { maxResponseBytes = original })

	yaml := loadTestScenario(t)
	frames := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       50,
		TickIntervalMs: 1000,
		Seed:           42,
	})

	last := frames[len(frames)-1]
	if last["partial"] != true {
		t.Fatalf("expected partial frame at small budget; got last=%v (frames=%d)", last, len(frames))
	}
	nextTick, ok := last["next_tick"].(float64)
	if !ok {
		t.Fatalf("partial frame missing numeric next_tick: %v", last)
	}
	if nextTick <= 0 {
		t.Errorf("next_tick should advance past 0, got %v", nextTick)
	}
	if nextTick >= 50 {
		t.Errorf("next_tick should be inside the requested range, got %v", nextTick)
	}
	if _, hasDone := last["done"]; hasDone {
		t.Errorf("partial frame should not also carry done; got %v", last)
	}
}

// Forward mode without a destination is a 400 — there's nowhere to send.
func TestHandler_ForwardRequiresDestination(t *testing.T) {
	yaml := loadTestScenario(t)
	body, _ := json.Marshal(Request{
		ScenarioYAML:   yaml,
		Duration:       5,
		TickIntervalMs: 1000,
		Mode:           "forward",
	})
	r := httptest.NewRequest(http.MethodPost, "/api/run", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	Handler(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "destination") {
		t.Errorf("error body should mention destination requirement, got %q", rec.Body.String())
	}
}

// Forward mode posts every batch to the configured HEC endpoint and emits a
// progress trace + closing summary. We stub HEC with an httptest server,
// run a small scenario, and verify the response contains start/post/done
// frames with consistent counts.
func TestHandler_ForwardEndToEnd(t *testing.T) {
	var hits int32
	hec := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer hec.Close()

	yaml := loadTestScenario(t)
	frames := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       10,
		TickIntervalMs: 1000,
		Seed:           42,
		Mode:           "forward",
		Cribl: &apihelp.CriblConfig{
			Enabled: true,
			URL:     hec.URL,
			Token:   "test-token",
		},
	})

	if len(frames) < 2 {
		t.Fatalf("expected at least start+done, got %d frames", len(frames))
	}
	if frames[0]["type"] != "start" {
		t.Errorf("first frame should be start, got %v", frames[0])
	}
	last := frames[len(frames)-1]
	if last["type"] != "done" {
		t.Fatalf("last frame should be done, got %v", last)
	}
	produced := int(last["events_produced"].(float64))
	sent := int(last["events_sent"].(float64))
	if produced == 0 {
		t.Errorf("expected non-zero events_produced, got %d", produced)
	}
	if sent != produced {
		t.Errorf("events_sent (%d) should equal events_produced (%d) when no batches fail", sent, produced)
	}
	if int(last["batches_failed"].(float64)) != 0 {
		t.Errorf("expected zero failed batches against a 200-OK stub, got %v", last["batches_failed"])
	}
	bySource, ok := last["by_source"].(map[string]any)
	if !ok || len(bySource) == 0 {
		t.Errorf("by_source should be populated, got %v", last["by_source"])
	}
	// At least one POST must have hit the stub.
	if atomic.LoadInt32(&hits) == 0 {
		t.Errorf("expected the HEC stub to receive at least one POST")
	}
	// At least one post-frame should have arrived between start and done.
	sawPost := false
	for _, f := range frames[1 : len(frames)-1] {
		if f["type"] == "post" {
			sawPost = true
			if _, hasStatus := f["status"]; !hasStatus {
				t.Errorf("post frame missing status field: %v", f)
			}
		}
	}
	if !sawPost {
		t.Errorf("expected at least one post frame in the stream")
	}
}

// Forward mode honors start_tick: the engine begins at the requested tick
// and the by_source counts only reflect the windowed range. Two contiguous
// chunks should together produce the same total events as a single full
// run (modulo deterministic engine RNG-restart-per-request).
func TestHandler_ForwardChunkedRespectsStartTick(t *testing.T) {
	hec := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer hec.Close()

	yaml := loadTestScenario(t)
	cribl := &apihelp.CriblConfig{Enabled: true, URL: hec.URL, Token: "tok"}

	// Run a chunk covering ticks [0, 5).
	first := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       5,
		TickIntervalMs: 1000,
		Seed:           42,
		Mode:           "forward",
		Cribl:          cribl,
		StartTick:      0,
	})
	firstDone := first[len(first)-1]
	if firstDone["type"] != "done" {
		t.Fatalf("first chunk did not end with done: %v", firstDone)
	}
	firstProduced := int(firstDone["events_produced"].(float64))
	if firstProduced == 0 {
		t.Fatalf("first chunk produced 0 events, expected some")
	}

	// Run a second chunk covering ticks [5, 10).
	second := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       10,
		TickIntervalMs: 1000,
		Seed:           42,
		Mode:           "forward",
		Cribl:          cribl,
		StartTick:      5,
	})
	secondDone := second[len(second)-1]
	if secondDone["type"] != "done" {
		t.Fatalf("second chunk did not end with done: %v", secondDone)
	}
	secondProduced := int(secondDone["events_produced"].(float64))
	if secondProduced == 0 {
		t.Fatalf("second chunk produced 0 events; start_tick may be ignored")
	}

	// Sanity: a single 0..10 run should produce roughly the sum of both
	// chunks (RNG restarts per request, so it's not exact, but the order
	// of magnitude must match — within a tick's worth of variance is fine).
	full := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       10,
		TickIntervalMs: 1000,
		Seed:           42,
		Mode:           "forward",
		Cribl:          cribl,
		StartTick:      0,
	})
	fullProduced := int(full[len(full)-1]["events_produced"].(float64))
	chunkedTotal := firstProduced + secondProduced
	if abs(fullProduced-chunkedTotal) > fullProduced/4 {
		t.Errorf("chunked total (%d) deviates from full run (%d) by more than 25%%",
			chunkedTotal, fullProduced)
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Forward mode reports HEC failures: if the destination returns 4xx, the
// sink drops the batch and the summary's batches_failed counter advances.
func TestHandler_ForwardSurfacesHECFailures(t *testing.T) {
	hec := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer hec.Close()

	yaml := loadTestScenario(t)
	frames := post(t, Request{
		ScenarioYAML:   yaml,
		Duration:       5,
		TickIntervalMs: 1000,
		Seed:           42,
		Mode:           "forward",
		Cribl: &apihelp.CriblConfig{
			Enabled: true,
			URL:     hec.URL,
			Token:   "bad-token",
		},
	})

	last := frames[len(frames)-1]
	if last["type"] != "done" {
		t.Fatalf("last frame should be done even when batches fail, got %v", last)
	}
	failed := int(last["batches_failed"].(float64))
	if failed == 0 {
		t.Errorf("expected at least one failed batch against a 401 stub, got %d", failed)
	}
	// Some post frame should carry an err / non-2xx status.
	sawErr := false
	for _, f := range frames {
		if f["type"] != "post" {
			continue
		}
		if _, hasErr := f["err"]; hasErr {
			sawErr = true
			break
		}
	}
	if !sawErr {
		t.Errorf("expected at least one post frame with err set")
	}
}
