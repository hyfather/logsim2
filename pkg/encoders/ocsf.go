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
	ocsfCategoryIAM         = 3
	ocsfCategoryNetwork     = 4
	ocsfCategoryApplication = 6

	ocsfClassAccountChange        = 3001
	ocsfClassAuthentication       = 3002
	ocsfClassNetworkActivity      = 4001
	ocsfClassHTTPActivity         = 4002
	ocsfClassAPIActivity          = 6003
	ocsfClassApplicationLifecycle = 6002
	ocsfClassDatastoreActivity    = 6005

	// ocsfSchemaVersion tracks the published OCSF schema this encoder targets.
	// Bumping this is the signal that builders have been reviewed against the
	// new spec — don't change the string in isolation.
	ocsfSchemaVersion = "1.5.0"
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
	case ClassAuthentication:
		return ocsfAuthentication(e)
	case ClassAccountChange:
		return ocsfAccountChange(e)
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

// ocsfAPIActivity → class_uid 6003. activity_id is derived from the operation
// name (e.g. "DescribeBilling" → Read, "CreateAccessKey" → Create) so per-API
// CRUD intent is reflected without analytics having to pattern-match strings.
// Falls back to the http method when no operation is supplied.
func ocsfAPIActivity(e *event.LogEntry) map[string]any {
	op := firstNonEmpty(strField(e.Fields, "operation"), strField(e.Fields, "event_name"))
	method := strField(e.Fields, "method")

	activityID, activityName := apiActivity(op, method)
	if v := intField(e.Fields, "activity_id"); v != 0 {
		activityID = v
		activityName = apiActivityName(activityID)
	}

	out := ocsfBase(e, ocsfCategoryApplication, "Application Activity",
		ocsfClassAPIActivity, "API Activity",
		activityID, activityName)

	if op != "" {
		api := map[string]any{"operation": op}
		if svc := strField(e.Fields, "service_name"); svc != "" {
			api["service"] = map[string]any{"name": svc}
		}
		if reqUID := strField(e.Fields, "request_uid"); reqUID != "" {
			api["request"] = map[string]any{"uid": reqUID}
		}
		out["api"] = api
	}
	if actor := actorFromFields(e.Fields); actor != nil {
		out["actor"] = actor
	}
	if src := srcEndpointFromFields(e.Fields); src != nil {
		out["src_endpoint"] = src
	}
	if region := strField(e.Fields, "region"); region != "" {
		out["cloud"] = map[string]any{"region": region, "provider": firstNonEmpty(strField(e.Fields, "cloud_provider"), "AWS")}
	}
	if status := strField(e.Fields, "status"); status != "" {
		applyStatus(out, status)
	}
	return out
}

// ocsfAuthentication → class_uid 3002. activity_id 1 (Logon) is the default
// since that's the dominant CloudTrail console-signin signal; an explicit
// "logoff" event_name flips it. Fields the spec calls out specifically —
// is_mfa, logon_type, auth_protocol — are passed through when set so analytics
// can tell an MFA console login apart from a non-MFA root one.
func ocsfAuthentication(e *event.LogEntry) map[string]any {
	op := firstNonEmpty(strField(e.Fields, "operation"), strField(e.Fields, "event_name"))
	activityID, activityName := authActivity(op)
	if v := intField(e.Fields, "activity_id"); v != 0 {
		activityID = v
		activityName = authActivityName(activityID)
	}

	out := ocsfBase(e, ocsfCategoryIAM, "Identity & Access Management",
		ocsfClassAuthentication, "Authentication",
		activityID, activityName)

	if u := userFromFields(e.Fields); u != nil {
		out["user"] = u
	}
	if actor := actorFromFields(e.Fields); actor != nil {
		out["actor"] = actor
	}
	if src := srcEndpointFromFields(e.Fields); src != nil {
		out["src_endpoint"] = src
	}
	if dst := strField(e.Fields, "dst_svc_name"); dst != "" {
		out["dst_endpoint"] = map[string]any{"svc_name": dst}
	}
	if proto := strField(e.Fields, "auth_protocol"); proto != "" {
		out["auth_protocol"] = proto
	}
	if logon := strField(e.Fields, "logon_type"); logon != "" {
		out["logon_type"] = logon
	}
	if v, ok := boolField(e.Fields, "is_mfa"); ok {
		out["is_mfa"] = v
	}
	if v, ok := boolField(e.Fields, "is_remote"); ok {
		out["is_remote"] = v
	}
	if status := strField(e.Fields, "status"); status != "" {
		applyStatus(out, status)
	}
	return out
}

