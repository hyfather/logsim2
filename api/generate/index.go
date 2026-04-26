// Package generate hosts the Vercel Lambda for short, bounded log batches.
//
// Used by the legacy single-tick frontend path; the new timeline UI prefers
// /api/run (NDJSON streaming) for full episodes and /api/logs_at for scrubs.
package generate

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

// Hobby execution cap is 10s. A 1s simulated window completes well under that;
// we cap the requested ticks so a pathological client can't push us past it.
const maxTicksPerRequest = 30

type GenerateRequest struct {
	ScenarioYAML   string                `json:"scenario_yaml"`
	Ticks          int                   `json:"ticks"`
	TickIntervalMs int                   `json:"tick_interval_ms"`
	StartTimeMs    int64                 `json:"start_time_ms"`
	Seed           int64                 `json:"seed"`
	SourceFilter   string                `json:"source_filter"`
	Cribl          *apihelp.CriblConfig  `json:"cribl,omitempty"`
}

type GenerateResponse struct {
	Logs         []event.LogEntry `json:"logs"`
	Ticks        int              `json:"ticks"`
	Forwarded    int              `json:"forwarded"`
	ForwardError string           `json:"forward_error,omitempty"`
}

// Handler is the Vercel entrypoint.
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

	var req GenerateRequest
	if err := json.Unmarshal(body, &req); err != nil {
		apihelp.WriteErr(w, http.StatusBadRequest, "decode: "+err.Error())
		return
	}
	if req.ScenarioYAML == "" {
		apihelp.WriteErr(w, http.StatusBadRequest, "scenario_yaml is required")
		return
	}

	if req.Ticks <= 0 {
		req.Ticks = 1
	}
	if req.Ticks > maxTicksPerRequest {
		req.Ticks = maxTicksPerRequest
	}
	if req.TickIntervalMs <= 0 {
		req.TickIntervalMs = 1000
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

	start := time.Now()
	if req.StartTimeMs > 0 {
		start = time.UnixMilli(req.StartTimeMs)
	}

	eng := engine.New(sc, engine.Config{
		Seed:           req.Seed,
		StartTime:      start,
		TickIntervalMs: req.TickIntervalMs,
		SourceFilter:   req.SourceFilter,
	})

	collector := &sliceSink{}
	if err := eng.Run(r.Context(), req.Ticks, []sinks.Sink{collector}); err != nil {
		apihelp.WriteErr(w, http.StatusInternalServerError, "engine: "+err.Error())
		return
	}

	resp := GenerateResponse{Logs: collector.entries, Ticks: req.Ticks}

	if req.Cribl != nil && req.Cribl.Enabled && req.Cribl.URL != "" && req.Cribl.Token != "" && len(collector.entries) > 0 {
		if err := forwardToCribl(req.Cribl, collector.entries); err != nil {
			resp.ForwardError = err.Error()
		} else {
			resp.Forwarded = len(collector.entries)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// sliceSink buffers everything in memory. Safe here because a single request
// generates at most maxTicksPerRequest ticks — a bounded payload.
type sliceSink struct{ entries []event.LogEntry }

func (s *sliceSink) Write(e []event.LogEntry) error {
	s.entries = append(s.entries, e...)
	return nil
}
func (s *sliceSink) Flush() error { return nil }
func (s *sliceSink) Close() error { return nil }

func forwardToCribl(c *apihelp.CriblConfig, entries []event.LogEntry) error {
	// Per-entry Sourcetype flows through to the sink which maps it to a Splunk
	// vendor:product sourcetype (mysql:query, nginx:access, …). We deliberately
	// do not flatten all entries to c.Sourcetype — that would erase the
	// per-generator parsing hints Splunk relies on.
	sink := sinks.NewCribl(c.URL, c.Token, len(entries)+1, 0)
	if err := sink.Write(entries); err != nil {
		return err
	}
	return sink.Flush()
}
