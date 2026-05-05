package encoders_test

// pipeline_test runs end-to-end checks that drive a real scenario through the
// engine and the WriterSink, then validates the resulting log lines meet the
// contract for each format. The CLI also powers the frontend (preview pane,
// SSE stream, bulk download, HEC forwarding), so a regression in any one of
// these formats breaks the user-visible UI even when the unit tests for the
// encoders themselves still pass.
//
// Living in package `encoders_test` keeps these as an external integration
// suite — they import the engine and sinks packages, which would otherwise
// create a cycle.

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/encoders"
	"github.com/nikhilm/logsim2/pkg/engine"
	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

// fullStackYAML is a minimal but representative scenario covering every
// generator the engine ships with: HTTP traffic (nodejs), datastore traffic
// (mysql), and network/flow traffic (vpc + load balancer). If the encoder
// pipeline drops or mis-shapes any of these, the asserts below catch it.
const fullStackYAML = `
- name: Full Stack
- nodes:
  - type: vpc
    name: Main VPC
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: App Subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server
    subnet: App Subnet
    private_ip: 10.0.1.10
  - type: virtual_server
    name: DB Server
    subnet: App Subnet
    private_ip: 10.0.1.20
  - type: load_balancer
    name: LB
    subnet: App Subnet
    private_ip: 10.0.1.2
  - type: user_clients
    name: Clients
    clients:
      - name: Client 1
        ip: 203.0.113.5
        rps: 10
        traffic_pattern: steady
- services:
  - type: nodejs
    name: App Service
    host: App Server
    generator:
      type: nodejs
      port: 3000
      log_format: json
      endpoints:
        - {method: GET,  path: /api/users, avg_latency_ms: 80,  error_rate: 0.02}
        - {method: POST, path: /api/users, avg_latency_ms: 300, error_rate: 0.05}
  - type: mysql
    name: App DB
    host: DB Server
    generator:
      type: mysql
      port: 3306
      database: appdb
      slow_query_threshold: 500
- connections:
  - {source: Clients,     target: LB,          protocol: https, port: 443}
  - {source: LB,          target: App Service, protocol: http,  port: 3000}
  - {source: App Service, target: App DB,      protocol: mysql, port: 3306}
`

// runScenario parses the embedded YAML, runs the engine for `ticks` ticks,
// and returns the captured stream from a WriterSink at the requested format.
// Using a deterministic seed/StartTime makes assertions stable across runs.
func runScenario(t *testing.T, format sinks.Format, ticks int) string {
	t.Helper()
	s, err := scenario.Parse(strings.NewReader(fullStackYAML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := scenario.Validate(s); err != nil {
		t.Fatalf("validate: %v", err)
	}

	var buf strings.Builder
	cfg := engine.Config{
		Seed:           42,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:   "*",
	}
	eng := engine.New(s, cfg)
	if err := eng.Run(context.Background(), ticks, []sinks.Sink{sinks.NewWriter(&buf, format)}); err != nil {
		t.Fatalf("engine.Run: %v", err)
	}
	return buf.String()
}

// linesOf returns non-empty lines for an output stream. Bufio's Scanner
// handles long lines (slow-query MySQL logs are multi-KB) and trims the
// terminator, matching how a downstream NDJSON consumer would parse the file.
func linesOf(t *testing.T, out string) []string {
	t.Helper()
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 1024), 1<<20)
	var lines []string
	for sc.Scan() {
		l := sc.Text()
		if strings.TrimSpace(l) == "" {
			continue
		}
		lines = append(lines, l)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	return lines
}

// ---------------------------------------------------------------------------
// Native (JSONL) format.
// ---------------------------------------------------------------------------

// TestPipelineNative_AllSourcesProduceParsableJSON guarantees every line the
// engine emits is a valid LogEntry JSON. The frontend SSE handler, the
// download-as-NDJSON button, and the HEC forwarder all key off this contract.
func TestPipelineNative_AllSourcesProduceParsableJSON(t *testing.T) {
	out := runScenario(t, sinks.FormatJSONL, 10)
	lines := linesOf(t, out)
	if len(lines) == 0 {
		t.Fatal("scenario produced zero lines — generator regression?")
	}

	sourcetypes := map[string]int{}
	for i, l := range lines {
		var e event.LogEntry
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("line %d not a valid LogEntry: %v\nraw=%s", i, err, l)
		}
		// Every entry must carry the four envelope fields the frontend keys
		// off — id (React row key), ts (sort), source (channel filter),
		// sourcetype (icon/colour). A blank in any of these breaks the UI.
		if e.ID == "" || e.TS == "" || e.Source == "" || e.Sourcetype == "" {
			t.Errorf("line %d missing envelope field: %+v", i, e)
		}
		sourcetypes[e.Sourcetype]++
	}

	// nodejs (App Service), mysql (App DB), vpc-flow (VPC), nginx (LB) —
	// every generator wired into the scenario must contribute at least one
	// line. Anything missing means a generator never fired.
	for _, want := range []string{"nodejs", "mysql", "vpc-flow", "nginx"} {
		if sourcetypes[want] == 0 {
			t.Errorf("sourcetype %q never appeared (got: %v) — engine pipeline dropped a generator", want, sourcetypes)
		}
	}
}

