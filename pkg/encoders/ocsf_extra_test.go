package encoders

import (
	"encoding/json"
	"testing"

	"github.com/nikhilm/logsim2/pkg/event"
)

// Supplemental OCSF tests that lock down each branch of the helper mappings
// (severity, http verb, sql verb, action, status, identity). Without these,
// regressions like "WARN events show up as Informational" or "DELETE collapses
// to Unknown" can land silently because no existing test asserts the matrix.

func TestOCSFSeverityFromLevelMatrix(t *testing.T) {
	cases := []struct {
		level string
		id    int
		name  string
	}{
		{"DEBUG", 1, "Informational"},
		{"INFO", 1, "Informational"},
		{"WARN", 3, "Medium"},
		{"WARNING", 3, "Medium"},
		{"ERROR", 4, "High"},
		{"FATAL", 5, "Critical"},
		{"CRITICAL", 5, "Critical"},
		{"weird", 0, "Unknown"},
		{"", 0, "Unknown"},
	}
	for _, c := range cases {
		gotID, gotName := severityFromLevel(c.level)
		if gotID != c.id || gotName != c.name {
			t.Errorf("severityFromLevel(%q) = (%d,%q), want (%d,%q)", c.level, gotID, gotName, c.id, c.name)
		}
	}
}

func TestOCSFHTTPActivityIDMatrix(t *testing.T) {
	cases := map[string]struct {
		id   int
		name string
	}{
		"GET":     {1, "GET"},
		"HEAD":    {1, "GET"},
		"POST":    {2, "POST"},
		"PUT":     {3, "PUT"},
		"DELETE":  {4, "DELETE"},
		"OPTIONS": {6, "OPTIONS"},
		"PATCH":   {8, "PATCH"},
		"TRACE":   {0, "Unknown"},
		"":        {0, "Unknown"},
	}
	for in, want := range cases {
		id, name := httpActivity(in)
		if id != want.id || name != want.name {
			t.Errorf("httpActivity(%q) = (%d,%q), want (%d,%q)", in, id, name, want.id, want.name)
		}
	}
}

func TestOCSFSQLActivityIDMatrix(t *testing.T) {
	cases := map[string]struct {
		id   int
		name string
	}{
		"SELECT * FROM t":     {1, "Read"},
		" select x from y ":   {1, "Read"},
		"INSERT INTO t":       {5, "Create"},
		"UPDATE t SET":        {3, "Update"},
		"DELETE FROM t":       {4, "Delete"},
		"GRANT SELECT ON":     {0, "Unknown"},
		"":                    {0, "Unknown"},
	}
	for q, want := range cases {
		id, name := sqlActivity(q)
		if id != want.id || name != want.name {
			t.Errorf("sqlActivity(%q) = (%d,%q), want (%d,%q)", q, id, name, want.id, want.name)
		}
	}
}

func TestOCSFAccountChangeActivityMatrix(t *testing.T) {
	cases := []struct {
		op   string
		id   int
		name string
	}{
		{"CreateUser", 1, "Create"},
		{"EnableMFA", 2, "Enable"},
		{"ChangePassword", 3, "Password Change"},
		{"ResetPassword", 4, "Password Reset"},
		{"DisableUser", 5, "Disable"},
		{"DeactivateMFADevice", 5, "Disable"},
		{"DeleteUser", 6, "Delete"},
		{"RemoveUserFromGroup", 6, "Delete"},
		{"AttachUserPolicy", 7, "Attach Policy"},
		{"DetachUserPolicy", 8, "Detach Policy"},
		{"AccountLockout", 9, "Lockout"},
		{"DescribeUser", 0, "Unknown"},
		{"", 0, "Unknown"},
	}
	for _, c := range cases {
		id, name := accountChangeActivity(c.op)
		if id != c.id || name != c.name {
			t.Errorf("accountChangeActivity(%q) = (%d,%q), want (%d,%q)", c.op, id, name, c.id, c.name)
		}
	}
}

