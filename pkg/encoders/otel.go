package encoders

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
)

// OpenTelemetry Logs Data Model severity numbers. The model defines 24 levels
// grouped into TRACE/DEBUG/INFO/WARN/ERROR/FATAL bands of four; we use the
// middle of each band so a coarser source level (DEBUG/INFO/...) lands at a
// sensible mid-point and downstream filters that compare ranges still work.
//
// Reference: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
const (
	otelSeverityTrace = 1
	otelSeverityDebug = 5
	otelSeverityInfo  = 9
	otelSeverityWarn  = 13
	otelSeverityError = 17
	otelSeverityFatal = 21
)

// otelEncoder maps a LogEntry to an OpenTelemetry LogRecord JSON object that
// follows the OTLP/JSON shape. The output is one record per line — callers
// that need OTLP's nested ResourceLogs/ScopeLogs envelope can wrap multiple
// records in a single request, but each LogEntry encodes independently so
// streaming/NDJSON pipelines still work.
type otelEncoder struct{}

func (otelEncoder) Format() Format { return FormatOTEL }

func (otelEncoder) Encode(le *event.LogEntry) ([]byte, error) {
	return json.Marshal(buildOTEL(le))
}

// buildOTEL produces the LogRecord shape. The record is wrapped in the
// resourceLogs/scopeLogs envelope so the output is a self-contained OTLP/JSON
// document — a downstream collector can ingest a stream of these line-by-line
// or concatenate logRecords from many lines into one batch request.
func buildOTEL(e *event.LogEntry) map[string]any {
	t := parseTime(e.TS)
	tsNano := t.UnixNano()
	sevNum, sevText := otelSeverity(e.Level)

	body := otelBody(e)
	attrs := otelAttributes(e)

	record := map[string]any{
		"timeUnixNano":         formatUnixNano(tsNano),
		"observedTimeUnixNano": formatUnixNano(tsNano),
		"severityNumber":       sevNum,
		"severityText":         sevText,
		"body":                 body,
		"attributes":           attrs,
	}

	return map[string]any{
		"resourceLogs": []any{
			map[string]any{
				"resource": map[string]any{
					"attributes": otelResourceAttributes(e),
				},
				"scopeLogs": []any{
					map[string]any{
						"scope":      map[string]any{},
						"logRecords": []any{record},
					},
				},
			},
		},
	}
}

// otelBody renders the LogRecord body. OTLP allows AnyValue (string, int, kvlist,
// etc.); we pick stringValue with the original log line so the message is
// human-readable in collectors that just print body. For class hints that map
// to structured semantic conventions (HTTP, DB, network) the meaningful detail
// lands in attributes alongside.
func otelBody(e *event.LogEntry) map[string]any {
	return map[string]any{"stringValue": e.Raw}
}

// otelAttributes maps the entry's Class hint and structured Fields to the
// attribute names defined by OpenTelemetry semantic conventions
// (https://opentelemetry.io/docs/specs/semconv/). Unknown classes still emit
// the raw Fields under flat keys so the data isn't lost.
//
// Class builders return semconv-shaped attributes plus, where appropriate, a
// set of "consumed" field keys so the generic projection at the end can fill
// in anything that didn't have a dedicated mapping without duplicating keys
// the builder already emitted.
//
// Always returns a non-nil slice — OTLP/JSON requires `attributes` to be a
// JSON array, and a nil slice would marshal to `null`, breaking strict
// collectors that validate the shape.
func otelAttributes(e *event.LogEntry) []any {
	attrs := []any{}
	var consumed map[string]bool

	switch e.Class {
	case ClassHTTPActivity:
		attrs, consumed = otelHTTPAttributes(e.Fields)
	case ClassNetworkActivity:
		attrs, consumed = otelNetworkAttributes(e.Fields)
	case ClassDatastoreActivity:
		attrs, consumed = otelDBAttributes(e.Fields)
	case ClassApplicationLifecycle:
		attrs, consumed = otelLifecycleAttributes(e.Fields)
	case ClassAPIActivity:
		attrs, consumed = otelAPIActivityAttributes(e.Fields)
	case ClassAuthentication:
		attrs, consumed = otelAuthenticationAttributes(e.Fields)
	case ClassAccountChange:
		attrs, consumed = otelAccountChangeAttributes(e.Fields)
	default:
		attrs = append(attrs, otelGenericAttributes(e.Fields)...)
		return attrs
	}
	// Project any leftover fields so per-scenario extensions (custom
	// placeholders, vendor extras) survive even when a class builder ran.
	attrs = append(attrs, otelGenericLeftoverAttributes(e.Fields, consumed)...)
	if attrs == nil {
		attrs = []any{}
	}
	return attrs
}

