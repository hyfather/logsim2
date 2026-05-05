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
	if v := findAttr(attrs, "network.security.action"); v == nil || v["stringValue"] != "accept" {
		t.Errorf("network.security.action = %v, want accept", v)
	}
	if v := findAttr(attrs, "event.outcome"); v == nil || v["stringValue"] != "success" {
		t.Errorf("event.outcome = %v, want success", v)
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
	// Source "demo.app" splits on "." into namespace="demo", service.name="app"
	// because dot-separated paths are first-class alongside slash paths.
	if v := findAttr(resAttrs, "service.name"); v == nil || v["stringValue"] != "app" {
		t.Errorf("service.name resource attribute missing or wrong: %v", v)
	}
	if v := findAttr(resAttrs, "service.namespace"); v == nil || v["stringValue"] != "demo" {
		t.Errorf("service.namespace resource attribute missing or wrong: %v", v)
	}
	if v := findAttr(resAttrs, "service.instance.id"); v == nil || v["stringValue"] != "demo.app" {
		t.Errorf("service.instance.id resource attribute missing or wrong: %v", v)
	}
}

func TestOTELParseFormat(t *testing.T) {
	if got := Parse("otel"); got != FormatOTEL {
		t.Errorf("Parse(\"otel\") = %q, want %q", got, FormatOTEL)
	}
}

// TestOTELAuthentication verifies that ConsoleLogin-style fields land on the
// OTel semconv keys we expect — without this the SIEM and observability
// pipelines see the data only as flat snake_case attributes and have to
// special-case logsim's encoding.
func TestOTELAuthentication(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassAuthentication,
		Source:     "control-plane-mirror/iam-edge/aws-iam-host/aws-iam",
		Sourcetype: "custom:aws-iam-events",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "rootUser ConsoleLogin",
		Fields: map[string]any{
			"operation":         "ConsoleLogin",
			"event_name":        "ConsoleLogin",
			"activity_id":       1,
			"service_name":      "signin.amazonaws.com",
			"request_uid":       "abc-123",
			"user_type":         "Root",
			"user_name":         "root",
			"user_uid":          "arn:aws:iam::111122223333:root",
			"user_account_uid":  "111122223333",
			"actor_user_type":   "Root",
			"actor_user_name":   "root",
			"actor_user_uid":    "arn:aws:iam::111122223333:root",
			"actor_account_uid": "111122223333",
			"src_ip":            "5.34.180.42",
			"src_country":       "TR",
			"user_agent":        "Mozilla/5.0",
			"auth_protocol":     "AWS Console Sign-In",
			"logon_type":        "Interactive",
			"is_mfa":            false,
			"is_remote":         true,
			"dst_svc_name":      "signin.amazonaws.com",
			"region":            "us-east-1",
			"cloud_provider":    "AWS",
			"status":            "Success",
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, resource := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)

	cases := map[string]string{
		"event.name":                  "ConsoleLogin",
		"rpc.service":                 "signin.amazonaws.com",
		"aws.request_id":              "abc-123",
		"user.name":                   "root",
		"user.id":                     "arn:aws:iam::111122223333:root",
		"user.role":                   "Root",
		"enduser.id":                  "root",
		"enduser.role":                "arn:aws:iam::111122223333:root",
		"enduser.scope":               "Root",
		"client.address":              "5.34.180.42",
		"client.geo.country.iso_code": "TR",
		"user_agent.original":         "Mozilla/5.0",
		"iam.auth_protocol":           "AWS Console Sign-In",
		"iam.logon_type":              "Interactive",
		"server.address":              "signin.amazonaws.com",
		"cloud.provider":              "aws",
		"cloud.region":                "us-east-1",
		"cloud.account.id":            "111122223333",
		"cloud.account.actor.id":      "111122223333",
		"event.outcome":               "success",
	}
	for k, want := range cases {
		v := findAttr(attrs, k)
		if v == nil {
			t.Errorf("missing attribute %s", k)
			continue
		}
		if v["stringValue"] != want {
			t.Errorf("%s = %v, want %q", k, v["stringValue"], want)
		}
	}
	if v := findAttr(attrs, "iam.is_mfa"); v == nil || v["boolValue"] != false {
		t.Errorf("iam.is_mfa = %v, want false", v)
	}
	if v := findAttr(attrs, "iam.is_remote"); v == nil || v["boolValue"] != true {
		t.Errorf("iam.is_remote = %v, want true", v)
	}
	if v := findAttr(attrs, "ocsf.activity_id"); v == nil || v["intValue"].(float64) != 1 {
		t.Errorf("ocsf.activity_id = %v, want 1", v)
	}

	// snake_case duplicates of consumed keys should NOT leak through.
	for _, leaked := range []string{
		"user_name", "user_uid", "user_type", "actor_user_name", "actor_user_uid",
		"actor_user_type", "src_ip", "src_country", "user_agent", "auth_protocol",
		"logon_type", "is_mfa", "is_remote", "operation", "event_name",
		"service_name", "request_uid", "user_account_uid", "actor_account_uid",
		"region", "cloud_provider", "status", "activity_id", "dst_svc_name",
	} {
		if v := findAttr(attrs, leaked); v != nil {
			t.Errorf("snake-case %s leaked into attributes alongside semconv mapping: %v", leaked, v)
		}
	}

	// Resource attributes: split source path.
	resAttrs := resource["attributes"].([]any)
	if v := findAttr(resAttrs, "service.name"); v == nil || v["stringValue"] != "aws-iam" {
		t.Errorf("resource service.name = %v, want aws-iam", v)
	}
	if v := findAttr(resAttrs, "host.name"); v == nil || v["stringValue"] != "aws-iam-host" {
		t.Errorf("resource host.name = %v, want aws-iam-host", v)
	}
	if v := findAttr(resAttrs, "service.namespace"); v == nil || v["stringValue"] != "control-plane-mirror/iam-edge" {
		t.Errorf("resource service.namespace = %v, want control-plane-mirror/iam-edge", v)
	}
	if v := findAttr(resAttrs, "cloud.provider"); v == nil || v["stringValue"] != "aws" {
		t.Errorf("resource cloud.provider = %v, want aws", v)
	}
	if v := findAttr(resAttrs, "cloud.region"); v == nil || v["stringValue"] != "us-east-1" {
		t.Errorf("resource cloud.region = %v, want us-east-1", v)
	}
	if v := findAttr(resAttrs, "cloud.account.id"); v == nil || v["stringValue"] != "111122223333" {
		t.Errorf("resource cloud.account.id = %v, want 111122223333", v)
	}
}

