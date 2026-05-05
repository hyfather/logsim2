package encoders

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/nikhilm/logsim2/pkg/event"
)

// Supplemental OTEL tests covering the small helpers and edge cases that the
// existing suite doesn't pin down. These guard the contract between the engine
// and any OTLP/JSON-aware collector — drift in severity numbers, transport
// names, or timestamp encoding silently breaks downstream pipelines.

func TestOTELSeverityNumberMatrix(t *testing.T) {
	cases := []struct {
		level string
		num   int
		text  string
	}{
		{"TRACE", otelSeverityTrace, "TRACE"},
		{"DEBUG", otelSeverityDebug, "DEBUG"},
		{"INFO", otelSeverityInfo, "INFO"},
		{"", otelSeverityInfo, "INFO"},
		{"WARN", otelSeverityWarn, "WARN"},
		{"WARNING", otelSeverityWarn, "WARN"},
		{"ERROR", otelSeverityError, "ERROR"},
		{"FATAL", otelSeverityFatal, "FATAL"},
		{"CRITICAL", otelSeverityFatal, "FATAL"},
		{"weird", 0, "UNSPECIFIED"},
	}
	for _, c := range cases {
		num, text := otelSeverity(c.level)
		if num != c.num || text != c.text {
			t.Errorf("otelSeverity(%q) = (%d,%q), want (%d,%q)", c.level, num, text, c.num, c.text)
		}
	}
}

func TestOTELNetworkTransportMatrix(t *testing.T) {
	cases := map[int]string{
		6:   "tcp",
		17:  "udp",
		1:   "icmp",
		47:  "unknown", // GRE — anything outside the supported set
		0:   "unknown",
	}
	for proto, want := range cases {
		if got := networkTransport(proto); got != want {
			t.Errorf("networkTransport(%d) = %q, want %q", proto, got, want)
		}
	}
}

func TestOTELSQLOperationMatrix(t *testing.T) {
	cases := map[string]string{
		"SELECT * FROM t":   "SELECT",
		"  select x from y": "SELECT",
		"INSERT INTO t":     "INSERT",
		"UPDATE t":          "UPDATE",
		"DELETE FROM t":     "DELETE",
		"GRANT":             "OTHER",
		"":                  "OTHER",
	}
	for q, want := range cases {
		if got := sqlOperation(q); got != want {
			t.Errorf("sqlOperation(%q) = %q, want %q", q, got, want)
		}
	}
}

// otelKVAny is the AnyValue picker that decides which OTLP value variant to
// emit for a Go field value. Wrong dispatch here lands every value as the
// wrong protobuf type and every collector rejects the record.
func TestOTELKVAnyDispatchesByGoType(t *testing.T) {
	cases := []struct {
		name string
		in   any
		key  string // expected AnyValue variant key
	}{
		{"nil", nil, ""}, // nil → empty AnyValue
		{"string", "hello", "stringValue"},
		{"bool", true, "boolValue"},
		{"int", int(42), "intValue"},
		{"int32", int32(42), "intValue"},
		{"int64", int64(42), "intValue"},
		{"float-int", float64(7), "intValue"}, // integer-valued float reduces to int
		{"float-frac", float64(3.14), "doubleValue"},
		{"struct", struct{ A int }{A: 1}, "stringValue"}, // unknown → JSON-stringified
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			kv := otelKVAny("k", c.in)
			val, ok := kv["value"].(map[string]any)
			if !ok {
				t.Fatalf("value not a map: %v", kv)
			}
			if c.key == "" {
				if len(val) != 0 {
					t.Errorf("nil should produce empty AnyValue, got %v", val)
				}
				return
			}
			if _, present := val[c.key]; !present {
				t.Errorf("expected variant %q, got %v", c.key, val)
			}
		})
	}
}

func TestOTELFormatUnixNanoIsString(t *testing.T) {
	// OTLP/JSON requires int64 timestamps to be stringified to preserve
	// precision in JSON consumers.
	out := formatUnixNano(1_700_000_000_000_000_000)
	if out != "1700000000000000000" {
		t.Errorf("formatUnixNano = %q, want 1700000000000000000", out)
	}
}

func TestOTELFormatUnixNanoNegativeRecovers(t *testing.T) {
	// Negative timestamps come from time.IsZero() events; the encoder should
	// fall back to a current timestamp rather than write a negative number.
	out := formatUnixNano(-1)
	if out == "" || out == "0" {
		t.Errorf("formatUnixNano(-1) = %q, want fallback to current time", out)
	}
}

func TestOTELHTTPDurationDualEmission(t *testing.T) {
	// HTTP duration is emitted both as the OTel-canonical seconds-as-double
	// AND as an ms int so dashboards that already speak ms keep working.
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "INFO",
		Fields: map[string]any{
			"method":           "GET",
			"path":             "/",
			"response_time_ms": 250,
		},
	}
	b, _ := For(FormatOTEL).Encode(e)
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "http.server.request.duration"); v == nil || v["doubleValue"].(float64) != 0.25 {
		t.Errorf("http.server.request.duration = %v, want 0.25 (250ms)", v)
	}
	if v := findAttr(attrs, "http.server.request.duration_ms"); v == nil || v["intValue"].(float64) != 250 {
		t.Errorf("http.server.request.duration_ms = %v, want 250", v)
	}
}

