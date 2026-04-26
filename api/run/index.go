// Package run hosts the Vercel Lambda for streaming a full episode.
//
// Returns NDJSON: one frame per tick plus a final summary frame. The frontend
// renders incrementally as frames arrive, so there's no wait for the whole
// episode before logs appear.
package run

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/apihelp"
	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// maxTicksPerRunRequest caps the streaming run so a runaway client can't pin
// a worker indefinitely. 600 ticks at 1s ticks is 10 simulated minutes — more
// than enough for the timeline UI's typical episode lengths.
const maxTicksPerRunRequest = 600

// Request streams logs for an entire episode. duration and tick_interval_ms
// are read from the request first, then from the scenario YAML as fallback.
type Request struct {
	ScenarioYAML   string               `json:"scenario_yaml"`
	Duration       int                  `json:"duration"`
	TickIntervalMs int                  `json:"tick_interval_ms"`
	StartTimeMs    int64                `json:"start_time_ms"`
	Seed           int64                `json:"seed"`
	SourceFilter   string               `json:"source_filter"`
	// Rate paces the run to wall-clock: 1.0 emits at simulated speed, 8.0
	// burns 8× faster, 0 means as fast as possible (no sleeping).
	Rate  float64              `json:"rate,omitempty"`
	Cribl *apihelp.CriblConfig `json:"cribl,omitempty"`
}

// Handler streams NDJSON: one frame per tick plus a final summary frame.
//
// Frame shapes (each ends with a newline):
//
//	{"tick":N,"ts":<unix_ms>,"logs":[...]}
//	{"done":true,"total_logs":M}
//	{"error":"..."}                          // emitted instead of "done" on failure
//
// We stream over POST because the scenario YAML is multi-KB — too large for
// query params or an SSE GET.
func Handler(w http.ResponseWriter, r *http.Request) {
	apihelp.SetCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		apihelp.WriteErr(w, http.StatusMethodNotAllowed, "POST required")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		apihelp.WriteErr(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		apihelp.WriteErr(w, http.StatusBadRequest, "decode: "+err.Error())
		return
	}
	if req.ScenarioYAML == "" {
		apihelp.WriteErr(w, http.StatusBadRequest, "scenario_yaml is required")
		return
	}

	sc, err := scenario.Parse(strings.NewReader(req.ScenarioYAML))
	if err != nil {
		apihelp.WriteErr(w, http.StatusBadRequest, "parse scenario: "+err.Error())
		return
	}
	if err := scenario.Validate(sc); err != nil {
		apihelp.WriteErr(w, http.StatusBadRequest, "validate scenario: "+err.Error())
		return
	}

	duration := req.Duration
	if duration <= 0 {
		duration = sc.Duration
	}
	if duration <= 0 {
		duration = 60
	}
	if duration > maxTicksPerRunRequest {
		duration = maxTicksPerRunRequest
	}
	tickInterval := req.TickIntervalMs
	if tickInterval <= 0 {
		tickInterval = sc.TickIntervalMs
	}
	if tickInterval <= 0 {
		tickInterval = 1000
	}

	start := time.Now()
	if req.StartTimeMs > 0 {
		start = time.UnixMilli(req.StartTimeMs)
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	// Disables proxy buffering on platforms that honor it (nginx, some Vercel
	// configurations). Without this, frames pile up until the response ends.
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)

	eng := engine.New(sc, engine.Config{
		Seed:           req.Seed,
		StartTime:      start,
		TickIntervalMs: tickInterval,
		Rate:           req.Rate,
		SourceFilter:   req.SourceFilter,
	})

	stream := &streamSink{
		enc:     enc,
		flusher: flusher,
		start:   start,
		tickMs:  tickInterval,
	}

	if err := eng.Run(r.Context(), duration, []sinks.Sink{stream}); err != nil {
		_ = enc.Encode(map[string]any{"error": err.Error()})
		return
	}
	_ = enc.Encode(map[string]any{"done": true, "total_logs": stream.total})
	if flusher != nil {
		flusher.Flush()
	}

	if req.Cribl != nil && req.Cribl.Enabled && req.Cribl.URL != "" && req.Cribl.Token != "" && len(stream.collected) > 0 {
		_ = forwardToCribl(req.Cribl, stream.collected)
	}
}

// streamSink emits one NDJSON frame per tick. Engine.Run calls Write once per
// tick (after sorting that tick's logs by timestamp), which lets the client
// render incrementally.
type streamSink struct {
	enc       *json.Encoder
	flusher   http.Flusher
	start     time.Time
	tickMs    int
	tick      int
	total     int
	collected []event.LogEntry
}

func (s *streamSink) Write(entries []event.LogEntry) error {
	tickIdx := s.tick
	s.tick++
	frame := map[string]any{
		"tick": tickIdx,
		"ts":   s.start.Add(time.Duration(tickIdx)*time.Duration(s.tickMs)*time.Millisecond).UnixMilli(),
		"logs": entries,
	}
	if err := s.enc.Encode(frame); err != nil {
		return err
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	s.total += len(entries)
	if len(entries) > 0 {
		s.collected = append(s.collected, entries...)
	}
	return nil
}

func (s *streamSink) Flush() error { return nil }
func (s *streamSink) Close() error { return nil }

func forwardToCribl(c *apihelp.CriblConfig, entries []event.LogEntry) error {
	sink := sinks.NewCribl(c.URL, c.Token, len(entries)+1, 0)
	if err := sink.Write(entries); err != nil {
		return err
	}
	return sink.Flush()
}