// otelResourceAttributes captures process/service identity at the Resource
// level so a collector groups records by emitter as OTLP expects, rather than
// repeating the same identity on every log line's attributes.
//
// The engine emits Source as a slash- or dot-delimited containment path
// (`vpc/subnet/host/svc`). Splitting it lets us populate the standard
// `service.name`, `service.namespace`, and `host.name` resource attributes
// individually instead of jamming the whole path into service.name — which
// would defeat per-service grouping in any OTLP-aware collector. The full
// path stays available as `service.instance.id` for callers that want to
// distinguish e.g. `app-1` from `app-2`.
//
// When the entry's Fields carry cloud identity (cloud_provider, region,
// account), promote them to resource-level cloud.* attributes so they don't
// repeat on every log record.
func otelResourceAttributes(e *event.LogEntry) []any {
	attrs := []any{}
	if e.Source != "" {
		ns, host, svc := splitSourcePath(e.Source)
		if svc != "" {
			attrs = append(attrs, otelKV("service.name", svc))
		}
		if ns != "" {
			attrs = append(attrs, otelKV("service.namespace", ns))
		}
		if host != "" {
			attrs = append(attrs, otelKV("host.name", host))
		}
		attrs = append(attrs, otelKV("service.instance.id", e.Source))
	}
	if cloud := strField(e.Fields, "cloud_provider"); cloud != "" {
		attrs = append(attrs, otelKV("cloud.provider", strings.ToLower(cloud)))
	}
	if region := strField(e.Fields, "region"); region != "" {
		attrs = append(attrs, otelKV("cloud.region", region))
	}
	if acct := firstNonEmpty(strField(e.Fields, "user_account_uid"), strField(e.Fields, "actor_account_uid"), strField(e.Fields, "cloud_account_id")); acct != "" {
		attrs = append(attrs, otelKV("cloud.account.id", acct))
	}
	attrs = append(attrs, otelKV("telemetry.sdk.language", "go"))
	return attrs
}

// splitSourcePath returns (namespace, host, service) from a containment path.
// Sources may use either `/` or `.` separators depending on the engine
// configuration — both produce the same logical breakdown. With fewer than
// three segments we leave the upper levels empty so the emitter's identity
// still lands somewhere truthful (e.g. a 1-segment "load-balancer" becomes
// service.name=load-balancer).
func splitSourcePath(src string) (namespace, host, service string) {
	if src == "" {
		return "", "", ""
	}
	sep := "/"
	if !strings.Contains(src, "/") && strings.Contains(src, ".") {
		sep = "."
	}
	parts := strings.Split(src, sep)
	switch len(parts) {
	case 0:
		return "", "", ""
	case 1:
		return "", "", parts[0]
	case 2:
		return parts[0], "", parts[1]
	case 3:
		return parts[0], parts[1], parts[2]
	default:
		// More than three segments — keep the leaf as service.name, the parent
		// as host.name, and roll everything above into the namespace so a
		// canonical "vpc/subnet/host/svc" still maps cleanly.
		service = parts[len(parts)-1]
		host = parts[len(parts)-2]
		namespace = strings.Join(parts[:len(parts)-2], sep)
		return namespace, host, service
	}
}

// --- attribute builders for each Class -----------------------------------

func otelHTTPAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any
	method := strField(f, "method")
	path := strField(f, "path")
	status := intField(f, "status_code")
	srcIP := firstNonEmpty(strField(f, "client_ip"), strField(f, "remote_addr"), strField(f, "src_ip"))
	dstIP := firstNonEmpty(strField(f, "dst_ip"), strField(f, "local_addr"))
	duration := firstIntField(f, "response_time_ms", "rt_ms", "duration_ms")
	bytesSent := intField(f, "body_bytes")
	ua := strField(f, "user_agent")

	if method != "" {
		out = append(out, otelKV("http.request.method", strings.ToUpper(method)))
		consumed["method"] = true
	}
	if path != "" {
		out = append(out, otelKV("url.path", path))
		consumed["path"] = true
	}
	if status > 0 {
		out = append(out, otelKVInt("http.response.status_code", status))
		consumed["status_code"] = true
		// HTTP error semantics: OTel marks server errors with error.type when
		// the response indicates failure, so trace-style consumers can pivot
		// without re-parsing the body.
		if status >= 400 {
			out = append(out, otelKV("error.type", "_OTHER"))
		}
	}
	if duration > 0 {
		// OTel HTTP semconv expresses duration in seconds; preserve the
		// millisecond value too so dashboards that already speak ms still work.
		out = append(out, otelKVDouble("http.server.request.duration", float64(duration)/1000.0))
		out = append(out, otelKVInt("http.server.request.duration_ms", duration))
		consumed["response_time_ms"] = true
		consumed["rt_ms"] = true
		consumed["duration_ms"] = true
	}
	if bytesSent > 0 {
		out = append(out, otelKVInt("http.response.body.size", bytesSent))
		consumed["body_bytes"] = true
	}
	if srcIP != "" {
		out = append(out, otelKV("client.address", srcIP))
		consumed["client_ip"] = true
		consumed["remote_addr"] = true
		consumed["src_ip"] = true
	}
	if dstIP != "" {
		out = append(out, otelKV("server.address", dstIP))
		consumed["dst_ip"] = true
		consumed["local_addr"] = true
	}
	if ua != "" {
		out = append(out, otelKV("user_agent.original", ua))
		consumed["user_agent"] = true
	}
	return out, consumed
}

func otelNetworkAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any
	srcIP := strField(f, "src_ip")
	dstIP := strField(f, "dst_ip")
	srcPort := intField(f, "src_port")
	dstPort := intField(f, "dst_port")
	proto := intField(f, "protocol")
	bytes := intField(f, "bytes")
	packets := intField(f, "packets")
	action := strField(f, "action")

	if srcIP != "" {
		out = append(out, otelKV("source.address", srcIP))
		consumed["src_ip"] = true
	}
	if srcPort > 0 {
		out = append(out, otelKVInt("source.port", srcPort))
		consumed["src_port"] = true
	}
	if dstIP != "" {
		out = append(out, otelKV("destination.address", dstIP))
		consumed["dst_ip"] = true
	}
	if dstPort > 0 {
		out = append(out, otelKVInt("destination.port", dstPort))
		consumed["dst_port"] = true
	}
	if proto > 0 {
		out = append(out, otelKV("network.transport", networkTransport(proto)))
		// network.protocol.name uses the same enum-style keyword OTel uses for
		// transport when the application protocol isn't separately known. The
		// IANA protocol number itself is namespaced under network.* as a
		// vendor extension (no semconv exists for the raw IANA value).
		out = append(out, otelKVInt("network.iana_protocol_number", proto))
		consumed["protocol"] = true
	}
	if bytes > 0 {
		out = append(out, otelKVInt("network.io.bytes", bytes))
		consumed["bytes"] = true
	}
	if packets > 0 {
		out = append(out, otelKVInt("network.io.packets", packets))
		consumed["packets"] = true
	}
	if action != "" {
		// VPC flow log "action" (ACCEPT/REJECT) doesn't have a stable OTel
		// semconv key. Emit both the lowercase value under a vendor-prefixed
		// key (for collector routing) and the OCSF-aligned outcome so security
		// pipelines can pivot consistently.
		out = append(out, otelKV("network.security.action", strings.ToLower(action)))
		switch strings.ToUpper(action) {
		case "ACCEPT", "ALLOW":
			out = append(out, otelKV("event.outcome", "success"))
		case "REJECT", "DENY", "DROP":
			out = append(out, otelKV("event.outcome", "failure"))
		}
		consumed["action"] = true
	}
	return out, consumed
}

func otelDBAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any
	query := strField(f, "query")
	database := strField(f, "database")
	duration := firstIntField(f, "duration_ms", "query_time_ms")
	connID := intField(f, "conn_id")
	slowThreshold := intField(f, "slow_threshold_ms")
	slow, slowOk := boolFieldOTEL(f, "slow_query")

	if query != "" {
		out = append(out,
			otelKV("db.query.text", query),
			otelKV("db.operation.name", sqlOperation(query)),
			// MySQL/Postgres/Redis are the supported datastore generators and
			// all sit under the relational/key-value SQL umbrella in OTel
			// semconv. db.system.name is the stable replacement for db.system
			// and is required when querying recent collectors.
			otelKV("db.system.name", "mysql"),
		)
		consumed["query"] = true
	}
	if database != "" {
		out = append(out, otelKV("db.namespace", database))
		consumed["database"] = true
	}
	if duration > 0 {
		out = append(out, otelKVDouble("db.client.operation.duration", float64(duration)/1000.0))
		out = append(out, otelKVInt("db.client.operation.duration_ms", duration))
		consumed["duration_ms"] = true
		consumed["query_time_ms"] = true
	}
	if connID > 0 {
		// db.client.connection.pool.name is the closest semconv slot for a
		// connection identifier; the integer id stays under a vendor key for
		// consumers that already speak the MySQL general log shape.
		out = append(out, otelKVInt("db.connection_id", connID))
		consumed["conn_id"] = true
	}
	if slowOk && slow {
		// Slow-query events: surface the threshold so downstream filters
		// don't have to re-derive it. error.type marks the line as a problem
		// per OTel conventions even though it's not a hard failure.
		out = append(out, otelKVBool("db.slow_query", true))
		if slowThreshold > 0 {
			out = append(out, otelKVInt("db.slow_query.threshold_ms", slowThreshold))
		}
		out = append(out, otelKV("error.type", "slow_query"))
		consumed["slow_query"] = true
		consumed["slow_threshold_ms"] = true
	} else if slowOk {
		consumed["slow_query"] = true
	}
	return out, consumed
}

func otelLifecycleAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any
	if port := intField(f, "port"); port > 0 {
		out = append(out, otelKVInt("server.port", port))
		consumed["port"] = true
	}
	if framework := strField(f, "framework"); framework != "" {
		out = append(out, otelKV("service.framework", framework))
		consumed["framework"] = true
	}
	out = append(out, otelKV("event.name", "application.lifecycle"))
	return out, consumed
}

// otelAPIActivityAttributes maps CloudTrail-shaped API call fields onto OTel
// semantic conventions. Identity (user/actor) and cloud (provider/region/
// account) get their semconv homes; the operation name lands as the OTel
// `event.name` so log analytics can group events by name without parsing the
// body. Anything else falls through to the generic projection.
func otelAPIActivityAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any

	op := firstNonEmpty(strField(f, "operation"), strField(f, "event_name"))
	svcName := strField(f, "service_name")
	reqUID := strField(f, "request_uid")

	if op != "" {
		// event.name is the canonical OTel attribute for naming a discrete
		// event; it doubles as `rpc.method` for RPC-shaped traffic.
		out = append(out, otelKV("event.name", op))
		out = append(out, otelKV("rpc.method", op))
		consumed["operation"] = true
		consumed["event_name"] = true
	}
	if svcName != "" {
		out = append(out, otelKV("rpc.service", svcName))
		consumed["service_name"] = true
	}
	if reqUID != "" {
		// Request id has no stable semconv name across vendors; AWS uses
		// `aws.request_id`. Keep it under a vendor namespace plus a generic
		// alias so non-AWS consumers can still find it.
		out = append(out, otelKV("aws.request_id", reqUID))
		out = append(out, otelKV("rpc.request_id", reqUID))
		consumed["request_uid"] = true
	}

	out = append(out, otelIdentityAttributes(f, consumed)...)
	out = append(out, otelCloudAttributes(f, consumed)...)
	out = append(out, otelOutcomeAttributes(f, consumed)...)
	return out, consumed
}