func TestOTELHTTPNoMethodNoLeak(t *testing.T) {
	// When `method` is empty, no http.request.method attribute should be
	// emitted — the OTel collector treats missing as "unknown" but emitting
	// an empty stringValue is a contract violation.
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"path":        "/",
			"status_code": 200,
		},
	}
	b, _ := For(FormatOTEL).Encode(e)
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "http.request.method"); v != nil {
		t.Errorf("http.request.method should be omitted when method is empty: %v", v)
	}
}

func TestOTELDatastoreDurationDualEmission(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassDatastoreActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"query":       "SELECT 1",
			"duration_ms": 750,
		},
	}
	b, _ := For(FormatOTEL).Encode(e)
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "db.client.operation.duration"); v == nil || v["doubleValue"].(float64) != 0.75 {
		t.Errorf("db.client.operation.duration = %v, want 0.75", v)
	}
	if v := findAttr(attrs, "db.client.operation.duration_ms"); v == nil || v["intValue"].(float64) != 750 {
		t.Errorf("db.client.operation.duration_ms = %v, want 750", v)
	}
	if v := findAttr(attrs, "db.system.name"); v == nil || v["stringValue"] != "mysql" {
		t.Errorf("db.system.name = %v, want mysql", v)
	}
}

func TestOTELOutcomeMatrix(t *testing.T) {
	cases := map[string]string{
		"Success":   "success",
		"succeeded": "success",
		"OK":        "success",
		"Failure":   "failure",
		"failed":    "failure",
		"error":     "failure",
		"weird":     "unknown",
	}
	for status, want := range cases {
		e := &event.LogEntry{
			Class: ClassAPIActivity,
			TS:    "2026-04-28T10:00:00.000Z",
			Fields: map[string]any{
				"operation": "GetThing",
				"status":    status,
			},
		}
		b, _ := For(FormatOTEL).Encode(e)
		record, _ := extractLogRecord(t, b)
		attrs := record["attributes"].([]any)
		v := findAttr(attrs, "event.outcome")
		if v == nil || v["stringValue"] != want {
			t.Errorf("status=%q: event.outcome = %v, want %q", status, v, want)
		}
	}
}

func TestOTELResourceTelemetrySDKAlwaysPresent(t *testing.T) {
	// Every record must carry telemetry.sdk.language so collectors that group
	// by emitter language don't drop our records into "unknown".
	e := &event.LogEntry{
		Source: "svc",
		TS:     "2026-04-28T10:00:00.000Z",
	}
	b, _ := For(FormatOTEL).Encode(e)
	_, resource := extractLogRecord(t, b)
	resAttrs := resource["attributes"].([]any)
	if v := findAttr(resAttrs, "telemetry.sdk.language"); v == nil || v["stringValue"] != "go" {
		t.Errorf("telemetry.sdk.language = %v, want go", v)
	}
}

func TestOTELLineNotPrettyPrinted(t *testing.T) {
	// OTLP/JSON over NDJSON requires one record per line — no embedded
	// newlines or indentation. A regression here breaks every line-delimited
	// reader (HEC, Fluent Bit, our own file sink).
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"method":      "GET",
			"path":        "/x",
			"status_code": 200,
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(string(b), "\n") {
		t.Errorf("OTEL encoded payload contains an embedded newline — breaks NDJSON: %q", string(b))
	}
}

func TestOCSFLineNotPrettyPrinted(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"method":      "GET",
			"path":        "/x",
			"status_code": 200,
		},
	}
	b, err := For(FormatOCSF).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(string(b), "\n") {
		t.Errorf("OCSF encoded payload contains an embedded newline — breaks NDJSON: %q", string(b))
	}
}

func TestOTELHTTPClientAddressOneOfMany(t *testing.T) {
	// HTTP client address can come in via remote_addr, client_ip, or src_ip.
	for _, key := range []string{"remote_addr", "client_ip", "src_ip"} {
		e := &event.LogEntry{
			Class: ClassHTTPActivity,
			TS:    "2026-04-28T10:00:00.000Z",
			Fields: map[string]any{
				"method": "GET",
				"path":   "/",
				key:      "9.8.7.6",
			},
		}
		b, _ := For(FormatOTEL).Encode(e)
		record, _ := extractLogRecord(t, b)
		attrs := record["attributes"].([]any)
		v := findAttr(attrs, "client.address")
		if v == nil || v["stringValue"] != "9.8.7.6" {
			t.Errorf("via %q: client.address = %v, want 9.8.7.6", key, v)
		}
	}
}

// formatUnixNano of a parsed RFC3339 timestamp must be deterministic — locking
// the conversion guards against silent timezone or precision changes that
// would otherwise scramble correlation across services.
func TestOTELTimestampDeterministic(t *testing.T) {
	e := &event.LogEntry{TS: "2026-04-28T10:00:00.000Z", Level: "INFO"}
	b, _ := For(FormatOTEL).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	rls := got["resourceLogs"].([]any)
	rl := rls[0].(map[string]any)
	scopeLogs := rl["scopeLogs"].([]any)
	sl := scopeLogs[0].(map[string]any)
	records := sl["logRecords"].([]any)
	rec := records[0].(map[string]any)
	if rec["timeUnixNano"] != "1777370400000000000" {
		t.Errorf("timeUnixNano = %v, want 1777370400000000000 (2026-04-28T10:00:00Z UTC)", rec["timeUnixNano"])
	}
	if rec["observedTimeUnixNano"] != rec["timeUnixNano"] {
		t.Errorf("observedTimeUnixNano %v != timeUnixNano %v", rec["observedTimeUnixNano"], rec["timeUnixNano"])
	}
}
