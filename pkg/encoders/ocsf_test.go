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

func TestOCSFAuthenticationLogon(t *testing.T) {
	e := &event.LogEntry{
		Class:      ClassAuthentication,
		TS:         "2026-04-28T10:00:00.000Z",
		Sourcetype: "custom:aws-iam-events",
		Level:      "INFO",
		Raw:        "ConsoleLogin from rootUser",
		Fields: map[string]any{
			"event_name":         "ConsoleLogin",
			"user_type":          "Root",
			"user_name":          "root",
			"user_account_uid":   "111122223333",
			"actor_user_type":    "Root",
			"actor_user_name":    "root",
			"actor_user_uid":     "arn:aws:iam::111122223333:root",
			"src_ip":             "5.34.180.42",
			"src_country":        "TR",
			"is_mfa":             false,
			"auth_protocol":      "AWS Console Sign-In",
			"logon_type":         "Interactive",
			"dst_svc_name":       "signin.amazonaws.com",
			"region":             "us-east-1",
			"status":             "Success",
		},
	}
	b, err := For(FormatOCSF).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got["class_uid"].(float64) != 3002 {
		t.Errorf("class_uid = %v, want 3002", got["class_uid"])
	}
	if got["category_uid"].(float64) != 3 {
		t.Errorf("category_uid = %v, want 3", got["category_uid"])
	}
	if got["activity_id"].(float64) != 1 {
		t.Errorf("activity_id = %v, want 1 (Logon)", got["activity_id"])
	}
	if got["activity_name"] != "Logon" {
		t.Errorf("activity_name = %v, want Logon", got["activity_name"])
	}
	if got["type_uid"].(float64) != 300201 {
		t.Errorf("type_uid = %v, want 300201", got["type_uid"])
	}
	if got["type_name"] != "Authentication: Logon" {
		t.Errorf("type_name = %v, want Authentication: Logon", got["type_name"])
	}
	if got["is_mfa"] != false {
		t.Errorf("is_mfa = %v, want false", got["is_mfa"])
	}
	user := got["user"].(map[string]any)
	if user["name"] != "root" || user["type"] != "Root" {
		t.Errorf("user = %v, want root/Root", user)
	}
	src := got["src_endpoint"].(map[string]any)
	if src["ip"] != "5.34.180.42" {
		t.Errorf("src ip = %v", src["ip"])
	}
	loc := src["location"].(map[string]any)
	if loc["country"] != "TR" {
		t.Errorf("country = %v", loc["country"])
	}
	meta := got["metadata"].(map[string]any)
	if meta["version"] != "1.5.0" {
		t.Errorf("metadata.version = %v, want 1.5.0", meta["version"])
	}
}

