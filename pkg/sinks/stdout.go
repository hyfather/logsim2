package sinks

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/nikhilm/logsim2/pkg/event"
)

// Format controls how log entries are serialised.
type Format string

const (
	FormatJSONL Format = "jsonl" // full LogEntry as JSON per line
	FormatRaw   Format = "raw"   // only the Raw field, one per line
)

// WriterSink writes to any io.Writer. Used for both stdout and file.
type WriterSink struct {
	w      io.Writer
	format Format
	enc    *json.Encoder
	closer io.Closer // optional; closed on Close()
}

// NewStdout returns a WriterSink writing to os.Stdout.
func NewStdout(format Format) *WriterSink {
	return NewWriter(os.Stdout, format)
}

// NewWriter returns a WriterSink writing to w.
func NewWriter(w io.Writer, format Format) *WriterSink {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return &WriterSink{w: w, format: format, enc: enc}
}

func (s *WriterSink) Write(entries []event.LogEntry) error {
	for i := range entries {
		if err := s.writeOne(&entries[i]); err != nil {
			return err
		}
	}
	return nil
}

func (s *WriterSink) writeOne(e *event.LogEntry) error {
	switch s.format {
	case FormatRaw:
		_, err := fmt.Fprintln(s.w, e.Raw)
		return err
	default: // FormatJSONL
		return s.enc.Encode(e)
	}
}

func (s *WriterSink) Flush() error { return nil }

func (s *WriterSink) Close() error {
	if s.closer != nil {
		return s.closer.Close()
	}
	return nil
}