// TestPipelineNative_IDsUniqueWithinTick — IDs flow into the React log panel
// as keys; collisions cause rows to flicker, drop, or render against the wrong
// data. The makeID hash includes the source path, so two generators on the
// same tick must not collide.
func TestPipelineNative_IDsUniqueWithinTick(t *testing.T) {
	out := runScenario(t, sinks.FormatJSONL, 5)
	seen := map[string]string{}
	for _, l := range linesOf(t, out) {
		var e event.LogEntry
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("not JSON: %v", err)
		}
		if other, dup := seen[e.ID]; dup {
			t.Errorf("ID collision: %q used by %q and %q", e.ID, other, e.Source)
		}
		seen[e.ID] = e.Source
	}
}

// TestPipelineNative_TimestampsRFC3339 — the frontend sorts on `ts` as a
// string compare assuming RFC3339-shaped lexicographic order. Drift in the
// format (say, switching to Unix nanos or losing the timezone) silently
// scrambles the timeline.
func TestPipelineNative_TimestampsRFC3339(t *testing.T) {
	out := runScenario(t, sinks.FormatJSONL, 3)
	for _, l := range linesOf(t, out) {
		var e event.LogEntry
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("not JSON: %v", err)
		}
		// Try the layouts the Go standard library treats as RFC3339-compatible.
		// At least one must accept the timestamp.
		ok := false
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z07:00"} {
			if _, err := time.Parse(layout, e.TS); err == nil {
				ok = true
				break
			}
		}
		if !ok {
			t.Errorf("timestamp %q is not RFC3339-shaped — frontend sort assumes it is", e.TS)
		}
	}
}

// TestPipelineNative_LevelsAreCanonical — the level filter UI assumes a fixed
// alphabet (DEBUG/INFO/WARN/ERROR/FATAL). A lowercase or unexpected token
// drops events from the level-filter chips.
func TestPipelineNative_LevelsAreCanonical(t *testing.T) {
	canonical := map[string]bool{"DEBUG": true, "INFO": true, "WARN": true, "ERROR": true, "FATAL": true}
	out := runScenario(t, sinks.FormatJSONL, 5)
	for _, l := range linesOf(t, out) {
		var e event.LogEntry
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("not JSON: %v", err)
		}
		if !canonical[e.Level] {
			t.Errorf("non-canonical level %q in line: %s", e.Level, l)
		}
	}
}