// ocsfAccountChange → class_uid 3001. activity_id is derived from the IAM
// operation verb when present (CreateAccessKey → Create, DeleteUser → Delete,
// AttachUserPolicy → Attach Policy, etc.) so the CRUD shape is truthful.
func ocsfAccountChange(e *event.LogEntry) map[string]any {
	op := firstNonEmpty(strField(e.Fields, "operation"), strField(e.Fields, "event_name"))
	activityID, activityName := accountChangeActivity(op)
	if v := intField(e.Fields, "activity_id"); v != 0 {
		activityID = v
		activityName = accountChangeActivityName(activityID)
	}

	out := ocsfBase(e, ocsfCategoryIAM, "Identity & Access Management",
		ocsfClassAccountChange, "Account Change",
		activityID, activityName)

	if u := userFromFields(e.Fields); u != nil {
		out["user"] = u
	}
	if actor := actorFromFields(e.Fields); actor != nil {
		out["actor"] = actor
	}
	if src := srcEndpointFromFields(e.Fields); src != nil {
		out["src_endpoint"] = src
	}
	if op != "" {
		api := map[string]any{"operation": op}
		if svc := strField(e.Fields, "service_name"); svc != "" {
			api["service"] = map[string]any{"name": svc}
		}
		out["api"] = api
	}
	if status := strField(e.Fields, "status"); status != "" {
		applyStatus(out, status)
	}
	return out
}

// ocsfGeneric is the fallback when Class is empty/unknown. Rather than emit a
// flat 6001/0 ("Application Activity / Unknown") for every unclassified line,
// it inspects the source path and the message body for well-known service /
// event-name markers (cloudtrail, iam, okta, ad-dc, signin, ConsoleLogin,
// CreateUser, ...) and dispatches to the matching class builder. That way a
// scenario whose templates only carry free text — but whose service is named
// "aws-iam-host" or "ad-dc-01" — still gets a truthful class_uid and
// activity_id, instead of every event collapsing to Unknown. When nothing
// matches we keep the original 6001/0 shape so a truly opaque line stays
// honest about being opaque.
func ocsfGeneric(e *event.LogEntry) map[string]any {
	if cls := inferClassFromContext(e); cls != "" {
		switch cls {
		case ClassAuthentication:
			return ocsfAuthentication(e)
		case ClassAccountChange:
			return ocsfAccountChange(e)
		case ClassAPIActivity:
			return ocsfAPIActivity(e)
		}
	}
	return ocsfBase(e, ocsfCategoryApplication, "Application Activity",
		6001, "Application Activity",
		0, "Unknown")
}

