// Package run hosts the Vercel Lambda for streaming a full episode.
//
// Returns NDJSON: one frame per tick plus a final summary frame. The frontend
// renders incrementally as frames arrive, so there's no wait for the whole
// episode before logs appear.
package run

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/apihelp"
	"github.com/nikhilm/logsim2/pkg/encoders"
	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// maxTicksPerRunRequest caps the streaming run so a runaway client can't pin
// a worker indefinitely. 600 ticks at 1s ticks is 10 simulated minutes — more
// than enough for the timeline UI's typical episode lengths.
const maxTicksPerRunRequest = 600

// maxResponseBytes is a soft cap on a single /api/run NDJSON response.
// Vercel's function runtime rejects (with HTTP 413) responses larger than
// ~4.5 MiB even when the handler streams them — the platform buffers the
// whole body before returning to the edge. We stop early at 3 MiB so the
// closing "partial" frame plus envelope overhead still fits comfortably.
//
// var (not const) so tests can shrink the budget to exercise the
// partial-frame path against small fixtures.
var maxResponseBytes int64 = 3 << 20

// errBudgetExceeded is the sentinel streamSink returns when the NDJSON body
// passes maxResponseBytes. The handler catches it and emits a partial frame
// so the client can resume the run from the next tick.
var errBudgetExceeded = errors.New("response byte budget exceeded")

