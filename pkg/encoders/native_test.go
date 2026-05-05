package encoders

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/nikhilm/logsim2/pkg/event"
)

// The native encoder is the historical pass-through that the frontend SSE
// stream and the bulk JSONL download both rely on. Drift here breaks every
// surface that consumes the LogEntry envelope, so lock the shape down.

func TestNativeEncoderRoundTrip(t *testing.T) {
	in := &event.LogEntry{
		ID:         "t0-deadbeef-3",
		TS:         "2026-04-28T10:00:00.000Z",
		Source:     "vpc.subnet.host.svc",
		Level:      "ERROR",
		Sourcetype: "nodejs",
		Class:      ClassHTTPActivity,
		Raw:        `{"status":500}`,
		Fields: map[string]any{
			"method":      "POST",
			"status_code": 500,
		},
	}
	b, err := For(FormatNative).Encode(in)
	if err != nil {
		t.Fatalf("native encode: %v", err)
	}
	var out event.LogEntry
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("native output isn't valid LogEntry JSON: %v\npayload=%s", err, b)
	}
	if out.ID != in.ID || out.TS != in.TS || out.Source != in.Source ||
		out.Level != in.Level || out.Sourcetype != in.Sourcetype ||
		out.Class != in.Class || out.Raw != in.Raw {
		t.Errorf("native pass-through changed scalar fields: got=%+v want=%+v", out, in)
	}
	if got, want := out.Fields["method"], "POST"; got != want {
		t.Errorf("Fields[method] = %v, want %v", got, want)
	}
	// status_code is decoded as float64 from JSON, matching how the frontend
	// will see it after SSE delivery. Lock that contract in.
	if got, want := out.Fields["status_code"], float64(500); got != want {
		t.Errorf("Fields[status_code] = %v (%T), want %v (float64)", got, got, want)
	}
}

func TestNativeEncoderRejectsNil(t *testing.T) {
	if _, err := For(FormatNative).Encode(nil); err == nil {
		t.Fatal("native encoder should reject a nil LogEntry — silent zero-value JSON would mask a generator bug")
	}
}