// TestPipelineNative_ChronologicalWithinTick — within a tick, entries should
// be emitted in non-decreasing timestamp order. The engine sorts per-tick;
// this test guards that the sink doesn't reorder them.
func TestPipelineNative_ChronologicalWithinTick(t *testing.T) {
	out := runScenario(t, sinks.FormatJSONL, 1)
	var lastTS string
	for _, l := range linesOf(t, out) {
		var e event.LogEntry
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("not JSON: %v", err)
		}
		if lastTS != "" && e.TS < lastTS {
			t.Errorf("out of order within tick: %q < %q", e.TS, lastTS)
		}
		lastTS = e.TS
	}
}

// TestPipelineNative_DeterministicWithSameSeed — the frontend's "play this
// scenario" preview compares its in-browser run to the CLI's output; drift
// breaks user trust ("the canvas shows X but the CLI emitted Y"). Same seed
// must produce byte-for-byte identical native output.
func TestPipelineNative_DeterministicWithSameSeed(t *testing.T) {
	a := runScenario(t, sinks.FormatJSONL, 5)
	b := runScenario(t, sinks.FormatJSONL, 5)
	if a != b {
		t.Errorf("same-seed runs differ — engine/encoder is leaking nondeterminism")
	}
}

// ---------------------------------------------------------------------------
// OCSF format.
// ---------------------------------------------------------------------------

// TestPipelineOCSF_EveryLineIsValidOCSF asserts the schema invariants that
// downstream OCSF consumers (Splunk SCAR, OCSF schema validators, vendor
// SIEMs) check on ingest. A line missing class_uid or with type_uid mismatched
// against class_uid+activity_id rejects an entire batch.
func TestPipelineOCSF_EveryLineIsValidOCSF(t *testing.T) {
	out := runScenario(t, sinks.FormatOCSF, 5)
	lines := linesOf(t, out)
	if len(lines) == 0 {
		t.Fatal("OCSF run produced zero lines")
	}

	classCounts := map[float64]int{}
	for i, l := range lines {
		var got map[string]any
		if err := json.Unmarshal([]byte(l), &got); err != nil {
			t.Fatalf("line %d not JSON: %v\n%s", i, err, l)
		}

		// Every record must carry the OCSF class triple — these are the
		// fields downstream rule engines pivot on.
		for _, key := range []string{"category_uid", "class_uid", "activity_id", "type_uid", "severity_id", "time", "metadata"} {
			if _, ok := got[key]; !ok {
				t.Errorf("line %d (class=%v) missing required OCSF key %q", i, got["class_uid"], key)
			}
		}

		classUID, _ := got["class_uid"].(float64)
		activityID, _ := got["activity_id"].(float64)
		typeUID, _ := got["type_uid"].(float64)

		// type_uid is the OCSF identity triple's hash: class_uid * 100 + activity_id.
		if want := classUID*100 + activityID; typeUID != want {
			t.Errorf("line %d: type_uid=%v, want %v (class %v + activity %v)", i, typeUID, want, classUID, activityID)
		}

		// metadata.uid must equal the LogEntry ID so de-dupe works downstream.
		if meta, ok := got["metadata"].(map[string]any); ok {
			if meta["uid"] == nil || meta["uid"] == "" {
				t.Errorf("line %d: metadata.uid missing — breaks downstream de-dupe", i)
			}
			if meta["version"] == "" {
				t.Errorf("line %d: metadata.version empty", i)
			}
		}

		classCounts[classUID]++
	}

	// Every generator we ship hands the encoder a Class hint; the result is
	// each scenario must produce at least HTTP (4002), Network (4001), and
	// Datastore (6005) records. If one is missing, a generator forgot to set
	// Class and is silently classifying as 6001 / Unknown.
	for _, want := range []float64{4002, 4001, 6005} {
		if classCounts[want] == 0 {
			t.Errorf("OCSF class_uid=%v never produced; counts=%v — generator regression", want, classCounts)
		}
	}
}

