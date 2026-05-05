package sinks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nikhilm/logsim2/pkg/encoders"
	"github.com/nikhilm/logsim2/pkg/event"
)

// SendResult describes one HTTP attempt against a HEC endpoint. Observers
// receive one SendResult per attempt; Attempt is 1-based and increments on
// retry. Final is true on the terminal attempt for the batch — i.e. either
// it succeeded or all retries were exhausted.
type SendResult struct {
	URL        string
	BatchSize  int
	Attempt    int
	Final      bool
	StatusCode int           // 0 when no HTTP response was received (transport error)
	Duration   time.Duration // wall-clock time spent on this attempt
	Err        error         // nil on success
}

// SendObserver is invoked once per HTTP attempt. The CLI uses it to print
// forwarding status; tests use it to assert progress. Observers MUST be
// goroutine-safe — they're invoked from the sink's caller goroutine plus the
// background flusher.
type SendObserver func(SendResult)

// CriblSink posts log batches to a Cribl Stream (or any Splunk-compatible) HEC endpoint.
// It buffers up to BatchSize events and flushes on size or FlushIntervalMs.
type CriblSink struct {
	url           string
	name          string
	token         string
	batchSize     int
	flushInterval time.Duration
	format        Format

	client *http.Client

	mu      sync.Mutex
	buf     []event.LogEntry
	stopCh  chan struct{}
	stopped bool

	observerMu sync.RWMutex
	observer   SendObserver

	// Stats counters. Atomics keep observers wait-free.
	eventsSent    atomic.Int64
	batchesSent   atomic.Int64 // batches that succeeded
	batchesFailed atomic.Int64 // batches dropped after all retries
}

// NewCribl creates a CriblSink. If flushIntervalMs > 0 a background goroutine
// flushes on the interval. Call Close() to stop it.
func NewCribl(url, token string, batchSize, flushIntervalMs int) *CriblSink {
	return NewCriblWithFormat(url, token, batchSize, flushIntervalMs, FormatJSONL)
}

// NewCriblWithFormat is like NewCribl but lets callers select the wire format
// (ocsf, native jsonl, etc.). Use this when forwarding to a downstream that
// expects a specific schema.
func NewCriblWithFormat(url, token string, batchSize, flushIntervalMs int, format Format) *CriblSink {
	if format == "" {
		format = FormatJSONL
	}
	s := &CriblSink{
		url:           url,
		token:         token,
		batchSize:     batchSize,
		flushInterval: time.Duration(flushIntervalMs) * time.Millisecond,
		format:        format,
		client:        &http.Client{Timeout: 30 * time.Second},
		stopCh:        make(chan struct{}),
	}
	if flushIntervalMs > 0 {
		go s.intervalFlusher()
	}
	return s
}

func (s *CriblSink) intervalFlusher() {
	t := time.NewTicker(s.flushInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if err := s.Flush(); err != nil {
				fmt.Fprintf(os.Stderr, "logsim: cribl flush error: %v\n", err)
			}
		case <-s.stopCh:
			return
		}
	}
}

// Write buffers entries and auto-flushes complete batches of batchSize.
func (s *CriblSink) Write(entries []event.LogEntry) error {
	s.mu.Lock()
	s.buf = append(s.buf, entries...)

	// Drain as many full batches as possible.
	var toSend [][]event.LogEntry
	for len(s.buf) >= s.batchSize {
		toSend = append(toSend, s.buf[:s.batchSize])
		s.buf = s.buf[s.batchSize:]
	}
	s.mu.Unlock()

	for _, batch := range toSend {
		if err := s.send(batch); err != nil {
			return err
		}
	}
	return nil
}

// Flush sends any buffered entries immediately.
func (s *CriblSink) Flush() error {
	s.mu.Lock()
	if len(s.buf) == 0 {
		s.mu.Unlock()
		return nil
	}
	batch := s.buf
	s.buf = nil
	s.mu.Unlock()
	return s.send(batch)
}

// Close flushes remaining entries and stops the interval flusher.
func (s *CriblSink) Close() error {
	s.mu.Lock()
	if !s.stopped {
		s.stopped = true
		close(s.stopCh)
	}
	s.mu.Unlock()
	return s.Flush()
}

// SetObserver installs (or clears) the per-attempt observer. Pass nil to
// detach. Safe to call concurrently with Write.
func (s *CriblSink) SetObserver(o SendObserver) {
	s.observerMu.Lock()
	s.observer = o
	s.observerMu.Unlock()
}

// EventsSent returns the number of events successfully forwarded.
func (s *CriblSink) EventsSent() int64 { return s.eventsSent.Load() }

// BatchesSent returns the number of batches that were accepted by the HEC
// endpoint (including those that needed one or more retries).
func (s *CriblSink) BatchesSent() int64 { return s.batchesSent.Load() }

// BatchesFailed returns the number of batches dropped after exhausting retries
// or hitting a permanent (4xx) failure.
func (s *CriblSink) BatchesFailed() int64 { return s.batchesFailed.Load() }

// URL returns the configured HEC endpoint. Used by the CLI for status output.
func (s *CriblSink) URL() string { return s.url }

// Name returns the friendly destination name (e.g. "prod-cribl"), or "" if
// the sink wasn't built from a named destination.
func (s *CriblSink) Name() string { return s.name }

// SetName attaches a friendly name. The registry calls this when the sink is
// built from a named destination so the CLI can label status output.
func (s *CriblSink) SetName(name string) { s.name = name }

