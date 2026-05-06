package search

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"time"
)

// hecEnvelope is the wire shape Splunk and Cribl HEC accept on
// /services/collector/event. Both senders also tolerate newline-delimited
// JSON, which is what pkg/sinks/cribl.go emits.
type hecEnvelope struct {
	Time       any            `json:"time,omitempty"`       // epoch seconds (number or string)
	Host       string         `json:"host,omitempty"`
	Source     string         `json:"source,omitempty"`
	Sourcetype string         `json:"sourcetype,omitempty"`
	Index      string         `json:"index,omitempty"`
	Event      json.RawMessage `json:"event"`               // string OR object
	Fields     map[string]any `json:"fields,omitempty"`
}

// ParseHEC reads NDJSON HEC envelopes from r and returns canonical Events.
// Empty lines are skipped. A malformed line aborts the read with a
// line-numbered error so senders can debug their batch.
func ParseHEC(r io.Reader) ([]Event, error) {
	scanner := bufio.NewScanner(r)
	// Splunk HEC accepts events up to 1 MiB; we match that.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var out []Event
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var env hecEnvelope
		if err := json.Unmarshal(line, &env); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		ev, err := envelopeToEvent(env)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNo, err)
		}
		out = append(out, ev)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan: %w", err)
	}
	return out, nil
}

func envelopeToEvent(env hecEnvelope) (Event, error) {
	t, err := parseHECTime(env.Time)
	if err != nil {
		return Event{}, err
	}
	raw, structured := decodeEventPayload(env.Event)

	fields := env.Fields
	// Promote a few well-known fields out of the structured event so they
	// surface in the IR API by default. Splunk does the equivalent at index
	// time; doing it here keeps the IR functions backend-agnostic.
	if structured != nil {
		if fields == nil {
			fields = map[string]any{}
		}
		for k, v := range structured {
			if _, exists := fields[k]; !exists {
				fields[k] = v
			}
		}
	}

	id := ""
	if fields != nil {
		if v, ok := fields["id"]; ok {
			if s, ok := v.(string); ok {
				id = s
			}
		}
	}

	return Event{
		ID:         id,
		Time:       t,
		Host:       env.Host,
		Source:     env.Source,
		Sourcetype: env.Sourcetype,
		Index:      env.Index,
		Raw:        raw,
		Fields:     fields,
	}, nil
}

// parseHECTime accepts either a JSON number, a string-encoded number, or an
// RFC3339 timestamp. HEC senders in the wild do all three. Missing time
// falls back to wall clock so ingestion never rejects a payload over a
// missing timestamp.
func parseHECTime(v any) (time.Time, error) {
	switch x := v.(type) {
	case nil:
		return time.Now(), nil
	case float64:
		return floatToTime(x), nil
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return time.Time{}, fmt.Errorf("time: %w", err)
		}
		return floatToTime(f), nil
	case string:
		if x == "" {
			return time.Now(), nil
		}
		if f, err := strconv.ParseFloat(x, 64); err == nil {
			return floatToTime(f), nil
		}
		if t, err := time.Parse(time.RFC3339Nano, x); err == nil {
			return t, nil
		}
		return time.Time{}, fmt.Errorf("time %q: not epoch seconds or RFC3339", x)
	default:
		return time.Time{}, fmt.Errorf("time has unsupported type %T", v)
	}
}

func floatToTime(f float64) time.Time {
	sec := int64(f)
	nsec := int64((f - float64(sec)) * 1e9)
	return time.Unix(sec, nsec).UTC()
}

// decodeEventPayload turns the HEC `event` field (which is either a string
// or a JSON object) into (raw, structured). raw is always populated for the
// IR API's substring/raw needs; structured is non-nil only when the event
// arrived as a JSON object.
func decodeEventPayload(b json.RawMessage) (string, map[string]any) {
	if len(b) == 0 {
		return "", nil
	}
	// Try string first — most common, including pkg/sinks/cribl.go output
	// in native mode.
	var asString string
	if err := json.Unmarshal(b, &asString); err == nil {
		return asString, nil
	}
	var asObj map[string]any
	if err := json.Unmarshal(b, &asObj); err == nil {
		// Re-serialise as the canonical raw so substring search works. The
		// keys keep their original order through json.Marshal's stable sort
		// — fine for IR purposes.
		raw, _ := json.Marshal(asObj)
		return string(raw), asObj
	}
	// Fallback: store the literal JSON.
	return string(b), nil
}
