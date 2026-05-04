package run

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
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
