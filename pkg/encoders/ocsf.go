package encoders

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
)

// OCSF v1.x class identifiers. Kept as named constants so additions to the
// schema map to one obvious place rather than scattered magic numbers.
const (
	ocsfCategoryNetwork     = 4
	ocsfCategoryApplication = 6

	ocsfClassNetworkActivity      = 4001
	ocsfClassHTTPActivity         = 4002
	ocsfClassAPIActivity          = 6003
	ocsfClassApplicationLifecycle = 6002
	ocsfClassDatastoreActivity    = 6005
)

// ocsfEncoder maps a LogEntry to an OCSF event JSON object.
type ocsfEncoder struct{}

func (ocsfEncoder) Format() Format { return FormatOCSF }

func (e ocsfEncoder) Encode(le *event.LogEntry) ([]byte, error) {
	obj := buildOCSF(le)
	return json.Marshal(obj)
}

// buildOCSF dispatches to a class-specific builder when the entry's Class hint
// matches a known mapping; otherwise it emits a generic Application Activity
// shape so unknown event sources still produce schema-valid OCSF.
func buildOCSF(e *event.LogEntry) map[string]any {
	switch e.Class {
	case ClassHTTPActivity:
		return ocsfHTTPActivity(e)
	case ClassNetworkActivity:
		return ocsfNetworkActivity(e)
	case ClassDatastoreActivity:
		return ocsfDatastoreActivity(e)
	case ClassApplicationLifecycle:
		return ocsfApplicationLifecycle(e)
	case ClassAPIActivity:
		return ocsfAPIActivity(e)
	default:
		return ocsfGeneric(e)
	}
}

// --- class builders --------------------------------------------------------

// ocsfHTTPActivity → class_uid 4002. activity_id is derived from the HTTP
// method so analytics can split GETs from mutating verbs without re-parsing
// the message.
func ocsfHTTPActivity(e *event.LogEntry) map[string]any {
	method := strField(e.Fields, "method")
	path := strField(e.Fields, "path")
	status := intField(e.Fields, "status_code")
	srcIP := firstNonEmpty(strField(e.Fields, "client_ip"), strField(e.Fields, "remote_addr"), strField(e.Fields, "src_ip"))
	dstIP := firstNonEmpty(strField(e.Fields, "dst_ip"), strField(e.Fields, "local_addr"))
	duration := firstIntField(e.Fields, "response_time_ms", "rt_ms", "duration_ms")
	bytesSent := intField(e.Fields, "body_bytes")

	activityID, activityName := httpActivity(method)

	out := ocsfBase(e, ocsfCategoryNetwork, "Network Activity",
		ocsfClassHTTPActivity, "HTTP Activity",
		activityID, activityName)

	httpReq := map[string]any{
		"http_method": method,
		"url": map[string]any{
			"path": path,
		},
	}
	httpResp := map[string]any{
		"code": status,
	}
	if status >= 400 {
		out["status_id"] = 2 // Failure
		out["status"] = "Failure"
	}

	out["http_request"] = httpReq
	out["http_response"] = httpResp
	if duration > 0 {
		out["duration"] = duration
	}
	if bytesSent > 0 {
		out["traffic"] = map[string]any{"bytes_out": bytesSent}
	}
	if srcIP != "" {
		out["src_endpoint"] = map[string]any{"ip": srcIP}
	}
	if dstIP != "" {
		out["dst_endpoint"] = map[string]any{"ip": dstIP}
	}
	return out
}

// ocsfNetworkActivity → class_uid 4001 for VPC flow log style records.
func ocsfNetworkActivity(e *event.LogEntry) map[string]any {
	out := ocsfBase(e, ocsfCategoryNetwork, "Network Activity",
		ocsfClassNetworkActivity, "Network Activity",
		6, "Traffic")

	srcIP := strField(e.Fields, "src_ip")
	dstIP := strField(e.Fields, "dst_ip")
	srcPort := intField(e.Fields, "src_port")
	dstPort := intField(e.Fields, "dst_port")
	proto := intField(e.Fields, "protocol")
	bytes := intField(e.Fields, "bytes")
	packets := intField(e.Fields, "packets")
	action := strField(e.Fields, "action")

	if srcIP != "" || srcPort != 0 {
		out["src_endpoint"] = map[string]any{"ip": srcIP, "port": srcPort}
	}
	if dstIP != "" || dstPort != 0 {
		out["dst_endpoint"] = map[string]any{"ip": dstIP, "port": dstPort}
	}
	if proto != 0 {
		out["connection_info"] = map[string]any{"protocol_num": proto}
	}
	if bytes > 0 || packets > 0 {
		traffic := map[string]any{}
		if bytes > 0 {
			traffic["bytes"] = bytes
		}
		if packets > 0 {
			traffic["packets"] = packets
		}
		out["traffic"] = traffic
	}
	switch strings.ToUpper(action) {
	case "ACCEPT", "ALLOW":
		out["action_id"] = 1
		out["action"] = "Allowed"
	case "REJECT", "DENY", "DROP":
		out["action_id"] = 2
		out["action"] = "Denied"
	}
	return out
}