func TestOCSFAPIActivityMatrix(t *testing.T) {
	cases := []struct {
		op, method string
		id         int
		name       string
	}{
		{"CreateBucket", "", 1, "Create"},
		{"PutObject", "", 1, "Create"},
		{"GetCostAndUsage", "POST", 2, "Read"},
		{"DescribeInstances", "GET", 2, "Read"},
		{"ListUsers", "GET", 2, "Read"},
		{"LookupEvents", "POST", 2, "Read"},
		{"SearchObjects", "GET", 2, "Read"},
		{"UpdateProfile", "POST", 3, "Update"},
		{"ModifyInstance", "POST", 3, "Update"},
		{"PatchPolicy", "POST", 3, "Update"},
		{"SetLoggingOptions", "POST", 3, "Update"},
		{"DeleteUser", "DELETE", 4, "Delete"},
		{"RemoveTags", "POST", 4, "Delete"},
		{"TerminateInstance", "POST", 4, "Delete"},
		{"", "POST", 1, "Create"},
		{"", "GET", 2, "Read"},
		{"", "PUT", 3, "Update"},
		{"", "PATCH", 3, "Update"},
		{"", "DELETE", 4, "Delete"},
		{"", "WEIRD", 2, "Read"},
	}
	for _, c := range cases {
		id, name := apiActivity(c.op, c.method)
		if id != c.id || name != c.name {
			t.Errorf("apiActivity(%q, %q) = (%d,%q), want (%d,%q)", c.op, c.method, id, name, c.id, c.name)
		}
	}
}

func TestOCSFStatusMappingMatrix(t *testing.T) {
	cases := map[string]struct {
		id   int
		name string
	}{
		"Success":    {1, "Success"},
		"succeeded":  {1, "Success"},
		"OK":         {1, "Success"},
		"Failure":    {2, "Failure"},
		"failed":     {2, "Failure"},
		"FAIL":       {2, "Failure"},
		"error":      {2, "Failure"},
		"denied":     {2, "Failure"},
		"unknown":    {0, "Unknown"},
		"   ":        {0, "Unknown"},
	}
	for status, want := range cases {
		out := map[string]any{}
		applyStatus(out, status)
		gotID, _ := out["status_id"].(int)
		gotName, _ := out["status"].(string)
		if gotID != want.id || gotName != want.name {
			t.Errorf("applyStatus(%q) = (%d,%q), want (%d,%q)", status, gotID, gotName, want.id, want.name)
		}
	}
}

func TestOCSFNetworkActivityActionMappingDeny(t *testing.T) {
	// REJECT/DENY/DROP should all flip to Denied. Accept-only is already
	// covered by TestOCSFNetworkActivity in ocsf_test.go.
	for _, act := range []string{"REJECT", "DENY", "DROP", "reject"} {
		e := &event.LogEntry{
			Class: ClassNetworkActivity,
			TS:    "2026-04-28T10:00:00.000Z",
			Fields: map[string]any{
				"src_ip": "10.0.1.5",
				"dst_ip": "10.0.2.7",
				"action": act,
			},
		}
		b, _ := For(FormatOCSF).Encode(e)
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		if got["action"] != "Denied" {
			t.Errorf("action=%q: action = %v, want Denied", act, got["action"])
		}
		if got["action_id"].(float64) != 2 {
			t.Errorf("action=%q: action_id = %v, want 2", act, got["action_id"])
		}
	}
}

func TestOCSFHTTPSourceFromMultipleIPFields(t *testing.T) {
	// Verifies that any of client_ip / remote_addr / src_ip is recognised so
	// generators that disagree on field naming all light up src_endpoint.
	for _, key := range []string{"client_ip", "remote_addr", "src_ip"} {
		e := &event.LogEntry{
			Class: ClassHTTPActivity,
			TS:    "2026-04-28T10:00:00.000Z",
			Fields: map[string]any{
				"method":      "GET",
				"path":        "/x",
				"status_code": 200,
				key:           "1.2.3.4",
			},
		}
		b, _ := For(FormatOCSF).Encode(e)
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		src, ok := got["src_endpoint"].(map[string]any)
		if !ok || src["ip"] != "1.2.3.4" {
			t.Errorf("ip via %q: src_endpoint.ip = %v, want 1.2.3.4", key, src)
		}
	}
}