// otelAuthenticationAttributes maps signin / IAM authentication fields
// (CloudTrail ConsoleLogin, AD Kerberos AS-REQ, etc.) onto OTel semconv.
// Authentication-specific signals (is_mfa, logon_type, auth_protocol) don't
// have stable semconv slots — keep them under a vendor `iam.*` namespace so
// SIEM pipelines that special-case auth still get them.
func otelAuthenticationAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any

	op := firstNonEmpty(strField(f, "operation"), strField(f, "event_name"))
	if op != "" {
		out = append(out, otelKV("event.name", op))
		consumed["operation"] = true
		consumed["event_name"] = true
	} else {
		out = append(out, otelKV("event.name", "authentication"))
	}
	if svcName := strField(f, "service_name"); svcName != "" {
		out = append(out, otelKV("rpc.service", svcName))
		consumed["service_name"] = true
	}
	if reqUID := strField(f, "request_uid"); reqUID != "" {
		out = append(out, otelKV("aws.request_id", reqUID))
		consumed["request_uid"] = true
	}
	if proto := strField(f, "auth_protocol"); proto != "" {
		out = append(out, otelKV("iam.auth_protocol", proto))
		consumed["auth_protocol"] = true
	}
	if logon := strField(f, "logon_type"); logon != "" {
		out = append(out, otelKV("iam.logon_type", logon))
		consumed["logon_type"] = true
	}
	if mfa, ok := boolFieldOTEL(f, "is_mfa"); ok {
		out = append(out, otelKVBool("iam.is_mfa", mfa))
		consumed["is_mfa"] = true
	}
	if remote, ok := boolFieldOTEL(f, "is_remote"); ok {
		out = append(out, otelKVBool("iam.is_remote", remote))
		consumed["is_remote"] = true
	}
	if dst := strField(f, "dst_svc_name"); dst != "" {
		out = append(out, otelKV("server.address", dst))
		consumed["dst_svc_name"] = true
	}
	// activity_id is OCSF-internal; preserve as a vendor attribute so analytics
	// that already consume the OCSF view stay aligned, but don't pretend it's
	// an OTel concept by giving it a top-level semconv name.
	if act := intField(f, "activity_id"); act != 0 {
		out = append(out, otelKVInt("ocsf.activity_id", act))
		consumed["activity_id"] = true
	}

	out = append(out, otelIdentityAttributes(f, consumed)...)
	out = append(out, otelCloudAttributes(f, consumed)...)
	out = append(out, otelOutcomeAttributes(f, consumed)...)
	return out, consumed
}

// otelAccountChangeAttributes maps account-mutation (IAM CreateUser, AAD
// ResetUserPassword, …) fields. Same identity/cloud projection as the auth
// builder; the operation name is the dominant signal so it doubles as both
// event.name and rpc.method to match how the API class encodes calls.
func otelAccountChangeAttributes(f map[string]any) ([]any, map[string]bool) {
	consumed := map[string]bool{}
	var out []any

	op := firstNonEmpty(strField(f, "operation"), strField(f, "event_name"))
	if op != "" {
		out = append(out, otelKV("event.name", op))
		out = append(out, otelKV("rpc.method", op))
		consumed["operation"] = true
		consumed["event_name"] = true
	} else {
		out = append(out, otelKV("event.name", "account.change"))
	}
	if svcName := strField(f, "service_name"); svcName != "" {
		out = append(out, otelKV("rpc.service", svcName))
		consumed["service_name"] = true
	}
	if reqUID := strField(f, "request_uid"); reqUID != "" {
		out = append(out, otelKV("aws.request_id", reqUID))
		consumed["request_uid"] = true
	}
	if act := intField(f, "activity_id"); act != 0 {
		out = append(out, otelKVInt("ocsf.activity_id", act))
		consumed["activity_id"] = true
	}

	out = append(out, otelIdentityAttributes(f, consumed)...)
	out = append(out, otelCloudAttributes(f, consumed)...)
	out = append(out, otelOutcomeAttributes(f, consumed)...)
	return out, consumed
}