// inferClassFromContext is a heuristic, source-pattern-driven classifier for
// custom-template events that didn't declare their own Class. It matches
// against the source path (joined dotpath like "vpc.subnet.host.svc"), the
// sourcetype, and the raw message — in that priority order — and returns the
// Class constant the encoder should dispatch to. Returns "" when no marker
// looks safe, so the caller stays on the strict Application Activity / Unknown
// fallback for truly opaque events.
//
// Markers are intentionally narrow: a service named "aws-iam" or "okta-auth"
// is reliably an identity/api signal; ambiguous tokens (just "user" or "log")
// don't trigger a guess.
func inferClassFromContext(e *event.LogEntry) string {
	hay := strings.ToLower(e.Source + " " + e.Sourcetype + " " + e.Raw)

	// Authentication is the highest-confidence inference: directory controllers,
	// signin endpoints, SSO/identity provider login surfaces, and CloudTrail
	// ConsoleLogin events all map there.
	authMarkers := []string{
		"signin", "console-login", "consolelogin", "ad-dc", "ldap",
		"kerberos", "okta-auth", "auth0", "sso", "oauth", "saml",
		"entra-id", "external-idp", "vendor-vpn", "jump-rdp", "rdp-",
	}
	for _, m := range authMarkers {
		if strings.Contains(hay, m) {
			return ClassAuthentication
		}
	}

	// Account / entity-management surfaces — IAM mutations, AAD account ops,
	// and the AWS Lambda / EC2 control plane events that show up alongside.
	// Match only when the message verb agrees, since the same service can
	// emit both account-change events and plain reads.
	if hasAccountChangeMarker(hay) {
		return ClassAccountChange
	}

	// Anything else with a service-path-shaped source (`vpc.subnet.host.svc`)
	// classifies as API Activity. Operational service logs from CloudTrail
	// pipes, IAM consoles, Graph/Okta tenancy, k8s API servers, search
	// clusters, message brokers, file/object stores, and SaaS APIs are all
	// API-call traces in OCSF terms — better to call them that than collapse
	// every unclassified line to "Unknown". Truly raw lines with no source
	// (Source == "") keep the strict 6001/0 fallback.
	if e.Source != "" && strings.Contains(e.Source, ".") {
		return ClassAPIActivity
	}
	return ""
}

// hasAccountChangeMarker looks for IAM/account-mutation event names in the
// haystack so a free-text log that mentions CreateUser / DeleteAccessKey /
// PasswordReset still classifies as Account Change instead of falling
// through to API Activity.
func hasAccountChangeMarker(hay string) bool {
	markers := []string{
		"createuser", "deleteuser", "createaccesskey", "deleteaccesskey",
		"updateloginprofile", "passwordreset", "resetpassword", "changepassword",
		"attachuserpolicy", "detachuserpolicy", "attachrolepolicy", "detachrolepolicy",
		"createrole", "deleterole", "addusertogroup", "removeuserfromgroup",
		"enablemfa", "deactivatemfadevice", "deletemfadevice",
	}
	for _, m := range markers {
		if strings.Contains(hay, m) {
			return true
		}
	}
	return false
}

// --- shared base -----------------------------------------------------------

func ocsfBase(e *event.LogEntry, categoryUID int, categoryName string,
	classUID int, className string,
	activityID int, activityName string,
) map[string]any {
	sevID, sevName := severityFromLevel(e.Level)
	t := parseTime(e.TS)
	typeUID := classUID*100 + activityID

	return map[string]any{
		"category_uid":  categoryUID,
		"category_name": categoryName,
		"class_uid":     classUID,
		"class_name":    className,
		"activity_id":   activityID,
		"activity_name": activityName,
		"type_uid":      typeUID,
		"type_name":     className + ": " + activityName,
		"severity_id":   sevID,
		"severity":      sevName,
		"time":          t.UnixMilli(),
		"time_dt":       t.UTC().Format(time.RFC3339Nano),
		"message":       e.Raw,
		"status_id":     1, // Success by default; class builders override on failure
		"status":        "Success",
		"observables":   nil, // omit; encoders set up specifics if needed
		"metadata": map[string]any{
			"version":       ocsfSchemaVersion,
			"log_name":      e.Source,
			"original_time": e.TS,
			"uid":           e.ID,
		},
	}
}

// applyStatus normalizes a free-form status string ("Success", "Failure",
// "FAILED", "error") to the OCSF status_id/status pair so builders that pull
// status off Fields don't each reinvent the mapping.
func applyStatus(out map[string]any, status string) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success", "succeeded", "ok":
		out["status_id"] = 1
		out["status"] = "Success"
	case "failure", "failed", "fail", "error", "denied":
		out["status_id"] = 2
		out["status"] = "Failure"
	default:
		out["status_id"] = 0
		out["status"] = "Unknown"
	}
}

