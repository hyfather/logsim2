package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// SimulateRequest is the POST /v1/simulate body.
type SimulateRequest struct {
	Scenario      json.RawMessage `json:"scenario"`       // scenario YAML as a JSON string, or inline object
	ScenarioYAML  string          `json:"scenario_yaml"`  // scenario YAML as raw text
	Ticks         int             `json:"ticks"`
	TickInterval  string          `json:"tick_interval"`  // e.g. "1s"
	Seed          int64           `json:"seed"`
	SourceFilter  string          `json:"source_filter"`
	Format        string          `json:"format"` // "jsonl" | "raw"
}

// handleSimulate runs a simulation and streams results as SSE.
// Each tick emits one `event: batch` SSE event whose data is a JSON array of LogEntry.
func (s *Server) handleSimulate(w http.ResponseWriter, r *http.Request) {
	var req SimulateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "decode body: "+err.Error())
		return
	}

	sc, err := parseScenarioFromRequest(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.Ticks <= 0 {
		req.Ticks = 100
	}

	tickInterval := time.Second
	if req.TickInterval != "" {
		d, err := time.ParseDuration(req.TickInterval)
		if err != nil {
			writeError(w, http.StatusBadRequest, "--tick_interval: "+err.Error())
			return
		}
		tickInterval = d
	}

	if req.SourceFilter == "" {
		req.SourceFilter = "*"
	}

	cfg := engine.Config{
		Seed:           req.Seed,
		StartTime:      time.Now(),
		TickIntervalMs: int(tickInterval.Milliseconds()),
		SourceFilter:  req.SourceFilter,
	}

	eng := engine.New(sc, cfg)

	// Set up SSE.
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sseSink := &sseBatchSink{w: w, flusher: flusher, format: sinks.Format(req.Format)}
	ctx := r.Context()
	_ = eng.Run(ctx, req.Ticks, []sinks.Sink{sseSink})

	// Send a terminal event so the client knows the simulation is done.
	fmt.Fprintf(w, "event: done\ndata: {}\n\n")
	flusher.Flush()
}

// sseBatchSink emits one SSE `event: batch` per Write call.
type sseBatchSink struct {
	w       http.ResponseWriter
	flusher http.Flusher
	format  sinks.Format
}

func (s *sseBatchSink) Write(entries []event.LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	var data string
	if s.format == sinks.FormatRaw {
		var sb strings.Builder
		for _, e := range entries {
			sb.WriteString(e.Raw)
			sb.WriteByte('\n')
		}
		b, _ := json.Marshal(sb.String())
		data = string(b)
	} else {
		b, err := json.Marshal(entries)
		if err != nil {
			return err
		}
		data = string(b)
	}
	fmt.Fprintf(s.w, "event: batch\ndata: %s\n\n", data)
	s.flusher.Flush()
	return nil
}

func (s *sseBatchSink) Flush() error { return nil }
func (s *sseBatchSink) Close() error { return nil }

// parseScenarioFromRequest parses the scenario either from scenario_yaml (plain text)
// or from the scenario field (JSON string containing YAML).
func parseScenarioFromRequest(req SimulateRequest) (*scenario.Scenario, error) {
	var yamlText string
	if req.ScenarioYAML != "" {
		yamlText = req.ScenarioYAML
	} else if len(req.Scenario) > 0 {
		// The scenario field may be a JSON-encoded string containing YAML.
		var s string
		if err := json.Unmarshal(req.Scenario, &s); err == nil {
			yamlText = s
		} else {
			// Try treating the raw JSON as already-parsed scenario JSON.
			return nil, fmt.Errorf("scenario field must be a YAML string; use scenario_yaml instead")
		}
	} else {
		return nil, fmt.Errorf("one of scenario_yaml or scenario is required")
	}

	sc, err := scenario.Parse(strings.NewReader(yamlText))
	if err != nil {
		return nil, fmt.Errorf("parse scenario: %w", err)
	}
	if err := scenario.Validate(sc); err != nil {
		return nil, fmt.Errorf("validate scenario: %w", err)
	}
	return sc, nil
}
