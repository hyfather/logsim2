package encoders

import (
	"encoding/json"
	"testing"

	"github.com/nikhilm/logsim2/pkg/event"
)

func TestOCSFHTTPActivity(t *testing.T) {
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

	b, err := For(FormatOCSF).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("decoded result not valid JSON: %v", err)
	}
	if got["class_uid"].(float64) != 4002 {
		t.Errorf("class_uid = %v, want 4002", got["class_uid"])
	}
	if got["activity_name"] != "POST" {
		t.Errorf("activity_name = %v, want POST", got["activity_name"])
	}
	// HTTP 500 must be reflected as Failure status.
	if got["status"] != "Failure" {
		t.Errorf("status = %v, want Failure", got["status"])
	}
	req := got["http_request"].(map[string]any)
	url := req["url"].(map[string]any)
	if url["path"] != "/api/orders" {
		t.Errorf("path = %v, want /api/orders", url["path"])
	}
	src := got["src_endpoint"].(map[string]any)
	if src["ip"] != "10.0.0.5" {
		t.Errorf("src ip = %v, want 10.0.0.5", src["ip"])
	}
}

func TestOCSFNetworkActivity(t *testing.T) {
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
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["class_uid"].(float64) != 4001 {
		t.Errorf("class_uid = %v, want 4001", got["class_uid"])
	}
	if got["action"] != "Allowed" {
		t.Errorf("action = %v, want Allowed", got["action"])
	}
}

func TestOCSFDatastoreActivity(t *testing.T) {
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
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["class_uid"].(float64) != 6005 {
		t.Errorf("class_uid = %v, want 6005", got["class_uid"])
	}
	if got["activity_name"] != "Read" {
		t.Errorf("activity_name = %v, want Read", got["activity_name"])
	}
}

func TestOCSFGenericFallback(t *testing.T) {
	e := &event.LogEntry{
		Sourcetype: "custom",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "hello",
	}
	b, err := For(FormatOCSF).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got["message"] != "hello" {
		t.Errorf("message preserved as %v", got["message"])
	}
}

func TestParseFormat(t *testing.T) {
	tests := []struct {
		in   string
		want Format
	}{
		{"", FormatNative},
		{"native", FormatNative},
		{"ocsf", FormatOCSF},
		{"udm", FormatUDM},
		{"asim", FormatASIM},
		{"unknown", FormatNative},
	}
	for _, tc := range tests {
		if got := Parse(tc.in); got != tc.want {
			t.Errorf("Parse(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