// userFromFields builds an OCSF User object from flat user_* fields. Returns
// nil if the fields carry no user identity at all so callers can decide
// whether to attach a `user` key.
func userFromFields(f map[string]any) map[string]any {
	name := firstNonEmpty(strField(f, "user_name"), strField(f, "user.name"))
	uid := firstNonEmpty(strField(f, "user_uid"), strField(f, "user.uid"))
	utype := firstNonEmpty(strField(f, "user_type"), strField(f, "user.type"))
	uidAlt := strField(f, "user_uid_alt")
	if name == "" && uid == "" && utype == "" && uidAlt == "" {
		return nil
	}
	out := map[string]any{}
	if name != "" {
		out["name"] = name
	}
	if uid != "" {
		out["uid"] = uid
	}
	if utype != "" {
		out["type"] = utype
	}
	if uidAlt != "" {
		out["uid_alt"] = uidAlt
	}
	if account := strField(f, "user_account_uid"); account != "" {
		out["account"] = map[string]any{"uid": account, "type": "AWS Account"}
	}
	return out
}

// actorFromFields builds an OCSF Actor.user object from actor_* fields. The
// actor is the principal performing the action — for CloudTrail that's the
// userIdentity. Falls back to userFromFields when no actor_* fields exist
// so callers can still get an actor for events where the user IS the actor.
func actorFromFields(f map[string]any) map[string]any {
	name := strField(f, "actor_user_name")
	uid := strField(f, "actor_user_uid")
	utype := strField(f, "actor_user_type")
	if name == "" && uid == "" && utype == "" {
		if u := userFromFields(f); u != nil {
			return map[string]any{"user": u}
		}
		return nil
	}
	user := map[string]any{}
	if name != "" {
		user["name"] = name
	}
	if uid != "" {
		user["uid"] = uid
	}
	if utype != "" {
		user["type"] = utype
	}
	if account := strField(f, "actor_account_uid"); account != "" {
		user["account"] = map[string]any{"uid": account, "type": "AWS Account"}
	}
	return map[string]any{"user": user}
}

// srcEndpointFromFields gathers caller-side network identity (ip, hostname,
// user_agent) into one OCSF NetworkEndpoint. Returns nil when nothing's set.
func srcEndpointFromFields(f map[string]any) map[string]any {
	ip := firstNonEmpty(strField(f, "src_ip"), strField(f, "client_ip"), strField(f, "remote_addr"))
	hostname := strField(f, "src_hostname")
	ua := strField(f, "user_agent")
	country := strField(f, "src_country")
	if ip == "" && hostname == "" && ua == "" && country == "" {
		return nil
	}
	out := map[string]any{}
	if ip != "" {
		out["ip"] = ip
	}
	if hostname != "" {
		out["hostname"] = hostname
	}
	if ua != "" {
		out["agent_list"] = []any{map[string]any{"name": ua, "type": "User Agent"}}
	}
	if country != "" {
		out["location"] = map[string]any{"country": country}
	}
	return out
}

