package sinks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
)

// CriblSink posts log batches to a Cribl Stream (or any Splunk-compatible) HEC endpoint.
// It buffers up to BatchSize events and flushes on size or FlushIntervalMs.
type CriblSink struct {
	url           string
	token         string
	batchSize     int
	flushInterval time.Duration

	client *http.Client

	mu      sync.Mutex
	buf     []event.LogEntry
	stopCh  chan struct{}
	stopped bool
}

// NewCribl creates a CriblSink. If flushIntervalMs > 0 a background goroutine
// flushes on the interval. Call Close() to stop it.
func NewCribl(url, token string, batchSize, flushIntervalMs int) *CriblSink {
	s := &CriblSink{
		url:           url,
		token:         token,
		batchSize:     batchSize,
		flushInterval: time.Duration(flushIntervalMs) * time.Millisecond,
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

// send POSTs a batch to the HEC endpoint with 3-retry exponential backoff.
func (s *CriblSink) send(batch []event.LogEntry) error {
	body, err := encodeBatch(batch)
	if err != nil {
		return fmt.Errorf("encode batch: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(1<<uint(attempt-1)) * time.Second)
		}
		lastErr = s.post(body)
		if lastErr == nil {
			return nil
		}
		// Only retry on 5xx / transport errors.
		if isPermErr(lastErr) {
			break
		}
	}
	fmt.Fprintf(os.Stderr, "logsim: dropping batch of %d events: %v\n", len(batch), lastErr)
	return nil // keep running on failure — don't propagate to engine
}

// post sends one HTTP request and returns an error for transient failures.
func (s *CriblSink) post(body []byte) error {
	req, err := http.NewRequest(http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return permErr(fmt.Sprintf("build request: %v", err))
	}
	req.Header.Set("Authorization", "Splunk "+s.token)
	req.Header.Set("Content-Type", "application/x-ndjson")

	resp, err := s.client.Do(req)
	if err != nil {
		return err // transient: network error
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.StatusCode >= 500 {
		return fmt.Errorf("server error %d", resp.StatusCode) // transient: 5xx
	}
	if resp.StatusCode >= 400 {
		return permErr(fmt.Sprintf("client error %d", resp.StatusCode)) // permanent: 4xx
	}
	return nil
}

// encodeBatch serialises entries as newline-delimited Splunk HEC JSON.
//
// Envelope follows Splunk HEC conventions:
//   - event:      the rendered log line (string) — so _raw in Splunk is the log
//     itself, not a JSON blob
//   - host:       the hierarchical channel (origin node path)
//   - source:     same channel (overridable by a Cribl/Splunk pipeline)
//   - sourcetype: mapped from the generator kind to vendor:product:type form
//     (mysql → mysql:query, nginx → nginx:access, …) so Splunk
//     picks the right parser per log family
//   - fields:     indexed metadata (id, level, channel, generator) — searchable
//     without cluttering _raw
func encodeBatch(batch []event.LogEntry) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	for i := range batch {
		e := &batch[i]
		fields := map[string]any{
			"id":        e.ID,
			"level":     e.Level,
			"channel":   e.Source,
			"generator": e.Sourcetype,
		}
		for k, v := range e.Fields {
			fields[k] = v
		}
		env := map[string]any{
			"time":       epochSeconds(e.TS),
			"host":       e.Source,
			"source":     e.Source,
			"sourcetype": splunkSourcetype(e.Sourcetype),
			"index":      "main",
			"event":      e.Raw,
			"fields":     fields,
		}
		if err := enc.Encode(env); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
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