// otelIdentityAttributes pulls user / actor / source-network / user-agent
// fields onto OTel semconv attributes. Both the principal (user_*) and the
// caller (actor_*) are emitted: OTel has `user.*` for the authenticated
// identity, but it also supports the more precise `enduser.*` namespace; we
// emit `user.*` only because semconv is consolidating around it.
//
// Marks every key it touches in `consumed` so otelGenericLeftoverAttributes
// doesn't double-emit them with their original snake_case names.
func otelIdentityAttributes(f map[string]any, consumed map[string]bool) []any {
	var out []any

	// Principal (the user the action targets / the authenticated identity).
	if name := strField(f, "user_name"); name != "" {
		out = append(out, otelKV("user.name", name))
		consumed["user_name"] = true
	}
	if uid := strField(f, "user_uid"); uid != "" {
		out = append(out, otelKV("user.id", uid))
		consumed["user_uid"] = true
	}
	if utype := strField(f, "user_type"); utype != "" {
		// user.role isn't a perfect fit (it's an array in semconv) but it's
		// the closest stable slot for the human-readable "Root"/"IAMUser"
		// distinction. Emit it as a single-element role list so the value is
		// shaped like semconv expects.
		out = append(out, otelKV("user.role", utype))
		consumed["user_type"] = true
	}

	// Actor (CloudTrail userIdentity — who actually invoked the action).
	if name := strField(f, "actor_user_name"); name != "" {
		out = append(out, otelKV("enduser.id", name))
		consumed["actor_user_name"] = true
	}
	if uid := strField(f, "actor_user_uid"); uid != "" {
		out = append(out, otelKV("enduser.role", uid))
		consumed["actor_user_uid"] = true
	}
	if utype := strField(f, "actor_user_type"); utype != "" {
		out = append(out, otelKV("enduser.scope", utype))
		consumed["actor_user_type"] = true
	}

	// Caller-side network identity. cloud.account.id at the resource level
	// covers the account, so consume those keys here without re-emitting.
	if ip := firstNonEmpty(strField(f, "src_ip"), strField(f, "client_ip"), strField(f, "remote_addr")); ip != "" {
		out = append(out, otelKV("client.address", ip))
		consumed["src_ip"] = true
		consumed["client_ip"] = true
		consumed["remote_addr"] = true
	}
	if country := strField(f, "src_country"); country != "" {
		out = append(out, otelKV("client.geo.country.iso_code", country))
		consumed["src_country"] = true
	}
	if ua := strField(f, "user_agent"); ua != "" {
		out = append(out, otelKV("user_agent.original", ua))
		consumed["user_agent"] = true
	}
	return out
}

// otelCloudAttributes promotes cloud_provider/region/account fields onto OTel
// cloud.* semconv. Resource-level attributes already cover these, but
// emitting them on the record too keeps non-batched single-record consumers
// (line-by-line OTLP/JSON readers) happy.
func otelCloudAttributes(f map[string]any, consumed map[string]bool) []any {
	var out []any
	if cloud := strField(f, "cloud_provider"); cloud != "" {
		out = append(out, otelKV("cloud.provider", strings.ToLower(cloud)))
		consumed["cloud_provider"] = true
	}
	if region := strField(f, "region"); region != "" {
		out = append(out, otelKV("cloud.region", region))
		consumed["region"] = true
	}
	if acct := strField(f, "user_account_uid"); acct != "" {
		out = append(out, otelKV("cloud.account.id", acct))
		consumed["user_account_uid"] = true
	}
	if acct := strField(f, "actor_account_uid"); acct != "" {
		// Two separate AWS accounts can appear in one CloudTrail event when an
		// assumed role calls across boundaries. Keep both as distinct attrs
		// rather than letting the second silently overwrite the first.
		out = append(out, otelKV("cloud.account.actor.id", acct))
		consumed["actor_account_uid"] = true
	}
	return out
}

// otelOutcomeAttributes maps a free-form `status` field to OTel's
// `event.outcome` enum (success|failure|unknown). Failure also adds an
// error.type so trace consumers can pivot the same way they would for a
// failed span.
func otelOutcomeAttributes(f map[string]any, consumed map[string]bool) []any {
	var out []any
	status := strField(f, "status")
	if status == "" {
		return nil
	}
	consumed["status"] = true
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success", "succeeded", "ok":
		out = append(out, otelKV("event.outcome", "success"))
	case "failure", "failed", "fail", "error", "denied":
		out = append(out, otelKV("event.outcome", "failure"))
		out = append(out, otelKV("error.type", "_OTHER"))
	default:
		out = append(out, otelKV("event.outcome", "unknown"))
	}
	return out
}

// otelGenericLeftoverAttributes projects any field NOT already consumed by a
// class builder. This is what keeps custom-template extensions (per-scenario
// flags, vendor fields) visible without duplicating the keys a builder
// already mapped.
func otelGenericLeftoverAttributes(f map[string]any, consumed map[string]bool) []any {
	if len(f) == 0 {
		return nil
	}
	out := make([]any, 0, len(f))
	for k, v := range f {
		if consumed[k] {
			continue
		}
		out = append(out, otelKVAny(k, v))
	}
	return out
}

// boolFieldOTEL reads a bool out of Fields tolerating string-encoded booleans
// the way OCSF's helper does — we duplicate it here so the encoder package
// doesn't take a dependency on private OCSF helpers and the two encoders can
// evolve independently.
func boolFieldOTEL(m map[string]any, k string) (bool, bool) {
	if m == nil {
		return false, false
	}
	v, ok := m[k]
	if !ok {
		return false, false
	}
	switch t := v.(type) {
	case bool:
		return t, true
	case string:
		switch strings.ToLower(t) {
		case "true", "yes", "1":
			return true, true
		case "false", "no", "0":
			return false, true
		}
	}
	return false, false
}