// TestOTELAccountChange covers IAM CreateAccessKey-style events.
func TestOTELAccountChange(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassAccountChange,
		Source:     "vpc/subnet/host/svc",
		Sourcetype: "custom:aws-iam-events",
		Level:      "WARN",
		TS:         "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"operation":      "CreateAccessKey",
			"event_name":     "CreateAccessKey",
			"activity_id":    1,
			"service_name":   "iam.amazonaws.com",
			"request_uid":    "req-1",
			"user_name":      "root",
			"user_uid":       "arn:aws:iam::111122223333:root",
			"region":         "us-east-1",
			"cloud_provider": "AWS",
			"status":         "Success",
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "event.name"); v == nil || v["stringValue"] != "CreateAccessKey" {
		t.Errorf("event.name = %v, want CreateAccessKey", v)
	}
	if v := findAttr(attrs, "rpc.method"); v == nil || v["stringValue"] != "CreateAccessKey" {
		t.Errorf("rpc.method = %v, want CreateAccessKey", v)
	}
	if v := findAttr(attrs, "rpc.service"); v == nil || v["stringValue"] != "iam.amazonaws.com" {
		t.Errorf("rpc.service = %v, want iam.amazonaws.com", v)
	}
	if v := findAttr(attrs, "user.name"); v == nil || v["stringValue"] != "root" {
		t.Errorf("user.name = %v, want root", v)
	}
	if v := findAttr(attrs, "event.outcome"); v == nil || v["stringValue"] != "success" {
		t.Errorf("event.outcome = %v, want success", v)
	}
}

// TestOTELAPIActivity covers the non-IAM CloudTrail traffic — billing /
// firehose / cloudtrail-firehose-style API reads — and verifies
// service_name / region / status all land on semconv keys.
func TestOTELAPIActivity(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassAPIActivity,
		Source:     "vpc/sub/host/svc",
		Sourcetype: "custom:aws-billing-console-events",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"operation":      "GetCostForecast",
			"event_name":     "GetCostForecast",
			"service_name":   "ce.amazonaws.com",
			"request_uid":    "req-2",
			"user_name":      "erin",
			"region":         "us-east-1",
			"cloud_provider": "AWS",
			"status":         "Failure",
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "event.name"); v == nil || v["stringValue"] != "GetCostForecast" {
		t.Errorf("event.name = %v, want GetCostForecast", v)
	}
	if v := findAttr(attrs, "rpc.method"); v == nil || v["stringValue"] != "GetCostForecast" {
		t.Errorf("rpc.method = %v, want GetCostForecast", v)
	}
	if v := findAttr(attrs, "aws.request_id"); v == nil || v["stringValue"] != "req-2" {
		t.Errorf("aws.request_id = %v, want req-2", v)
	}
	if v := findAttr(attrs, "event.outcome"); v == nil || v["stringValue"] != "failure" {
		t.Errorf("event.outcome = %v, want failure", v)
	}
	if v := findAttr(attrs, "error.type"); v == nil {
		t.Errorf("error.type missing for failure status")
	}
}

// TestOTELHTTPErrorMarking ensures a 5xx response is tagged with error.type
// so trace/log dashboards can pivot on a uniform error attribute regardless
// of whether the failing call surfaced as an HTTP response or an exception.
func TestOTELHTTPErrorMarking(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "ERROR",
		Raw:   "internal",
		Fields: map[string]any{
			"method":           "GET",
			"path":             "/api/health",
			"status_code":      503,
			"response_time_ms": 200,
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "error.type"); v == nil {
		t.Errorf("error.type missing on a 503 response")
	}
}

