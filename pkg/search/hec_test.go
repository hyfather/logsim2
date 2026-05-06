package search

import (
	"strings"
	"testing"
	"time"
)

func TestParseHEC_basicNDJSON(t *testing.T) {
	body := strings.Join([]string{
		`{"time":1700000000,"host":"h1","source":"app","sourcetype":"nodejs","event":"hello","fields":{"level":"INFO"}}`,
		`{"time":"1700000001.5","host":"h2","source":"app","event":"world","fields":{"level":"ERROR","id":"e2"}}`,
	}, "\n") + "\n"

	events, err := ParseHEC(strings.NewReader(body))
	if err != nil {
		t.Fatalf("ParseHEC: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}

	want := time.Unix(1700000000, 0).UTC()
	if !events[0].Time.Equal(want) {
		t.Errorf("event[0].Time = %v, want %v", events[0].Time, want)
	}
	if events[0].Raw != "hello" {
		t.Errorf("event[0].Raw = %q", events[0].Raw)
	}
	if events[0].Fields["level"] != "INFO" {
		t.Errorf("event[0].Fields[level] = %v", events[0].Fields["level"])
	}

	if events[1].ID != "e2" {
		t.Errorf("event[1].ID = %q, want e2", events[1].ID)
	}
	if events[1].Time.UnixMilli() != 1700000001500 {
		t.Errorf("event[1].Time = %v", events[1].Time)
	}
}

func TestParseHEC_objectEvent(t *testing.T) {
	body := `{"time":1700000000,"host":"h","event":{"msg":"oops","status":500}}` + "\n"
	events, err := ParseHEC(strings.NewReader(body))
	if err != nil {
		t.Fatalf("ParseHEC: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	// Object events get re-serialised into raw + promoted into fields.
	if !strings.Contains(events[0].Raw, "oops") {
		t.Errorf("raw = %q, want substring 'oops'", events[0].Raw)
	}
	if got, want := events[0].Fields["msg"], "oops"; got != want {
		t.Errorf("fields[msg] = %v, want %v", got, want)
	}
	// Numeric statuses come back as float64 from encoding/json.
	if v, ok := events[0].Fields["status"].(float64); !ok || v != 500 {
		t.Errorf("fields[status] = %v (%T), want 500", events[0].Fields["status"], events[0].Fields["status"])
	}
}

func TestParseHEC_missingTimeOK(t *testing.T) {
	// HEC tolerates missing time; we fall back to wall clock.
	body := `{"event":"no time","host":"h"}` + "\n"
	events, err := ParseHEC(strings.NewReader(body))
	if err != nil {
		t.Fatalf("ParseHEC: %v", err)
	}
	if len(events) != 1 || events[0].Raw != "no time" {
		t.Fatalf("unexpected events: %+v", events)
	}
	if events[0].Time.IsZero() {
		t.Errorf("expected fallback timestamp, got zero")
	}
}

func TestParseHEC_emptyLinesSkipped(t *testing.T) {
	body := "\n\n" + `{"event":"a"}` + "\n\n" + `{"event":"b"}` + "\n"
	events, err := ParseHEC(strings.NewReader(body))
	if err != nil {
		t.Fatalf("ParseHEC: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
}

func TestParseHEC_malformedReportsLineNumber(t *testing.T) {
	body := `{"event":"ok"}` + "\n" + `not json` + "\n"
	_, err := ParseHEC(strings.NewReader(body))
	if err == nil {
		t.Fatalf("expected error")
	}
	if !strings.Contains(err.Error(), "line 2") {
		t.Errorf("error %q should mention line 2", err)
	}
}
