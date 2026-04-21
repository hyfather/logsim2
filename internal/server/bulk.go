package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/internal/engine"
	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/sinks"
)

// handleBulk runs a simulation and returns all log entries in a ZIP archive.
// Each channel gets its own .jsonl file; a manifest.json lists all files.
func (s *Server) handleBulk(w http.ResponseWriter, r *http.Request) {
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
			writeError(w, http.StatusBadRequest, "tick_interval: "+err.Error())
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
	collector := newBulkSink()

	ctx := r.Context()
	if err := eng.Run(ctx, req.Ticks, []sinks.Sink{collector}); err != nil && ctx.Err() == nil {
		writeError(w, http.StatusInternalServerError, "simulation: "+err.Error())
		return
	}

	// Build ZIP.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	channels := collector.channels()
	manifest := make([]map[string]any, 0, len(channels))

	format := sinks.Format(req.Format)
	if format == "" {
		format = sinks.FormatJSONL
	}

	for _, ch := range channels {
		filename := sanitizeChannel(ch) + ".jsonl"
		fw, err := zw.Create(filename)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "zip create: "+err.Error())
			return
		}
		entries := collector.entriesForChannel(ch)
		lineCount := 0
		for _, e := range entries {
			var line string
			if format == sinks.FormatRaw {
				line = e.Raw
			} else {
				b, _ := json.Marshal(e)
				line = string(b)
			}
			fmt.Fprintln(fw, line)
			lineCount++
		}
		manifest = append(manifest, map[string]any{
			"source":     ch,
			"file":       filename,
			"line_count": lineCount,
		})
	}

	// Write manifest.
	mfw, _ := zw.Create("manifest.json")
	enc := json.NewEncoder(mfw)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]any{
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"ticks":        req.Ticks,
		"scenario":     sc.Name,
		"files":        manifest,
	})

	if err := zw.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "zip close: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="logsim-%s.zip"`, sanitizeChannel(sc.Name)))
	w.WriteHeader(http.StatusOK)
	w.Write(buf.Bytes())
}

// bulkSink collects all entries keyed by channel.
type bulkSink struct {
	bySource map[string][]event.LogEntry
	order     []string // insertion order
}

func newBulkSink() *bulkSink {
	return &bulkSink{bySource: make(map[string][]event.LogEntry)}
}

func (b *bulkSink) Write(entries []event.LogEntry) error {
	for _, e := range entries {
		if _, exists := b.bySource[e.Source]; !exists {
			b.order = append(b.order, e.Source)
		}
		b.bySource[e.Source] = append(b.bySource[e.Source], e)
	}
	return nil
}

func (b *bulkSink) Flush() error              { return nil }
func (b *bulkSink) Close() error              { return nil }
func (b *bulkSink) channels() []string        { return b.order }
func (b *bulkSink) entriesForChannel(ch string) []event.LogEntry {
	return b.bySource[ch]
}

// sanitizeChannel turns a channel name into a safe filename component.
func sanitizeChannel(ch string) string {
	r := strings.NewReplacer("/", "-", " ", "-", ":", "-")
	return r.Replace(ch)
}

// Ensure bulkSink satisfies sinks.Sink at compile time.
var _ sinks.Sink = (*bulkSink)(nil)

// Ensure context is threaded.
var _ context.Context = context.Background()
