package server

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/nikhilm/logsim2/internal/config"
	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/sinks"
)

// safeDestination is a redacted view of a Destination (no token).
type safeDestination struct {
	Name          string                 `json:"name"`
	Type          config.DestinationType `json:"type"`
	Enabled       bool                   `json:"enabled"`
	URL           string                 `json:"url"`
	BatchSize     int                    `json:"batch_size"`
	FlushInterval int                    `json:"flush_interval_ms"`
}

// handleListDestinations returns all destinations with tokens redacted.
func (s *Server) handleListDestinations(w http.ResponseWriter, r *http.Request) {
	dcfg := s.destinations()
	if dcfg == nil {
		writeJSON(w, http.StatusOK, map[string]any{"destinations": []any{}})
		return
	}
	result := make([]safeDestination, len(dcfg.Destinations))
	for i, d := range dcfg.Destinations {
		result[i] = safeDestination{
			Name:          d.Name,
			Type:          d.Type,
			Enabled:       d.Enabled,
			URL:           d.URL,
			BatchSize:     d.BatchSize,
			FlushInterval: d.FlushInterval,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"destinations": result})
}

// handleTestDestination sends one canned event to the named destination.
func (s *Server) handleTestDestination(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	dcfg := s.destinations()
	if dcfg == nil {
		writeError(w, http.StatusNotFound, "no destinations config loaded")
		return
	}
	d := dcfg.Get(name)
	if d == nil {
		writeError(w, http.StatusNotFound, "destination not found: "+name)
		return
	}
	if !d.Enabled {
		writeError(w, http.StatusBadRequest, "destination is disabled: "+name)
		return
	}

	sink, err := sinks.ForDestination(d)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "build sink: "+err.Error())
		return
	}
	defer sink.Close()

	testEntry := event.LogEntry{
		ID:         "logsim-test",
		Sourcetype: "logsim",
		Raw:        "logsim connectivity test",
		Fields:     map[string]any{"test": true},
	}
	if err := sink.Write([]event.LogEntry{testEntry}); err != nil {
		writeError(w, http.StatusBadGateway, "send test event: "+err.Error())
		return
	}
	if err := sink.Flush(); err != nil {
		writeError(w, http.StatusBadGateway, "flush: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "destination": name})
}

// handleForward accepts a JSON array of LogEntry and forwards them to the named destination.
func (s *Server) handleForward(w http.ResponseWriter, r *http.Request) {
	destName := r.URL.Query().Get("destination")
	if destName == "" {
		writeError(w, http.StatusBadRequest, "destination query param is required")
		return
	}

	dcfg := s.destinations()
	if dcfg == nil {
		writeError(w, http.StatusNotFound, "no destinations config loaded")
		return
	}
	d := dcfg.Get(destName)
	if d == nil {
		writeError(w, http.StatusNotFound, "destination not found: "+destName)
		return
	}
	if !d.Enabled {
		writeError(w, http.StatusBadRequest, "destination is disabled: "+destName)
		return
	}

	var entries []event.LogEntry
	if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
		writeError(w, http.StatusBadRequest, "decode body: "+err.Error())
		return
	}

	sink, err := sinks.ForDestination(d)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "build sink: "+err.Error())
		return
	}
	defer sink.Close()

	if err := sink.Write(entries); err != nil {
		writeError(w, http.StatusBadGateway, "write: "+err.Error())
		return
	}
	if err := sink.Flush(); err != nil {
		writeError(w, http.StatusBadGateway, "flush: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"forwarded": len(entries),
	})
}