func TestOCSFTypeUIDComputation(t *testing.T) {
	// type_uid is class_uid * 100 + activity_id — locks the OCSF identity
	// triple together so analytics engines can join cleanly.
	e := &event.LogEntry{
		Class: ClassHTTPActivity,
		TS:    "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"method":      "POST",
			"path":        "/x",
			"status_code": 201,
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["type_uid"].(float64) != 400202 {
		t.Errorf("type_uid = %v, want 400202 (4002 * 100 + 2 POST)", got["type_uid"])
	}
	if got["type_name"] != "HTTP Activity: POST" {
		t.Errorf("type_name = %v, want HTTP Activity: POST", got["type_name"])
	}
}

func TestOCSFAuthenticationLogoff(t *testing.T) {
	e := &event.LogEntry{
		Class: ClassAuthentication,
		TS:    "2026-04-28T10:00:00.000Z",
		Fields: map[string]any{
			"event_name": "ConsoleLogout",
			"user_name":  "alice",
		},
	}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["activity_id"].(float64) != 2 {
		t.Errorf("activity_id = %v, want 2 (Logoff)", got["activity_id"])
	}
	if got["activity_name"] != "Logoff" {
		t.Errorf("activity_name = %v, want Logoff", got["activity_name"])
	}
}

func TestOCSFParseTimeFallsBackToNow(t *testing.T) {
	// A zero-value timestamp should still produce a valid timestamp on the
	// event; parseTime falls back to time.Now(). Without that, the OCSF
	// `time` field would be zero and downstream queries would skip the event.
	e := &event.LogEntry{Class: ClassHTTPActivity, TS: "garbage", Fields: map[string]any{"method": "GET"}}
	b, _ := For(FormatOCSF).Encode(e)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if t1, ok := got["time"].(float64); !ok || t1 == 0 {
		t.Errorf("time = %v (%T), want a non-zero millisecond timestamp", got["time"], got["time"])
	}
}

func TestOCSFMetadataAlwaysPresent(t *testing.T) {
	// Every OCSF builder must emit the metadata block — analytics engines
	// pivot on metadata.uid for de-dupe and metadata.original_time for
	// ingestion lag estimates.
	classes := []string{
		ClassHTTPActivity, ClassNetworkActivity, ClassDatastoreActivity,
		ClassApplicationLifecycle, ClassAPIActivity, ClassAuthentication,
		ClassAccountChange,
	}
	for _, cls := range classes {
		e := &event.LogEntry{
			ID:    "uid-1",
			Class: cls,
			TS:    "2026-04-28T10:00:00.000Z",
			Fields: map[string]any{
				"method":      "GET",
				"path":        "/",
				"status_code": 200,
				"src_ip":      "1.2.3.4",
				"dst_ip":      "5.6.7.8",
				"protocol":    6,
				"query":       "SELECT 1",
				"port":        8080,
				"event_name":  "GetThing",
				"user_name":   "alice",
			},
		}
		b, err := For(FormatOCSF).Encode(e)
		if err != nil {
			t.Fatalf("class=%s: encode: %v", cls, err)
		}
		var got map[string]any
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatalf("class=%s: not JSON: %v", cls, err)
		}
		meta, ok := got["metadata"].(map[string]any)
		if !ok {
			t.Errorf("class=%s: metadata block missing", cls)
			continue
		}
		if meta["uid"] != "uid-1" {
			t.Errorf("class=%s: metadata.uid = %v, want uid-1", cls, meta["uid"])
		}
		if meta["version"] == nil {
			t.Errorf("class=%s: metadata.version missing", cls)
		}
	}
}