func (s *CriblSink) notify(r SendResult) {
	s.observerMu.RLock()
	o := s.observer
	s.observerMu.RUnlock()
	if o != nil {
		o(r)
	}
}

// send POSTs a batch to the HEC endpoint with 3-retry exponential backoff.
func (s *CriblSink) send(batch []event.LogEntry) error {
	body, err := encodeBatch(batch, s.format)
	if err != nil {
		return fmt.Errorf("encode batch: %w", err)
	}

	const maxAttempts = 3
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			time.Sleep(time.Duration(1<<uint(attempt-2)) * time.Second)
		}
		started := time.Now()
		status, postErr := s.post(body)
		elapsed := time.Since(started)
		lastErr = postErr

		final := postErr == nil || isPermErr(postErr) || attempt == maxAttempts
		s.notify(SendResult{
			URL:        s.url,
			BatchSize:  len(batch),
			Attempt:    attempt,
			Final:      final,
			StatusCode: status,
			Duration:   elapsed,
			Err:        postErr,
		})

		if postErr == nil {
			s.batchesSent.Add(1)
			s.eventsSent.Add(int64(len(batch)))
			return nil
		}
		if isPermErr(postErr) {
			break
		}
	}
	s.batchesFailed.Add(1)
	fmt.Fprintf(os.Stderr, "logsim: dropping batch of %d events: %v\n", len(batch), lastErr)
	return nil // keep running on failure — don't propagate to engine
}

// post sends one HTTP request. It returns the HTTP status code (0 on transport
// error) plus a transient/permanent error or nil on success.
func (s *CriblSink) post(body []byte) (int, error) {
	req, err := http.NewRequest(http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return 0, permErr(fmt.Sprintf("build request: %v", err))
	}
	if s.token != "" {
		req.Header.Set("Authorization", "Splunk "+s.token)
	}
	req.Header.Set("Content-Type", "application/x-ndjson")

	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err // transient: network error
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.StatusCode >= 500 {
		return resp.StatusCode, fmt.Errorf("server error %d", resp.StatusCode) // transient: 5xx
	}
	if resp.StatusCode >= 400 {
		return resp.StatusCode, permErr(fmt.Sprintf("client error %d", resp.StatusCode)) // permanent: 4xx
	}
	return resp.StatusCode, nil
}

// encodeBatch serialises entries as newline-delimited Splunk HEC JSON.
//
// Envelope follows Splunk HEC conventions:
//   - event:      the rendered log line (string) — so _raw in Splunk is the log
//     itself, not a JSON blob. When format is OCSF/UDM/ASIM, this is replaced
//     with the schema-mapped JSON object so the consumer sees structured data.
//   - host:       the hierarchical channel (origin node path)
//   - source:     same channel (overridable by a Cribl/Splunk pipeline)
//   - sourcetype: mapped to vendor:product:type form (mysql → mysql:query,
//     nginx → nginx:access, …) so Splunk picks the right parser per log
//     family. OCSF events use "ocsf:1.4:json" so Splunk routes them to a
//     schema-aware index.
//   - fields:     indexed metadata (id, level, channel) — searchable without
//     cluttering _raw
func encodeBatch(batch []event.LogEntry, format Format) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)

	encoder := encoders.For(toEncoderFormat(format))
	wantSchema := format == FormatOCSF || format == FormatOTEL || format == FormatUDM || format == FormatASIM

	for i := range batch {
		e := &batch[i]
		fields := map[string]any{
			"id":      e.ID,
			"level":   e.Level,
			"channel": e.Source,
		}
		for k, v := range e.Fields {
			fields[k] = v
		}

		var eventPayload any = e.Raw
		sourcetype := splunkSourcetype(e.Sourcetype)
		if wantSchema {
			b, err := encoder.Encode(e)
			if err != nil {
				return nil, fmt.Errorf("encode entry %s: %w", e.ID, err)
			}
			// Decode back to a generic object so the HEC envelope nests it as
			// structured JSON rather than a JSON-encoded string.
			var obj any
			if err := json.Unmarshal(b, &obj); err != nil {
				return nil, fmt.Errorf("re-decode encoded entry: %w", err)
			}
			eventPayload = obj
			sourcetype = schemaSourcetype(format)
		}

		env := map[string]any{
			"time":       epochSeconds(e.TS),
			"host":       e.Source,
			"source":     e.Source,
			"sourcetype": sourcetype,
			"index":      "main",
			"event":      eventPayload,
			"fields":     fields,
		}
		if err := enc.Encode(env); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

// schemaSourcetype returns the Splunk sourcetype that downstream pipelines use
// to route schema-aware events to the right parser/index.
func schemaSourcetype(f Format) string {
	switch f {
	case FormatOCSF:
		return "ocsf:1.4:json"
	case FormatOTEL:
		return "otel:logs:json"
	case FormatUDM:
		return "udm:json"
	case FormatASIM:
		return "asim:json"
	default:
		return ""
	}
}

// epochSeconds parses an RFC3339Nano timestamp to Splunk HEC's expected
// fractional-second epoch format. Returns 0 on parse failure so HEC falls back
// to receive-time.
func epochSeconds(ts string) float64 {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return 0
	}
	return float64(t.UnixNano()) / 1e9
}

// --- permanent-error sentinel ---

type permanentError struct{ msg string }

func (e permanentError) Error() string { return e.msg }

func permErr(msg string) error       { return permanentError{msg} }
func isPermErr(err error) bool       { _, ok := err.(permanentError); return ok }