// TestOTELDatastoreSlowQuery covers the MySQL slow-query log emission path —
// the slow_query/slow_threshold_ms fields are otherwise easy to drop in the
// generic projection.
func TestOTELDatastoreSlowQuery(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassDatastoreActivity,
		Sourcetype: "mysql",
		Level:      "WARN",
		TS:         "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"query":             "SELECT * FROM users WHERE id = 1",
			"database":          "app",
			"query_time_ms":     2500,
			"slow_query":        true,
			"slow_threshold_ms": 1000,
			"conn_id":           4242,
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)

	if v := findAttr(attrs, "db.slow_query"); v == nil || v["boolValue"] != true {
		t.Errorf("db.slow_query missing or wrong: %v", v)
	}
	if v := findAttr(attrs, "db.slow_query.threshold_ms"); v == nil || v["intValue"].(float64) != 1000 {
		t.Errorf("db.slow_query.threshold_ms = %v, want 1000", v)
	}
	if v := findAttr(attrs, "db.client.operation.duration_ms"); v == nil || v["intValue"].(float64) != 2500 {
		t.Errorf("db.client.operation.duration_ms = %v, want 2500", v)
	}
	if v := findAttr(attrs, "db.connection_id"); v == nil || v["intValue"].(float64) != 4242 {
		t.Errorf("db.connection_id = %v, want 4242", v)
	}
	if v := findAttr(attrs, "error.type"); v == nil || v["stringValue"] != "slow_query" {
		t.Errorf("error.type = %v, want slow_query", v)
	}

	// snake_case versions should be consumed.
	for _, leaked := range []string{"slow_query", "slow_threshold_ms", "conn_id", "query", "database", "query_time_ms"} {
		if v := findAttr(attrs, leaked); v != nil {
			t.Errorf("snake-case %s leaked into attributes: %v", leaked, v)
		}
	}
}

// TestOTELHTTPUserAgent ensures a user_agent field surfaces on the
// `user_agent.original` semconv key when the entry is HTTP-classed.
func TestOTELHTTPUserAgent(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "INFO",
		Fields: map[string]any{
			"method":     "GET",
			"path":       "/",
			"user_agent": "curl/8.4.0",
		},
	}
	b, err := For(FormatOTEL).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	record, _ := extractLogRecord(t, b)
	attrs := record["attributes"].([]any)
	if v := findAttr(attrs, "user_agent.original"); v == nil || v["stringValue"] != "curl/8.4.0" {
		t.Errorf("user_agent.original = %v, want curl/8.4.0", v)
	}
}

// TestOTELSourcePathSplit covers the four shapes the engine can hand us:
// dotted, slashed, single-segment, and a deeply nested path.
func TestOTELSourcePathSplit(t *testing.T) {
	cases := []struct {
		in        string
		ns, h, sv string
	}{
		{"", "", "", ""},
		{"svc", "", "", "svc"},
		{"host/svc", "host", "", "svc"},
		{"vpc/subnet/host/svc", "vpc/subnet", "host", "svc"},
		{"a/b/c/d/e", "a/b/c", "d", "e"},
		{"a.b.c.d", "a.b", "c", "d"},
	}
	for _, c := range cases {
		ns, h, sv := splitSourcePath(c.in)
		if ns != c.ns || h != c.h || sv != c.sv {
			t.Errorf("splitSourcePath(%q) = (%q,%q,%q), want (%q,%q,%q)",
				c.in, ns, h, sv, c.ns, c.h, c.sv)
		}
	}
}

// TestOTELAttributesAlwaysArray ensures `attributes` is a JSON array even
// when the entry has no class and no fields. OTLP/JSON requires the field be
// `[]`, not `null`; a strict collector rejects records where the shape drifts.
func TestOTELAttributesAlwaysArray(t *testing.T) {
	cases := []*event.LogEntry{
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "no class no fields"},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassAPIActivity},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassAuthentication},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassAccountChange},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassHTTPActivity},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassNetworkActivity},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassDatastoreActivity},
		{TS: "2026-04-28T10:00:00.000Z", Level: "INFO", Raw: "class no fields", Class: ClassApplicationLifecycle},
	}
	for _, e := range cases {
		b, err := For(FormatOTEL).Encode(e)
		if err != nil {
			t.Fatalf("encode %v: %v", e.Class, err)
		}
		var got map[string]any
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatalf("decode %v: %v", e.Class, err)
		}
		record, _ := extractLogRecord(t, b)
		attrs, ok := record["attributes"]
		if !ok {
			t.Errorf("class=%q: attributes key missing", e.Class)
			continue
		}
		if attrs == nil {
			t.Errorf("class=%q: attributes is null, want [] (OTLP/JSON requires array)", e.Class)
			continue
		}
		if _, ok := attrs.([]any); !ok {
			t.Errorf("class=%q: attributes is %T, want []any", e.Class, attrs)
		}
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