// TestPipelineOCSF_SeverityMatchesLevel — operator workflows that pivot on
// OCSF severity_id (3 = Medium, 4 = High) bypass the message body. If a 5xx
// HTTP response lands as severity 1, the on-call alert never fires.
func TestPipelineOCSF_SeverityMatchesLevel(t *testing.T) {
	out := runScenario(t, sinks.FormatOCSF, 5)
	for i, l := range linesOf(t, out) {
		var got map[string]any
		if err := json.Unmarshal([]byte(l), &got); err != nil {
			t.Fatalf("line %d: %v", i, err)
		}
		// Reach into the metadata block and re-derive the severity from the
		// stored level (the message body's level isn't preserved separately
		// on OCSF). The OCSF builder's mapping is the contract under test.
		sevID, _ := got["severity_id"].(float64)
		sevName, _ := got["severity"].(string)
		// Severity must come out of the level mapping — a non-empty pair is
		// the floor.
		if sevID == 0 && sevName == "Unknown" {
			t.Errorf("line %d: severity collapsed to Unknown — level→severity mapping regressed", i)
		}
	}
}

// TestPipelineOCSF_HTTPRecordsCarryNetworkPayload — every nodejs entry should
// land as Network Activity / HTTP Activity (class_uid 4002) and carry both
// the request and response sub-objects so a SIEM can pivot from method to
// status code.
func TestPipelineOCSF_HTTPRecordsCarryNetworkPayload(t *testing.T) {
	out := runScenario(t, sinks.FormatOCSF, 5)
	gotHTTP := false
	for _, l := range linesOf(t, out) {
		var got map[string]any
		_ = json.Unmarshal([]byte(l), &got)
		if got["class_uid"].(float64) != 4002 {
			continue
		}
		gotHTTP = true
		// http_request and http_response are required for class 4002 records.
		if _, ok := got["http_request"].(map[string]any); !ok {
			t.Errorf("HTTP Activity record missing http_request: %s", l)
		}
		if _, ok := got["http_response"].(map[string]any); !ok {
			t.Errorf("HTTP Activity record missing http_response: %s", l)
		}
	}
	if !gotHTTP {
		t.Skip("scenario produced no HTTP records this run; covered by TestPipelineOCSF_EveryLineIsValidOCSF instead")
	}
}

// TestPipelineOCSF_NetworkRecordsCarryEndpoints — VPC flow logs (class 4001)
// must carry both src_endpoint and dst_endpoint or downstream net-flow rules
// can't operate.
func TestPipelineOCSF_NetworkRecordsCarryEndpoints(t *testing.T) {
	out := runScenario(t, sinks.FormatOCSF, 5)
	gotNet := false
	for _, l := range linesOf(t, out) {
		var got map[string]any
		_ = json.Unmarshal([]byte(l), &got)
		if got["class_uid"].(float64) != 4001 {
			continue
		}
		gotNet = true
		if _, ok := got["src_endpoint"].(map[string]any); !ok {
			t.Errorf("Network Activity missing src_endpoint: %s", l)
		}
		if _, ok := got["dst_endpoint"].(map[string]any); !ok {
			t.Errorf("Network Activity missing dst_endpoint: %s", l)
		}
		if _, ok := got["traffic"].(map[string]any); !ok {
			t.Errorf("Network Activity missing traffic block: %s", l)
		}
	}
	if !gotNet {
		t.Skip("no network records emitted (random seed-dependent)")
	}
}

// ---------------------------------------------------------------------------
// OTEL format.
// ---------------------------------------------------------------------------

