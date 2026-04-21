// Package handler hosts the Vercel Go serverless entrypoint for log generation.
//
// On Vercel, every file under /api compiles to its own Lambda-style function.
// Each file must be in `package handler` and export `Handler(w, r)`.
package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/internal/engine"
	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/scenario"
	"github.com/nikhilm/logsim2/internal/sinks"
)

// Hobby execution cap is 10s. A 1s simulated window completes well under that;
// we cap the requested ticks so a pathological client can't push us past it.
const maxTicksPerRequest = 30

// CriblConfig is the subset of a Cribl Stream HEC destination the frontend
// hands us per request. Tokens live in localStorage on the client — we only
// see them for the duration of one invocation.
type CriblConfig struct {
	Enabled    bool   `json:"enabled"`
	URL        string `json:"url"`
	Token      string `json:"token"`
	Sourcetype string `json:"sourcetype"`
}

type GenerateRequest struct {
	ScenarioYAML   string       `json:"scenario_yaml"`
	Ticks          int          `json:"ticks"`
	TickIntervalMs int          `json:"tick_interval_ms"`
	StartTimeMs    int64        `json:"start_time_ms"`
	Seed           int64        `json:"seed"`
	SourceFilter   string       `json:"source_filter"`
	Cribl          *CriblConfig `json:"cribl,omitempty"`
}

type GenerateResponse struct {
	Logs         []event.LogEntry `json:"logs"`
	Ticks        int              `json:"ticks"`
	Forwarded    int              `json:"forwarded"`
	ForwardError string           `json:"forward_error,omitempty"`
}

// Handler is the Vercel entrypoint.
func Handler(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST required")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}

	var req GenerateRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "decode: "+err.Error())
		return
	}
	if req.ScenarioYAML == "" {
		writeErr(w, http.StatusBadRequest, "scenario_yaml is required")
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
		writeErr(w, http.StatusBadRequest, "parse scenario: "+err.Error())
		return
	}
	if err := scenario.Validate(sc); err != nil {
		writeErr(w, http.StatusBadRequest, "validate scenario: "+err.Error())
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
		writeErr(w, http.StatusInternalServerError, "engine: "+err.Error())
		return
	}

	resp := GenerateResponse{Logs: collector.entries, Ticks: req.Ticks}

	if req.Cribl != nil && req.Cribl.Enabled && req.Cribl.URL != "" && req.Cribl.Token != "" && len(collector.entries) > 0 {
		if err := forwardToCribl(r, req.Cribl, collector.entries); err != nil {
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

func forwardToCribl(r *http.Request, c *CriblConfig, entries []event.LogEntry) error {
	if c.Sourcetype != "" {
		for i := range entries {
			entries[i].Sourcetype = c.Sourcetype
		}
	}
	// One flush per request — no background ticker, no buffering beyond this call.
	sink := sinks.NewCribl(c.URL, c.Token, len(entries)+1, 0)
	if err := sink.Write(entries); err != nil {
		return err
	}
	return sink.Flush()
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`, msg)
}