func TestOCSFAccountChangeCreateAccessKey(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassAccountChange,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "WARN",
		Fields: map[string]any{
			"event_name":      "CreateAccessKey",
			"service_name":    "iam.amazonaws.com",
			"user_type":       "Root",
			"user_name":       "root",
			"actor_user_type": "Root",
			"actor_user_name": "root",
			"status":          "Success",
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["class_uid"].(float64) != 3001 {
		t.Errorf("class_uid = %v, want 3001", got["class_uid"])
	}
	if got["activity_id"].(float64) != 1 {
		t.Errorf("activity_id = %v, want 1 (Create)", got["activity_id"])
	}
	if got["activity_name"] != "Create" {
		t.Errorf("activity_name = %v, want Create", got["activity_name"])
	}
	api := got["api"].(map[string]any)
	if api["operation"] != "CreateAccessKey" {
		t.Errorf("api.operation = %v", api["operation"])
	}
}

func TestOCSFAccountChangeDeleteAccessKey(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassAccountChange,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "INFO",
		Fields: map[string]any{
			"event_name": "DeleteAccessKey",
			"user_name":  "root",
			"status":     "Success",
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["activity_id"].(float64) != 6 {
		t.Errorf("activity_id = %v, want 6 (Delete)", got["activity_id"])
	}
	if got["activity_name"] != "Delete" {
		t.Errorf("activity_name = %v, want Delete", got["activity_name"])
	}
}

func TestOCSFAccountChangeExplicitActivityID(t *testing.T) {
	// UpdateLoginProfile with passwordResetRequired=true is a Password Reset (4)
	// even though the verb starts with "Update". The template declares the
	// activity_id explicitly to override the verb-prefix heuristic.
	e := &event.LogEntry{
		Class: ClassAccountChange,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "INFO",
		Fields: map[string]any{
			"event_name":  "UpdateLoginProfile",
			"activity_id": 4,
			"user_name":   "root",
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["activity_id"].(float64) != 4 {
		t.Errorf("activity_id = %v, want 4 (Password Reset)", got["activity_id"])
	}
	if got["activity_name"] != "Password Reset" {
		t.Errorf("activity_name = %v, want Password Reset", got["activity_name"])
	}
	if got["type_uid"].(float64) != 300104 {
		t.Errorf("type_uid = %v, want 300104", got["type_uid"])
	}
}

func TestOCSFAPIActivityFromOperation(t *testing.T) {
	// Operation prefix wins over the HTTP verb because AWS describes reads as
	// POSTs — the OCSF activity_id should still be Read.
	e := &event.LogEntry{
		Class: ClassAPIActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "INFO",
		Fields: map[string]any{
			"operation":    "GetCostAndUsage",
			"service_name": "ce.amazonaws.com",
			"method":       "POST",
			"status":       "Success",
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["activity_id"].(float64) != 2 {
		t.Errorf("activity_id = %v, want 2 (Read)", got["activity_id"])
	}
	if got["activity_name"] != "Read" {
		t.Errorf("activity_name = %v, want Read", got["activity_name"])
	}
	api := got["api"].(map[string]any)
	if api["operation"] != "GetCostAndUsage" {
		t.Errorf("api.operation = %v", api["operation"])
	}
	svc := api["service"].(map[string]any)
	if svc["name"] != "ce.amazonaws.com" {
		t.Errorf("api.service.name = %v", svc["name"])
	}
}

func TestOCSFAPIActivityFailureStatus(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassAPIActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Level: "ERROR",
		Fields: map[string]any{
			"operation": "GetCostAndUsage",
			"status":    "Failure",
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["status"] != "Failure" {
		t.Errorf("status = %v, want Failure", got["status"])
	}
	if got["status_id"].(float64) != 2 {
		t.Errorf("status_id = %v, want 2", got["status_id"])
	}
}

// TestOCSFGenericFallbackInfersFromSource covers the broad case where a
// custom-template event arrives with no Class hint but does carry a
// service-path-shaped Source. The encoder should infer API Activity (6003)
// instead of collapsing every such event to Application Activity / Unknown.
func TestOCSFGenericFallbackInfersFromSource(t *testing.T) {
	e := &event.LogEntry{
		Source:     "control-plane.audit.host.cloudtrail-firehose",
		Sourcetype: "custom:cloudtrail-firehose-events",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "cloudtrail-firehose returned response",
	}
	b, err := For(FormatOCSF).Encode(e)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got["class_uid"].(float64) != 6003 {
		t.Errorf("class_uid = %v, want 6003 (API Activity)", got["class_uid"])
	}
	if got["activity_id"].(float64) != 2 {
		t.Errorf("activity_id = %v, want 2 (Read)", got["activity_id"])
	}
}

// TestOCSFGenericFallbackInfersAuthentication covers identity-shaped sources
// (AD DCs, signin endpoints, IdPs) routing to Authentication (3002) Logon.
func TestOCSFGenericFallbackInfersAuthentication(t *testing.T) {
	e := &event.LogEntry{
		Source:     "corp.identity.host.ad-dc-01",
		Sourcetype: "custom:ad-dc-01-events",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "ad-dc-01 returned response",
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["class_uid"].(float64) != 3002 {
		t.Errorf("class_uid = %v, want 3002 (Authentication)", got["class_uid"])
	}
	if got["activity_id"].(float64) != 1 {
		t.Errorf("activity_id = %v, want 1 (Logon)", got["activity_id"])
	}
}

// TestOCSFGenericFallbackInfersAccountChange covers free-text logs that
// mention IAM mutation event names without setting Class explicitly.
func TestOCSFGenericFallbackInfersAccountChange(t *testing.T) {
	e := &event.LogEntry{
		Source:     "control-plane.iam.host.aws-iam",
		Sourcetype: "custom:aws-iam-events",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "principal=alice eventName=DeleteAccessKey",
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["class_uid"].(float64) != 3001 {
		t.Errorf("class_uid = %v, want 3001 (Account Change)", got["class_uid"])
	}
}

// TestOCSFGenericFallbackKeepsUnknownForRawSource verifies a truly opaque
// event (no source path, no markers) still emits 6001/0 — the heuristic
// should never lie about classifying something it can't.
func TestOCSFGenericFallbackKeepsUnknownForRawSource(t *testing.T) {
	e := &event.LogEntry{
		Sourcetype: "custom",
		Level:      "INFO",
		TS:         "2026-04-28T10:00:00.000Z",
		Raw:        "hello",
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["class_uid"].(float64) != 6001 {
		t.Errorf("class_uid = %v, want 6001", got["class_uid"])
	}
	if got["activity_id"].(float64) != 0 {
		t.Errorf("activity_id = %v, want 0", got["activity_id"])
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