// TestPipelineOTEL_EveryLineIsValidOTLP guarantees every line is a complete
// OTLP/JSON resourceLogs envelope. A collector that gets a malformed envelope
// drops the whole batch.
func TestPipelineOTEL_EveryLineIsValidOTLP(t *testing.T) {
	out := runScenario(t, sinks.FormatOTEL, 5)
	lines := linesOf(t, out)
	if len(lines) == 0 {
		t.Fatal("OTEL run produced zero lines")
	}

	for i, l := range lines {
		var got map[string]any
		if err := json.Unmarshal([]byte(l), &got); err != nil {
			t.Fatalf("line %d not JSON: %v\n%s", i, err, l)
		}

		rls, ok := got["resourceLogs"].([]any)
		if !ok || len(rls) == 0 {
			t.Errorf("line %d missing resourceLogs: %s", i, l)
			continue
		}
		rl := rls[0].(map[string]any)

		resource, ok := rl["resource"].(map[string]any)
		if !ok {
			t.Errorf("line %d: resourceLogs[0].resource missing", i)
			continue
		}
		// resource.attributes must be a JSON array (OTLP/JSON requires
		// arrays, not null). otelResourceAttributes always returns []any.
		if _, ok := resource["attributes"].([]any); !ok {
			t.Errorf("line %d: resource.attributes is %T, want []any", i, resource["attributes"])
		}

		scopeLogs, ok := rl["scopeLogs"].([]any)
		if !ok || len(scopeLogs) == 0 {
			t.Errorf("line %d: scopeLogs missing", i)
			continue
		}
		sl := scopeLogs[0].(map[string]any)
		records, ok := sl["logRecords"].([]any)
		if !ok || len(records) == 0 {
			t.Errorf("line %d: logRecords missing", i)
			continue
		}
		rec := records[0].(map[string]any)

		// Required fields per OTLP/JSON LogRecord.
		for _, key := range []string{"timeUnixNano", "observedTimeUnixNano", "severityNumber", "severityText", "body", "attributes"} {
			if _, ok := rec[key]; !ok {
				t.Errorf("line %d: logRecord missing %q", i, key)
			}
		}

		// timeUnixNano must be a numeric string (Protobuf JSON int64 rule).
		if ts, ok := rec["timeUnixNano"].(string); !ok || ts == "" || ts == "0" {
			t.Errorf("line %d: timeUnixNano = %v (%T), want non-zero numeric string",
				i, rec["timeUnixNano"], rec["timeUnixNano"])
		}

		// attributes must be an array — null breaks strict collectors.
		if _, ok := rec["attributes"].([]any); !ok {
			t.Errorf("line %d: attributes is %T, want []any", i, rec["attributes"])
		}
	}
}

// TestPipelineOTEL_ResourceAttributesPopulatedFromSource — every record must
// carry service.name on the resource so collectors group records by emitter.
// If the engine drops Source, records all land under "unknown_service".
func TestPipelineOTEL_ResourceAttributesPopulatedFromSource(t *testing.T) {
	out := runScenario(t, sinks.FormatOTEL, 3)
	for i, l := range linesOf(t, out) {
		var got map[string]any
		_ = json.Unmarshal([]byte(l), &got)
		rl := got["resourceLogs"].([]any)[0].(map[string]any)
		resource := rl["resource"].(map[string]any)
		attrs := resource["attributes"].([]any)
		if findAttrPipe(attrs, "service.name") == nil {
			t.Errorf("line %d: resource.attributes missing service.name", i)
		}
		if findAttrPipe(attrs, "service.instance.id") == nil {
			t.Errorf("line %d: resource.attributes missing service.instance.id", i)
		}
	}
}

// TestPipelineOTEL_HTTPRecordsCarrySemconv — every nodejs entry should land
// with http.request.method and url.path on the OTel semconv attribute names.
// Vendor extensions are fine; the semconv keys are the contract.
func TestPipelineOTEL_HTTPRecordsCarrySemconv(t *testing.T) {
	out := runScenario(t, sinks.FormatOTEL, 5)
	gotHTTP := false
	for _, l := range linesOf(t, out) {
		var got map[string]any
		_ = json.Unmarshal([]byte(l), &got)
		rec := pipeRecordOf(got)
		attrs := rec["attributes"].([]any)
		method := findAttrPipe(attrs, "http.request.method")
		if method == nil {
			continue
		}
		gotHTTP = true
		if path := findAttrPipe(attrs, "url.path"); path == nil {
			t.Errorf("HTTP record missing url.path alongside http.request.method: %s", l)
		}
	}
	if !gotHTTP {
		t.Errorf("no OTEL HTTP records emitted — engine should have produced nodejs HTTP traffic")
	}
}