// Request streams logs for an entire episode. duration and tick_interval_ms
// are read from the request first, then from the scenario YAML as fallback.
type Request struct {
	ScenarioYAML   string               `json:"scenario_yaml"`
	Duration       int                  `json:"duration"`
	TickIntervalMs int                  `json:"tick_interval_ms"`
	StartTimeMs    int64                `json:"start_time_ms"`
	Seed           int64                `json:"seed"`
	SourceFilter   string               `json:"source_filter"`
	Cribl          *apihelp.CriblConfig `json:"cribl,omitempty"`
	// Format selects the schema applied to each entry's Raw field before
	// streaming. "native" (default) preserves the generator's own log line;
	// "ocsf" replaces it with an OCSF v1.x JSON event; "otel" emits an
	// OpenTelemetry OTLP/JSON LogRecord envelope.
	Format string `json:"format,omitempty"`
	// StartTick lets the client resume playback mid-episode. Frames are
	// emitted starting at this tick index; if it's >= duration the run
	// completes immediately with no logs.
	StartTick int `json:"start_tick,omitempty"`
	// Mode selects the response shape:
	//   "" (default) — per-tick log frames, suitable for the realtime UI.
	//   "forward"   — backend forwards events directly to the cribl
	//                 destination and streams progress only (no log
	//                 frames). Mirrors `logsim run --to <dest>`. Cribl
	//                 must be configured.
	Mode string `json:"mode,omitempty"`
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

	// Forward mode runs the full episode flat-out into a HEC sink and
	// streams progress instead of log frames. The streaming path caps
	// per-request at maxTicksPerRunRequest and chunks client-side; the
	// forward path runs the scenario whole, gated only by the platform's
	// function timeout (no log payload, so size isn't the constraint).
	if req.Mode == "forward" {
		handleForward(w, r, &req, sc)
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
	counter := &byteCounter{w: w}
	enc := json.NewEncoder(counter)
	enc.SetEscapeHTML(false)

	startTick := req.StartTick
	if startTick < 0 {
		startTick = 0
	}
	if startTick > duration {
		startTick = duration
	}

	eng := engine.New(sc, engine.Config{
		Seed:           req.Seed,
		StartTime:      start,
		StartTick:      startTick,
		TickIntervalMs: tickInterval,
		SourceFilter:   req.SourceFilter,
	})

	stream := &streamSink{
		enc:     enc,
		flusher: flusher,
		counter: counter,
		budget:  maxResponseBytes,
		start:   start,
		tickMs:  tickInterval,
		tick:    startTick,
		format:  encoders.Parse(req.Format),
	}

	runErr := eng.Run(r.Context(), duration, []sinks.Sink{stream})
	switch {
	case errors.Is(runErr, errBudgetExceeded):
		// Stopped early to stay under Vercel's response cap. Tell the
		// client where to resume so the next chunk picks up cleanly.
		_ = enc.Encode(map[string]any{
			"partial":    true,
			"next_tick":  stream.tick,
			"total_logs": stream.total,
		})
	case runErr != nil:
		_ = enc.Encode(map[string]any{"error": runErr.Error()})
		return
	default:
		_ = enc.Encode(map[string]any{"done": true, "total_logs": stream.total})
	}
	if flusher != nil {
		flusher.Flush()
	}

	if req.Cribl != nil && req.Cribl.Enabled && req.Cribl.URL != "" && len(stream.collected) > 0 {
		_ = forwardToCribl(req.Cribl, stream.collected)
	}
}

// byteCounter wraps the response writer so streamSink can stop the run before
// the NDJSON body crosses Vercel's response-size threshold.
type byteCounter struct {
	w       io.Writer
	counted int64
}

func (b *byteCounter) Write(p []byte) (int, error) {
	n, err := b.w.Write(p)
	b.counted += int64(n)
	return n, err
}

// streamSink emits one NDJSON frame per tick. Engine.Run calls Write once per
// tick (after sorting that tick's logs by timestamp), which lets the client
// render incrementally.
type streamSink struct {
	enc       *json.Encoder
	flusher   http.Flusher
	counter   *byteCounter // monitors NDJSON body size; nil disables the budget
	budget    int64        // bytes; once counter.counted reaches this, return errBudgetExceeded
	start     time.Time
	tickMs    int
	tick      int
	total     int
	format    encoders.Format
	collected []event.LogEntry
}

func (s *streamSink) Write(entries []event.LogEntry) error {
	tickIdx := s.tick
	s.tick++
	if s.format != encoders.FormatNative {
		entries = encoders.ApplyToRaw(entries, s.format)
	}
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
	// Bail before the next tick if the response is approaching the
	// platform cap. The handler converts this sentinel into a partial
	// frame so the client resumes from s.tick on the next request.
	if s.counter != nil && s.budget > 0 && s.counter.counted >= s.budget {
		return errBudgetExceeded
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

// handleForward runs the engine flat-out, forwards every event to the
// configured Cribl HEC destination, and streams progress NDJSON to the
// client. Frame shapes:
//
//	{"type":"start","duration":N,"tick_interval_ms":M,"destination":"https://…"}
//	{"type":"post","status":200,"size":50,"duration_ms":42,"attempt":1,"final":true}
//	{"type":"post","status":503,…,"err":"server error 503","final":false}     // retry
//	{"type":"progress","tick":120,"events_produced":6000,"events_sent":5950}
//	{"type":"done","events_produced":N,"events_sent":N,"batches_sent":B,
//	  "batches_failed":F,"by_source":{ "<channel>": <count>, … }}
//	{"type":"error","error":"…"}    // emitted instead of "done" on engine errors
//
// Cribl is required: forward mode without a configured destination is a
// 400. The function timeout (and cribl batch-by-batch retries) is the only
// upper bound on runtime — the response body itself stays tiny because no
// log frames are streamed back.
func handleForward(w http.ResponseWriter, r *http.Request, req *Request, sc *scenario.Scenario) {
	if req.Cribl == nil || !req.Cribl.Enabled || req.Cribl.URL == "" {
		apihelp.WriteErr(w, http.StatusBadRequest, "forward mode requires a configured cribl destination")
		return
	}

	duration := req.Duration
	if duration <= 0 {
		duration = sc.Duration
	}
	if duration <= 0 {
		duration = 60
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
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)

	emit := func(frame map[string]any) {
		_ = enc.Encode(frame)
		if flusher != nil {
			flusher.Flush()
		}
	}

	emit(map[string]any{
		"type":             "start",
		"duration":         duration,
		"tick_interval_ms": tickInterval,
		"destination":      req.Cribl.URL,
	})

	// Build the HEC sink. Batch=500 (the per-destination max) keeps the
	// number of round-trips low — at typical Cribl Cloud HEC latency
	// (~150–300 ms RTT from sfo1) a 1080-tick episode would otherwise
	// burn most of the function timeout on POSTs alone. 0 flush interval
	// means batches go on size only.
	cribl := sinks.NewCriblWithFormat(req.Cribl.URL, req.Cribl.Token, 500, 0, sinks.Format(req.Format))
	cribl.SetName("destination")

	// Each HTTP attempt becomes one "post" frame. The observer fires from
	// the engine goroutine (CriblSink.send is called inline), so the writes
	// are serialized with the engine — no extra synchronization needed.
	cribl.SetObserver(func(res sinks.SendResult) {
		frame := map[string]any{
			"type":        "post",
			"status":      res.StatusCode,
			"size":        res.BatchSize,
			"duration_ms": res.Duration.Milliseconds(),
			"attempt":     res.Attempt,
			"final":       res.Final,
		}
		if res.Err != nil {
			frame["err"] = res.Err.Error()
		}
		emit(frame)
	})

	startTick := req.StartTick
	if startTick < 0 {
		startTick = 0
	}
	if startTick > duration {
		startTick = duration
	}

	forward := &countingForwarder{inner: cribl, bySource: map[string]int{}, tick: startTick}
	// Periodic progress frame so the UI can show a live counter without
	// waiting for `done`. Tied to tick count to keep deterministic behavior
	// across scenarios; ~10 frames is enough for a smooth progress bar.
	span := duration - startTick
	progressEvery := span / 10
	if progressEvery < 5 {
		progressEvery = 5
	}
	forward.onTick = func(tick int) {
		// tick is the absolute tick index within the scenario; emit on the
		// nth tick relative to the chunk's start so chunked runs each get
		// ~10 progress frames.
		if (tick-startTick) > 0 && (tick-startTick)%progressEvery == 0 {
			emit(map[string]any{
				"type":            "progress",
				"tick":            tick,
				"events_produced": forward.totalEvents,
				"events_sent":     cribl.EventsSent(),
			})
		}
	}

	eng := engine.New(sc, engine.Config{
		Seed:           req.Seed,
		StartTime:      start,
		StartTick:      startTick,
		TickIntervalMs: tickInterval,
		SourceFilter:   req.SourceFilter,
	})
	runErr := eng.Run(r.Context(), duration, []sinks.Sink{forward})
	// Flush the trailing partial batch — the observer fires once more for it
	// before Close returns, so the client sees every POST in order.
	_ = cribl.Close()

	if runErr != nil && !errors.Is(runErr, r.Context().Err()) {
		emit(map[string]any{"type": "error", "error": runErr.Error()})
		return
	}

	emit(map[string]any{
		"type":            "done",
		"events_produced": forward.totalEvents,
		"events_sent":     cribl.EventsSent(),
		"batches_sent":    cribl.BatchesSent(),
		"batches_failed":  cribl.BatchesFailed(),
		"by_source":       forward.bySource,
	})
}

// countingForwarder wraps a sink with a per-source counter and a per-tick
// callback so the API can stream progress while the engine is running. tick
// is the absolute tick index within the scenario (set to startTick by the
// handler, advanced once per Write — engine.Run calls Write exactly once per
// tick).
type countingForwarder struct {
	inner       sinks.Sink
	bySource    map[string]int
	totalEvents int
	tick        int
	onTick      func(tick int)
}

func (f *countingForwarder) Write(entries []event.LogEntry) error {
	for i := range entries {
		f.bySource[entries[i].Source]++
	}
	f.totalEvents += len(entries)
	f.tick++
	if err := f.inner.Write(entries); err != nil {
		return err
	}
	if f.onTick != nil {
		f.onTick(f.tick)
	}
	return nil
}

func (f *countingForwarder) Flush() error { return f.inner.Flush() }
func (f *countingForwarder) Close() error { return f.inner.Close() }