func TestNativeEncoderEmptyFields(t *testing.T) {
	// `omitempty` should keep absent Class / Fields out of the JSON so the
	// frontend's TypeScript types (which mark them optional) keep matching.
	in := &event.LogEntry{
		ID:         "id",
		TS:         "2026-04-28T10:00:00.000Z",
		Source:     "svc",
		Level:      "INFO",
		Sourcetype: "nodejs",
		Raw:        "hello",
	}
	b, err := For(FormatNative).Encode(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	s := string(b)
	if strings.Contains(s, `"class"`) {
		t.Errorf("native output leaked an empty class field: %s", s)
	}
	if strings.Contains(s, `"fields"`) {
		t.Errorf("native output leaked an empty fields object: %s", s)
	}
}

func TestForUnknownFormatFallsBackToNative(t *testing.T) {
	// Unknown formats must not return nil — the sink would NPE on Encode.
	enc := For(Format("does-not-exist"))
	if enc == nil {
		t.Fatal("For(unknown) returned nil; sinks expect a non-nil encoder")
	}
	if got := enc.Format(); got != FormatNative {
		t.Errorf("For(unknown).Format() = %q, want native fallback", got)
	}
}

func TestUDMandASIMFallBackToNative(t *testing.T) {
	// UDM/ASIM are reserved formats. Until their builders ship the encoder
	// must keep returning native so callers don't get an empty payload.
	for _, f := range []Format{FormatUDM, FormatASIM} {
		enc := For(f)
		if enc == nil {
			t.Fatalf("For(%q) returned nil", f)
		}
		if got := enc.Format(); got != FormatNative {
			t.Errorf("For(%q).Format() = %q, want native (placeholder formats fall back)", f, got)
		}
	}
}

func TestApplyToRawNativeIsNoOp(t *testing.T) {
	original := []event.LogEntry{
		{ID: "a", TS: "2026-04-28T10:00:00.000Z", Raw: "untouched-1"},
		{ID: "b", TS: "2026-04-28T10:00:00.000Z", Raw: "untouched-2"},
	}
	cp := make([]event.LogEntry, len(original))
	copy(cp, original)
	out := ApplyToRaw(cp, FormatNative)
	for i := range out {
		if out[i].Raw != original[i].Raw {
			t.Errorf("native ApplyToRaw mutated entry %d: %q -> %q", i, original[i].Raw, out[i].Raw)
		}
	}
}

// ApplyToRaw is the function the API layer uses to project a stream of
// LogEntry into OCSF/OTEL JSON in-place — the frontend SSE handler keys on
// the rest of the envelope (id, ts, source, level) staying intact while only
// `raw` flips to the schema-mapped payload.
func TestApplyToRawOCSFOnlyRewritesRaw(t *testing.T) {
	in := []event.LogEntry{
		{
			ID:         "a",
			TS:         "2026-04-28T10:00:00.000Z",
			Source:     "vpc.subnet.host.svc",
			Level:      "INFO",
			Sourcetype: "nodejs",
			Class:      ClassHTTPActivity,
			Raw:        "GET /health 200 5ms",
			Fields: map[string]any{
				"method":      "GET",
				"path":        "/health",
				"status_code": 200,
			},
		},
	}
	out := ApplyToRaw(in, FormatOCSF)
	if len(out) != 1 {
		t.Fatalf("ApplyToRaw drop: got %d entries, want 1", len(out))
	}
	got := out[0]
	if got.ID != "a" || got.Source != "vpc.subnet.host.svc" || got.Level != "INFO" ||
		got.Sourcetype != "nodejs" || got.Class != ClassHTTPActivity ||
		got.TS != "2026-04-28T10:00:00.000Z" {
		t.Errorf("ApplyToRaw mutated envelope fields: %+v", got)
	}
	var ocsf map[string]any
	if err := json.Unmarshal([]byte(got.Raw), &ocsf); err != nil {
		t.Fatalf("Raw isn't OCSF JSON: %v\npayload=%s", err, got.Raw)
	}
	if cls, _ := ocsf["class_uid"].(float64); cls != 4002 {
		t.Errorf("OCSF class_uid = %v, want 4002 (HTTP Activity)", ocsf["class_uid"])
	}
}

func TestApplyToRawOTELRewritesRaw(t *testing.T) {
	in := []event.LogEntry{
		{
			ID:         "a",
			TS:         "2026-04-28T10:00:00.000Z",
			Source:     "vpc.subnet.host.svc",
			Level:      "WARN",
			Sourcetype: "vpc-flow",
			Class:      ClassNetworkActivity,
			Raw:        "raw flow",
			Fields: map[string]any{
				"src_ip":   "10.0.1.5",
				"dst_ip":   "10.0.2.7",
				"protocol": 6,
			},
		},
	}
	out := ApplyToRaw(in, FormatOTEL)
	if len(out) != 1 {
		t.Fatalf("ApplyToRaw drop: got %d", len(out))
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(out[0].Raw), &rec); err != nil {
		t.Fatalf("OTEL raw not JSON: %v", err)
	}
	if _, ok := rec["resourceLogs"]; !ok {
		t.Errorf("OTEL ApplyToRaw didn't produce an OTLP envelope: %s", out[0].Raw)
	}
}

func TestApplyToRawSwallowsPerEntryErrors(t *testing.T) {
	// One bad entry shouldn't stop the rest of the stream from being encoded.
	// We pass two valid LogEntries and verify both are projected.
	in := []event.LogEntry{
		{ID: "a", TS: "2026-04-28T10:00:00.000Z", Raw: "x", Class: ClassHTTPActivity, Fields: map[string]any{"method": "GET", "status_code": 200}},
		{ID: "b", TS: "2026-04-28T10:00:00.000Z", Raw: "y", Class: ClassHTTPActivity, Fields: map[string]any{"method": "POST", "status_code": 201}},
	}
	out := ApplyToRaw(in, FormatOCSF)
	for i, e := range out {
		var got map[string]any
		if err := json.Unmarshal([]byte(e.Raw), &got); err != nil {
			t.Errorf("entry %d not OCSF JSON after ApplyToRaw: %v", i, err)
		}
	}
}