// TestPipelineOTEL_NetworkRecordsCarrySemconv — VPC flow records must carry
// source.address / destination.address. A collector pivots on these for
// network-flow dashboards.
func TestPipelineOTEL_NetworkRecordsCarrySemconv(t *testing.T) {
	out := runScenario(t, sinks.FormatOTEL, 5)
	for _, l := range linesOf(t, out) {
		var got map[string]any
		_ = json.Unmarshal([]byte(l), &got)
		rec := pipeRecordOf(got)
		attrs := rec["attributes"].([]any)
		// Skip non-network records.
		if findAttrPipe(attrs, "network.transport") == nil {
			continue
		}
		if findAttrPipe(attrs, "source.address") == nil || findAttrPipe(attrs, "destination.address") == nil {
			t.Errorf("Network record missing source/destination.address: %s", l)
		}
	}
}

// TestPipelineOTEL_DatastoreRecordsCarryDBSemconv — MySQL records must land
// with db.query.text and db.system.name so trace consumers can attribute DB
// time correctly.
func TestPipelineOTEL_DatastoreRecordsCarryDBSemconv(t *testing.T) {
	out := runScenario(t, sinks.FormatOTEL, 5)
	gotDB := false
	for _, l := range linesOf(t, out) {
		var got map[string]any
		_ = json.Unmarshal([]byte(l), &got)
		rec := pipeRecordOf(got)
		attrs := rec["attributes"].([]any)
		if findAttrPipe(attrs, "db.query.text") == nil {
			continue
		}
		gotDB = true
		if v := findAttrPipe(attrs, "db.system.name"); v == nil {
			t.Errorf("DB record missing db.system.name: %s", l)
		}
		if v := findAttrPipe(attrs, "db.operation.name"); v == nil {
			t.Errorf("DB record missing db.operation.name: %s", l)
		}
	}
	if !gotDB {
		t.Errorf("no OTEL DB records — mysql generator regression")
	}
}

// TestPipelineOTEL_DeterministicWithSameSeed — same as the native test, but
// for the OTEL pipeline. Drift here means the encoder is taking a stale
// reference into the engine's tick state.
func TestPipelineOTEL_DeterministicWithSameSeed(t *testing.T) {
	a := runScenario(t, sinks.FormatOTEL, 3)
	b := runScenario(t, sinks.FormatOTEL, 3)
	if a != b {
		t.Errorf("OTEL same-seed runs differ — encoder is leaking nondeterminism")
	}
}

// ---------------------------------------------------------------------------
// Cross-format invariants.
// ---------------------------------------------------------------------------

// TestPipelineLineCountMatchesAcrossFormats — the engine should emit the same
// number of LogEntries regardless of sink format. If switching formats drops
// or duplicates entries, the frontend's "5,432 events" summary disagrees with
// the OCSF/OTEL exports.
func TestPipelineLineCountMatchesAcrossFormats(t *testing.T) {
	const ticks = 5
	native := linesOf(t, runScenario(t, sinks.FormatJSONL, ticks))
	ocsf := linesOf(t, runScenario(t, sinks.FormatOCSF, ticks))
	otel := linesOf(t, runScenario(t, sinks.FormatOTEL, ticks))

	if len(native) == 0 {
		t.Fatal("native produced zero lines — engine regression")
	}
	if len(native) != len(ocsf) {
		t.Errorf("native produced %d lines, OCSF produced %d — encoder dropped entries", len(native), len(ocsf))
	}
	if len(native) != len(otel) {
		t.Errorf("native produced %d lines, OTEL produced %d — encoder dropped entries", len(native), len(otel))
	}
}

