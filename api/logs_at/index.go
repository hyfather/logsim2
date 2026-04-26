// Package logs_at hosts the Vercel Lambda for random-access scrub queries.
//
// Re-runs the engine deterministically from tick 0 up to `to`, returning
// only logs in [from, to). Same Seed → same output, so timeline scrubs show
// stable previews.
package logs_at

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

// Mirrors api/run.maxTicksPerRunRequest; kept as a local const so each Lambda
// can ship without cross-Lambda imports.
const maxTicksPerLogsAt = 600

type Request struct {
	ScenarioYAML   string `json:"scenario_yaml"`
	From           int    `json:"from"`
	To             int    `json:"to"`
	TickIntervalMs int    `json:"tick_interval_ms"`
	StartTimeMs    int64  `json:"start_time_ms"`
	Seed           int64  `json:"seed"`
	SourceFilter   string `json:"source_filter"`
}

type Response struct {
	From  int              `json:"from"`
	To    int              `json:"to"`
	Logs  []event.LogEntry `json:"logs"`
	Count int              `json:"count"`
}

// Handler returns the logs that *would* be emitted in the [from, to) tick
// window for a given scenario+seed. Re-runs from tick 0 because the engine's
// RNG is global; the cost scales linearly with `to`.
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
	if req.To <= req.From {
		apihelp.WriteErr(w, http.StatusBadRequest, "to must be > from")
		return
	}
	if req.From < 0 {
		req.From = 0
	}
	if req.To > maxTicksPerLogsAt {
		req.To = maxTicksPerLogsAt
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

	eng := engine.New(sc, engine.Config{
		Seed:           req.Seed,
		StartTime:      start,
		TickIntervalMs: tickInterval,
		SourceFilter:   req.SourceFilter,
	})

	collector := &windowSink{from: req.From}
	if err := eng.Run(r.Context(), req.To, []sinks.Sink{collector}); err != nil {
		apihelp.WriteErr(w, http.StatusInternalServerError, "engine: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(Response{
		From:  req.From,
		To:    req.To,
		Logs:  collector.entries,
		Count: len(collector.entries),
	})
}

// windowSink discards everything before `from` so the full re-run from tick 0
// only retains the slice the caller asked for.
type windowSink struct {
	from    int
	tick    int
	entries []event.LogEntry
}

func (s *windowSink) Write(entries []event.LogEntry) error {
	if s.tick >= s.from {
		s.entries = append(s.entries, entries...)
	}
	s.tick++
	return nil
}
func (s *windowSink) Flush() error { return nil }
func (s *windowSink) Close() error { return nil }
