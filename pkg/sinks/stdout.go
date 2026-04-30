package sinks

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/nikhilm/logsim2/pkg/encoders"
	"github.com/nikhilm/logsim2/pkg/event"
)

// Format controls how log entries are serialised. JSONL and Raw operate on the
// LogEntry as the generator produced it; OCSF runs the entry through the
// encoders.OCSF mapping so the line emitted is OCSF-compliant JSON.
type Format string

const (
	FormatJSONL Format = "jsonl" // full LogEntry as JSON per line
	FormatRaw   Format = "raw"   // only the Raw field, one per line
	FormatOCSF  Format = "ocsf"  // encoders.OCSF JSON per line
	FormatOTEL  Format = "otel"  // OpenTelemetry OTLP/JSON LogRecord per line
	FormatUDM   Format = "udm"   // reserved (falls back to native JSONL today)
	FormatASIM  Format = "asim"  // reserved (falls back to native JSONL today)
)

// WriterSink writes to any io.Writer. Used for both stdout and file.
type WriterSink struct {
	w       io.Writer
	format  Format
	enc     *json.Encoder
	encoder encoders.Encoder
	closer  io.Closer // optional; closed on Close()
}

// NewStdout returns a WriterSink writing to os.Stdout.
func NewStdout(format Format) *WriterSink {
	return NewWriter(os.Stdout, format)
}

// NewWriter returns a WriterSink writing to w.
func NewWriter(w io.Writer, format Format) *WriterSink {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return &WriterSink{
		w:       w,
		format:  format,
		enc:     enc,
		encoder: encoders.For(toEncoderFormat(format)),
	}
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
	case FormatOCSF, FormatOTEL, FormatUDM, FormatASIM:
		b, err := s.encoder.Encode(e)
		if err != nil {
			return err
		}
		if _, err := s.w.Write(b); err != nil {
			return err
		}
		_, err = s.w.Write([]byte{'\n'})
		return err
	default: // FormatJSONL
		return s.enc.Encode(e)
	}
}

// toEncoderFormat maps a sinks.Format to encoders.Format. JSONL/Raw both map
// to encoders.FormatNative because the sink already serialises those forms
// directly without going through an encoder.
func toEncoderFormat(f Format) encoders.Format {
	switch f {
	case FormatOCSF:
		return encoders.FormatOCSF
	case FormatOTEL:
		return encoders.FormatOTEL
	case FormatUDM:
		return encoders.FormatUDM
	case FormatASIM:
		return encoders.FormatASIM
	default:
		return encoders.FormatNative
	}
}

func (s *WriterSink) Flush() error { return nil }

func (s *WriterSink) Close() error {
	if s.closer != nil {
		return s.closer.Close()
	}
	return nil
}