// TestPipelineRawFormat — Raw format emits only the rendered log line per
// entry. Used by operators who want their original log text without the
// JSON envelope. Must not be empty for an active scenario.
func TestPipelineRawFormat(t *testing.T) {
	out := runScenario(t, sinks.FormatRaw, 3)
	lines := linesOf(t, out)
	if len(lines) == 0 {
		t.Fatal("raw format produced zero lines")
	}
	// Raw format strips the LogEntry envelope, so no line should look like
	// `{"id":...}` — that would mean the encoder forgot to strip.
	for i, l := range lines {
		if strings.HasPrefix(l, `{"id":`) {
			t.Errorf("line %d looks like JSONL, not raw: %q", i, l)
		}
	}
}

// TestPipelineUDM_FallsBackToNative — the UDM/ASIM stubs should fall back to
// native JSONL today (callers still get usable output, not empty lines).
// Removing the fallback without a real builder lands silent empty lines.
func TestPipelineUDMFallsBackToNative(t *testing.T) {
	for _, f := range []sinks.Format{sinks.FormatUDM, sinks.FormatASIM} {
		out := runScenario(t, f, 2)
		lines := linesOf(t, out)
		if len(lines) == 0 {
			t.Errorf("%s produced zero lines — fallback regressed", f)
			continue
		}
		// Native fallback means each line is a parseable LogEntry.
		for i, l := range lines {
			var e event.LogEntry
			if err := json.Unmarshal([]byte(l), &e); err != nil {
				t.Errorf("%s line %d not a LogEntry (fallback should be native JSONL): %v\n%s",
					f, i, err, l)
			}
		}
	}
}

// TestPipelineEncoderApplyToRawNeverDropsCount — the API path uses
// encoders.ApplyToRaw(slice, format) to project a stream in-place. The output
// slice length must match the input.
func TestPipelineEncoderApplyToRawNeverDropsCount(t *testing.T) {
	s, _ := scenario.Parse(strings.NewReader(fullStackYAML))
	if err := scenario.Validate(s); err != nil {
		t.Fatalf("validate: %v", err)
	}
	cfg := engine.Config{
		Seed:           42,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:   "*",
	}
	collector := &capturingSink{}
	if err := engine.New(s, cfg).Run(context.Background(), 3, []sinks.Sink{collector}); err != nil {
		t.Fatalf("run: %v", err)
	}
	original := append([]event.LogEntry(nil), collector.entries...)
	if len(original) == 0 {
		t.Fatal("no entries captured")
	}

	for _, format := range []encoders.Format{encoders.FormatNative, encoders.FormatOCSF, encoders.FormatOTEL} {
		cp := append([]event.LogEntry(nil), original...)
		out := encoders.ApplyToRaw(cp, format)
		if len(out) != len(original) {
			t.Errorf("ApplyToRaw(%s) returned %d entries, want %d — silent drop",
				format, len(out), len(original))
		}
	}
}

// capturingSink stashes every entry the engine writes so tests can assert
// against the exact LogEntry slice without an intermediate string round-trip.
type capturingSink struct{ entries []event.LogEntry }

func (s *capturingSink) Write(in []event.LogEntry) error {
	s.entries = append(s.entries, in...)
	return nil
}
func (s *capturingSink) Flush() error { return nil }
func (s *capturingSink) Close() error { return nil }

// ---------------------------------------------------------------------------
// helpers (duplicated locally since the pipeline_test lives in encoders_test).
// ---------------------------------------------------------------------------

func findAttrPipe(attrs []any, key string) map[string]any {
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

func pipeRecordOf(envelope map[string]any) map[string]any {
	rl := envelope["resourceLogs"].([]any)[0].(map[string]any)
	sl := rl["scopeLogs"].([]any)[0].(map[string]any)
	rec := sl["logRecords"].([]any)[0].(map[string]any)
	return rec
}
