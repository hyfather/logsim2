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
func otelAttributes(e *event.LogEntry) []any {
	attrs := []any{}

	switch e.Class {
	case ClassHTTPActivity:
		attrs = append(attrs, otelHTTPAttributes(e.Fields)...)
	case ClassNetworkActivity:
		attrs = append(attrs, otelNetworkAttributes(e.Fields)...)
	case ClassDatastoreActivity:
		attrs = append(attrs, otelDBAttributes(e.Fields)...)
	case ClassApplicationLifecycle:
		attrs = append(attrs, otelLifecycleAttributes(e.Fields)...)
	case ClassAPIActivity:
		// API activity has no dedicated semconv namespace; fall through to
		// generic field projection so callers still see structured data.
		attrs = append(attrs, otelGenericAttributes(e.Fields)...)
	default:
		attrs = append(attrs, otelGenericAttributes(e.Fields)...)
	}
	return attrs
}

// otelResourceAttributes captures process/service identity at the Resource
// level so a collector groups records by emitter as OTLP expects, rather than
// repeating the same identity on every log line's attributes.
func otelResourceAttributes(e *event.LogEntry) []any {
	attrs := []any{
		otelKV("telemetry.sdk.language", "go"),
	}
	if e.Source != "" {
		attrs = append([]any{otelKV("service.name", e.Source)}, attrs...)
	}
	return attrs
}

// --- attribute builders for each Class -----------------------------------

func otelHTTPAttributes(f map[string]any) []any {
	var out []any
	method := strField(f, "method")
	path := strField(f, "path")
	status := intField(f, "status_code")
	srcIP := firstNonEmpty(strField(f, "client_ip"), strField(f, "remote_addr"), strField(f, "src_ip"))
	dstIP := firstNonEmpty(strField(f, "dst_ip"), strField(f, "local_addr"))
	duration := firstIntField(f, "response_time_ms", "rt_ms", "duration_ms")
	bytesSent := intField(f, "body_bytes")

	if method != "" {
		out = append(out, otelKV("http.request.method", strings.ToUpper(method)))
	}
	if path != "" {
		out = append(out, otelKV("url.path", path))
	}
	if status > 0 {
		out = append(out, otelKVInt("http.response.status_code", status))
	}
	if duration > 0 {
		// OTel HTTP semconv expresses duration in seconds; preserve the
		// millisecond value too so dashboards that already speak ms still work.
		out = append(out, otelKVDouble("http.server.request.duration", float64(duration)/1000.0))
		out = append(out, otelKVInt("http.server.request.duration_ms", duration))
	}
	if bytesSent > 0 {
		out = append(out, otelKVInt("http.response.body.size", bytesSent))
	}
	if srcIP != "" {
		out = append(out, otelKV("client.address", srcIP))
	}
	if dstIP != "" {
		out = append(out, otelKV("server.address", dstIP))
	}
	return out
}

func otelNetworkAttributes(f map[string]any) []any {
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
	}
	if srcPort > 0 {
		out = append(out, otelKVInt("source.port", srcPort))
	}
	if dstIP != "" {
		out = append(out, otelKV("destination.address", dstIP))
	}
	if dstPort > 0 {
		out = append(out, otelKVInt("destination.port", dstPort))
	}
	if proto > 0 {
		out = append(out, otelKV("network.transport", networkTransport(proto)))
		out = append(out, otelKVInt("network.iana_protocol_number", proto))
	}
	if bytes > 0 {
		out = append(out, otelKVInt("network.io.bytes", bytes))
	}
	if packets > 0 {
		out = append(out, otelKVInt("network.io.packets", packets))
	}
	if action != "" {
		out = append(out, otelKV("network.action", strings.ToLower(action)))
	}
	return out
}

func otelDBAttributes(f map[string]any) []any {
	var out []any
	query := strField(f, "query")
	database := strField(f, "database")
	duration := firstIntField(f, "duration_ms", "query_time_ms")

	if query != "" {
		out = append(out,
			otelKV("db.query.text", query),
			otelKV("db.operation.name", sqlOperation(query)),
		)
	}
	if database != "" {
		out = append(out, otelKV("db.namespace", database))
	}
	if duration > 0 {
		out = append(out, otelKVDouble("db.client.operation.duration", float64(duration)/1000.0))
		out = append(out, otelKVInt("db.client.operation.duration_ms", duration))
	}
	return out
}

func otelLifecycleAttributes(f map[string]any) []any {
	var out []any
	if port := intField(f, "port"); port > 0 {
		out = append(out, otelKVInt("server.port", port))
	}
	if framework := strField(f, "framework"); framework != "" {
		out = append(out, otelKV("service.framework", framework))
	}
	out = append(out, otelKV("event.name", "application.lifecycle"))
	return out
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