// otelGenericAttributes is the fallback when there's no Class match. Every
// field in Fields is projected to a flat attribute so we never silently drop
// structured data. Unknown value types fall back to JSON-encoded strings so
// the AnyValue stays representable.
func otelGenericAttributes(f map[string]any) []any {
	if len(f) == 0 {
		return nil
	}
	out := make([]any, 0, len(f))
	for k, v := range f {
		out = append(out, otelKVAny(k, v))
	}
	return out
}

// --- AnyValue helpers ------------------------------------------------------

// otelKV builds a string-valued attribute; empty strings are still emitted so
// downstream pipelines can distinguish "present but empty" from "missing".
func otelKV(key, value string) map[string]any {
	return map[string]any{
		"key":   key,
		"value": map[string]any{"stringValue": value},
	}
}

func otelKVInt(key string, value int) map[string]any {
	return map[string]any{
		"key":   key,
		"value": map[string]any{"intValue": value},
	}
}

func otelKVDouble(key string, value float64) map[string]any {
	return map[string]any{
		"key":   key,
		"value": map[string]any{"doubleValue": value},
	}
}

func otelKVBool(key string, value bool) map[string]any {
	return map[string]any{
		"key":   key,
		"value": map[string]any{"boolValue": value},
	}
}

// otelKVAny picks the right AnyValue variant for a Go value. Unknown types
// are JSON-encoded as a fallback so the attribute is at least preserved.
func otelKVAny(key string, value any) map[string]any {
	switch v := value.(type) {
	case nil:
		return map[string]any{"key": key, "value": map[string]any{}}
	case string:
		return otelKV(key, v)
	case bool:
		return otelKVBool(key, v)
	case int:
		return otelKVInt(key, v)
	case int32:
		return otelKVInt(key, int(v))
	case int64:
		return otelKVInt(key, int(v))
	case float32:
		return otelKVDouble(key, float64(v))
	case float64:
		// JSON unmarshal lands integers in float64; keep ints as ints if the
		// value has no fractional component so downstream type checks succeed.
		if v == float64(int64(v)) {
			return otelKVInt(key, int(v))
		}
		return otelKVDouble(key, v)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return otelKV(key, "")
		}
		return otelKV(key, string(b))
	}
}

// --- helpers ---------------------------------------------------------------

func otelSeverity(level string) (int, string) {
	switch strings.ToUpper(level) {
	case "TRACE":
		return otelSeverityTrace, "TRACE"
	case "DEBUG":
		return otelSeverityDebug, "DEBUG"
	case "INFO", "":
		return otelSeverityInfo, "INFO"
	case "WARN", "WARNING":
		return otelSeverityWarn, "WARN"
	case "ERROR":
		return otelSeverityError, "ERROR"
	case "FATAL", "CRITICAL":
		return otelSeverityFatal, "FATAL"
	default:
		return 0, "UNSPECIFIED"
	}
}

// networkTransport maps an IANA protocol number to OTel's network.transport
// enum. Only the transports we actually generate (TCP/UDP/ICMP) are listed;
// anything else falls back to the IANA number stringified.
func networkTransport(proto int) string {
	switch proto {
	case 6:
		return "tcp"
	case 17:
		return "udp"
	case 1:
		return "icmp"
	default:
		return "unknown"
	}
}

func sqlOperation(query string) string {
	q := strings.TrimSpace(strings.ToUpper(query))
	switch {
	case strings.HasPrefix(q, "SELECT"):
		return "SELECT"
	case strings.HasPrefix(q, "INSERT"):
		return "INSERT"
	case strings.HasPrefix(q, "UPDATE"):
		return "UPDATE"
	case strings.HasPrefix(q, "DELETE"):
		return "DELETE"
	default:
		return "OTHER"
	}
}

// formatUnixNano returns the nanosecond timestamp as a decimal string. OTLP/JSON
// encodes uint64 fields as strings (the Protobuf JSON mapping rule for 64-bit
// ints) so collectors don't lose precision when JavaScript-based clients read
// the value.
func formatUnixNano(ns int64) string {
	if ns < 0 {
		ns = time.Now().UTC().UnixNano()
	}
	return uint64ToString(uint64(ns))
}

func uint64ToString(v uint64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