// boolField reads a bool out of Fields tolerating the JSON/YAML quirk where
// "true"/"false" sometimes arrive as strings. Returns ok=false when the key
// isn't present so callers don't conflate "absent" with "false".
func boolField(m map[string]any, k string) (bool, bool) {
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

// authActivity maps a CloudTrail-style operation/event name to OCSF
// Authentication activity_id. Anything we can't classify lands as Logon (1)
// since console-signin is the dominant signal — better a sane default than
// Unknown for the common case.
func authActivity(op string) (int, string) {
	switch strings.ToLower(strings.TrimSpace(op)) {
	case "logoff", "consolelogout":
		return 2, "Logoff"
	case "preauth":
		return 6, "Preauth"
	case "":
		return 1, "Logon"
	default:
		return 1, "Logon"
	}
}

func authActivityName(id int) string {
	switch id {
	case 1:
		return "Logon"
	case 2:
		return "Logoff"
	case 3:
		return "Authentication Ticket"
	case 4:
		return "Service Ticket Request"
	case 5:
		return "Service Ticket Renew"
	case 6:
		return "Preauth"
	default:
		return "Unknown"
	}
}

// accountChangeActivity matches an IAM-style operation prefix to an OCSF
// Account Change activity_id. The prefixes follow AWS IAM API conventions
// (Create*, Delete*, Attach*Policy, etc.) so the mapping holds for the events
// CloudTrail actually emits.
func accountChangeActivity(op string) (int, string) {
	o := strings.ToLower(strings.TrimSpace(op))
	switch {
	case strings.HasPrefix(o, "create"):
		return 1, "Create"
	case strings.HasPrefix(o, "enable"):
		return 2, "Enable"
	case strings.Contains(o, "passwordchange"), o == "changepassword":
		return 3, "Password Change"
	case strings.Contains(o, "passwordreset"), o == "resetpassword":
		return 4, "Password Reset"
	case strings.HasPrefix(o, "disable"), strings.HasPrefix(o, "deactivate"):
		return 5, "Disable"
	case strings.HasPrefix(o, "delete"), strings.HasPrefix(o, "remove"):
		return 6, "Delete"
	case strings.HasPrefix(o, "attach") && strings.Contains(o, "policy"):
		return 7, "Attach Policy"
	case strings.HasPrefix(o, "detach") && strings.Contains(o, "policy"):
		return 8, "Detach Policy"
	case strings.Contains(o, "lockout"):
		return 9, "Lockout"
	default:
		return 0, "Unknown"
	}
}

func accountChangeActivityName(id int) string {
	switch id {
	case 1:
		return "Create"
	case 2:
		return "Enable"
	case 3:
		return "Password Change"
	case 4:
		return "Password Reset"
	case 5:
		return "Disable"
	case 6:
		return "Delete"
	case 7:
		return "Attach Policy"
	case 8:
		return "Detach Policy"
	case 9:
		return "Lockout"
	default:
		return "Unknown"
	}
}

// apiActivity picks an OCSF API Activity activity_id. Operation names take
// priority because CRUD intent is more semantic than the HTTP verb — a POST
// can be a Read (e.g. AWS APIs encode reads as POSTs). The HTTP method is the
// next fallback. With neither, the default is Read (2) since operational API
// chatter from control-plane services skews heavily toward Get/Describe/List;
// callers that genuinely don't know can pass activity_id=0 in fields to
// override.
func apiActivity(op, method string) (int, string) {
	o := strings.ToLower(strings.TrimSpace(op))
	switch {
	case o == "":
		// fall through to method-based mapping below
	case strings.HasPrefix(o, "create"), strings.HasPrefix(o, "put"), strings.HasPrefix(o, "add"):
		return 1, "Create"
	case strings.HasPrefix(o, "get"), strings.HasPrefix(o, "describe"), strings.HasPrefix(o, "list"), strings.HasPrefix(o, "read"), strings.HasPrefix(o, "lookup"), strings.HasPrefix(o, "search"):
		return 2, "Read"
	case strings.HasPrefix(o, "update"), strings.HasPrefix(o, "modify"), strings.HasPrefix(o, "patch"), strings.HasPrefix(o, "set"):
		return 3, "Update"
	case strings.HasPrefix(o, "delete"), strings.HasPrefix(o, "remove"), strings.HasPrefix(o, "terminate"):
		return 4, "Delete"
	}
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "POST":
		return 1, "Create"
	case "GET", "HEAD":
		return 2, "Read"
	case "PUT", "PATCH":
		return 3, "Update"
	case "DELETE":
		return 4, "Delete"
	default:
		return 2, "Read"
	}
}

func apiActivityName(id int) string {
	switch id {
	case 1:
		return "Create"
	case 2:
		return "Read"
	case 3:
		return "Update"
	case 4:
		return "Delete"
	default:
		return "Unknown"
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
