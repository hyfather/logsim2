package encoders

import (
	"encoding/json"
	"testing"

	"github.com/nikhilm/logsim2/pkg/event"
)

// extractLogRecord drills into the OTLP/JSON envelope and returns the first
// (and only, for our single-entry encoder) logRecord and its parent resource.
// Tests assert against the inner record so they stay readable instead of
// repeating the envelope shape.
func extractLogRecord(t *testing.T, b []byte) (record map[string]any, resource map[string]any) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("decoded result not valid JSON: %v", err)
	}
	rls, ok := got["resourceLogs"].([]any)
	if !ok || len(rls) == 0 {
		t.Fatalf("resourceLogs missing or empty: %v", got)
	}
	rl := rls[0].(map[string]any)
	resource = rl["resource"].(map[string]any)
	scopeLogs := rl["scopeLogs"].([]any)
	sl := scopeLogs[0].(map[string]any)
	records := sl["logRecords"].([]any)
	record = records[0].(map[string]any)
	return record, resource
}

// findAttr returns the value object of an OTLP attribute by key, or nil if not
// present. Attributes are kvlists (slices of {key, value}) so we have to scan.
func findAttr(attrs []any, key string) map[string]any {
	for _, a := range attrs {
		kv, ok := a.(map[string]any)
		if !ok {
			continue
		}
		if kv["key"] == key {
			if v, ok := kv["value"].(map[string]any); ok {
				return v
			}
		}
	}
	return nil
}

func TestOTELHTTPActivity(t *testing.T) {
	e := &event.LogEntry{
		ID:         "t1-0",
		TS:         "2026-04-28T10:00:00.000Z",
		Source:     "web.api",
		Level:      "ERROR",
		Sourcetype: "nodejs",
		Class:      ClassHTTPActivity,
		Raw:        `{"status":500}`,
		Fields: map[string]any{
			"method":           "POST",
			"path":             "/api/orders",
			"status_code":      500,
			"response_time_ms": 142,
			"remote_addr":      "10.0.0.5",
		},
	}

	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	record, _ := extractLogRecord(t, b)
	if record["severityText"] != "ERROR" {
		t.Errorf("severityText = %v, want ERROR", record["severityText"])
	}
	// severityNumber is decoded as float64 from JSON.
	if record["severityNumber"].(float64) != float64(otelSeverityError) {
		t.Errorf("severityNumber = %v, want %d", record["severityNumber"], otelSeverityError)
	}
	body, ok := record["body"].(map[string]any)
	if !ok || body["stringValue"] != `{"status":500}` {
		t.Errorf("body.stringValue = %v, want raw payload", body)
	}
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "http.request.method"); v == nil || v["stringValue"] != "POST" {
		t.Errorf("http.request.method missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "url.path"); v == nil || v["stringValue"] != "/api/orders" {
		t.Errorf("url.path missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "http.response.status_code"); v == nil || v["intValue"].(float64) != 500 {
		t.Errorf("http.response.status_code missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "client.address"); v == nil || v["stringValue"] != "10.0.0.5" {
		t.Errorf("client.address missing or wrong: %v", v)
	}
}

func TestOTELNetworkActivity(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassNetworkActivity,
		TS:         "2026-04-28T10:00:00.000Z",
		Sourcetype: "vpc-flow",
		Level:      "INFO",
		Fields: map[string]any{
			"src_ip":   "10.0.1.5",
			"dst_ip":   "10.0.2.7",
			"src_port": 49200,
			"dst_port": 443,
			"protocol": 6,
			"bytes":    int64(2048),
			"packets":  int64(3),
			"action":   "ACCEPT",
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)

	if v := findAttr(attrs, "source.address"); v == nil || v["stringValue"] != "10.0.1.5" {
		t.Errorf("source.address missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "destination.port"); v == nil || v["intValue"].(float64) != 443 {
		t.Errorf("destination.port missing or wrong: %v", v)
	}
	// IANA protocol 6 → tcp transport.
	if v := findAttr(attrs, "network.transport"); v == nil || v["stringValue"] != "tcp" {
		t.Errorf("network.transport = %v, want tcp", v)
	}
	if v := findAttr(attrs, "network.action"); v == nil || v["stringValue"] != "accept" {
		t.Errorf("network.action = %v, want accept", v)
	}
}

func TestOTELDatastoreActivity(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassDatastoreActivity,
		Sourcetype: "mysql",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"query":       "SELECT * FROM users WHERE id = 1",
			"database":    "app",
			"duration_ms": 12,
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)

	if v := findAttr(attrs, "db.query.text"); v == nil || v["stringValue"] != "SELECT * FROM users WHERE id = 1" {
		t.Errorf("db.query.text missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "db.operation.name"); v == nil || v["stringValue"] != "SELECT" {
		t.Errorf("db.operation.name = %v, want SELECT", v)
	}
	if v := findAttr(attrs, "db.namespace"); v == nil || v["stringValue"] != "app" {
		t.Errorf("db.namespace missing or wrong: %v", v)
	}
}

func TestOTELLifecycle(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassApplicationLifecycle,
		Sourcetype: "nodejs",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"port":      3000,
			"framework": "express",
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "server.port"); v == nil || v["intValue"].(float64) != 3000 {
		t.Errorf("server.port missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "service.framework"); v == nil || v["stringValue"] != "express" {
		t.Errorf("service.framework missing or wrong: %v", v)
	}
}

func TestOTELGenericFallback(t *testing.T) {
	// No Class set: every Field should still appear as a flat attribute so
	// nothing is silently dropped on unknown classes.
	e := &event.LogEntry{
		Sourcetype: "custom",
		Source:     "demo.app",
		Level:      "DEBUG",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "hello",
		Fields: map[string]any{
			"custom_count": 7,
			"custom_name":  "alpha",
			"flag":         true,
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, resource := extractLogRecord(t, b)
	if body := record["body"].(map[string]any); body["stringValue"] != "hello" {
		t.Errorf("body.stringValue = %v, want hello", body["stringValue"])
	}
	if record["severityText"] != "DEBUG" {
		t.Errorf("severityText = %v, want DEBUG", record["severityText"])
	}
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "custom_count"); v == nil || v["intValue"].(float64) != 7 {
		t.Errorf("custom_count missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "custom_name"); v == nil || v["stringValue"] != "alpha" {
		t.Errorf("custom_name missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "flag"); v == nil || v["boolValue"] != true {
		t.Errorf("flag missing or wrong: %v", v)
	}
	resAttrs := resource["attributes"].([]any)
	if v := findAttr(resAttrs, "service.name"); v == nil || v["stringValue"] != "demo.app" {
		t.Errorf("service.name resource attribute missing or wrong: %v", v)
	}
}

func TestOTELParseFormat(t *testing.T) {
	if got := Parse("otel"); got != FormatOTEL {
		t.Errorf("Parse(\"otel\") = %q, want %q", got, FormatOTEL)
	}
}

func TestOTELTimestampString(t *testing.T) {
	// OTLP/JSON encodes 64-bit ints as strings to preserve precision; verify
	// timeUnixNano lands as a numeric string, not a JSON number.
	e := &event.LogEntry{
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "INFO",
		Raw:   "x",
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	ts, ok := record["timeUnixNano"].(string)
	if !ok {
		t.Fatalf("timeUnixNano = %T, want string (got %v)", record["timeUnixNano"], record["timeUnixNano"])
	}
	if ts == "" || ts == "0" {
		t.Errorf("timeUnixNano = %q, want non-zero", ts)
	}
}