// ocsfDatastoreActivity → class_uid 6005 (Datastore Activity, OCSF v1.x).
// We map MySQL-style query log entries here.
func ocsfDatastoreActivity(e *event.LogEntry) map[string]any {
	query := strField(e.Fields, "query")
	database := strField(e.Fields, "database")
	duration := firstIntField(e.Fields, "duration_ms", "query_time_ms")

	activityID, activityName := sqlActivity(query)

	out := ocsfBase(e, ocsfCategoryApplication, "Application Activity",
		ocsfClassDatastoreActivity, "Datastore Activity",
		activityID, activityName)

	out["query_string"] = query
	if database != "" {
		out["database"] = map[string]any{"name": database, "type": "Relational"}
	}
	if duration > 0 {
		out["duration"] = duration
	}
	return out
}

// ocsfApplicationLifecycle → class_uid 6002. Used for startup heartbeats.
func ocsfApplicationLifecycle(e *event.LogEntry) map[string]any {
	out := ocsfBase(e, ocsfCategoryApplication, "Application Activity",
		ocsfClassApplicationLifecycle, "Application Lifecycle",
		1, "Install")
	if port := intField(e.Fields, "port"); port != 0 {
		out["port"] = port
	}
	return out
}

func ocsfAPIActivity(e *event.LogEntry) map[string]any {
	return ocsfBase(e, ocsfCategoryApplication, "Application Activity",
		ocsfClassAPIActivity, "API Activity",
		0, "Unknown")
}

// ocsfGeneric is the fallback when Class is empty/unknown. It still produces
// valid OCSF base attributes plus the original message — that's better than
// silently dropping the line.
func ocsfGeneric(e *event.LogEntry) map[string]any {
	return ocsfBase(e, ocsfCategoryApplication, "Application Activity",
		6001, "Application Activity",
		0, "Unknown")
}

// --- shared base -----------------------------------------------------------

func ocsfBase(e *event.LogEntry, categoryUID int, categoryName string,
	classUID int, className string,
	activityID int, activityName string,
) map[string]any {
	sevID, sevName := severityFromLevel(e.Level)
	t := parseTime(e.TS)

	return map[string]any{
		"category_uid":   categoryUID,
		"category_name":  categoryName,
		"class_uid":      classUID,
		"class_name":     className,
		"activity_id":    activityID,
		"activity_name":  activityName,
		"type_uid":       classUID*100 + activityID,
		"severity_id":    sevID,
		"severity":       sevName,
		"time":           t.UnixMilli(),
		"time_dt":        t.UTC().Format(time.RFC3339Nano),
		"message":        e.Raw,
		"status_id":      1, // Success by default; HTTP overrides on >=400
		"status":         "Success",
		"observables":    nil, // omit; encoders set up specifics if needed
		"metadata": map[string]any{
			"version":       "1.4.0",
			"log_name":      e.Source,
			"original_time": e.TS,
			"uid":           e.ID,
		},
	}
}

// --- helpers ---------------------------------------------------------------

func severityFromLevel(level string) (int, string) {
	switch strings.ToUpper(level) {
	case "DEBUG":
		return 1, "Informational"
	case "INFO":
		return 1, "Informational"
	case "WARN", "WARNING":
		return 3, "Medium"
	case "ERROR":
		return 4, "High"
	case "FATAL", "CRITICAL":
		return 5, "Critical"
	default:
		return 0, "Unknown"
	}
}

func httpActivity(method string) (int, string) {
	switch strings.ToUpper(method) {
	case "GET", "HEAD":
		return 1, "GET"
	case "POST":
		return 2, "POST"
	case "PUT":
		return 3, "PUT"
	case "DELETE":
		return 4, "DELETE"
	case "OPTIONS":
		return 6, "OPTIONS"
	case "PATCH":
		return 8, "PATCH"
	default:
		return 0, "Unknown"
	}
}

// sqlActivity classifies a query by its leading verb. Useful enough for OCSF
// activity_id without dragging in a full SQL parser.
func sqlActivity(query string) (int, string) {
	q := strings.TrimSpace(strings.ToUpper(query))
	switch {
	case strings.HasPrefix(q, "SELECT"):
		return 1, "Read"
	case strings.HasPrefix(q, "INSERT"):
		return 5, "Create"
	case strings.HasPrefix(q, "UPDATE"):
		return 3, "Update"
	case strings.HasPrefix(q, "DELETE"):
		return 4, "Delete"
	default:
		return 0, "Unknown"
	}
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Now().UTC()
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", time.RFC3339, "2006-01-02T15:04:05Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Now().UTC()
}

func strField(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	v, ok := m[k]
	if !ok {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func intField(m map[string]any, k string) int {
	if m == nil {
		return 0
	}
	switch v := m[k].(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	default:
		return 0
	}
}

func firstIntField(m map[string]any, keys ...string) int {
	for _, k := range keys {
		if v := intField(m, k); v != 0 {
			return v
		}
	}
	return 0
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
