package generators

import (
	"fmt"
	"hash/fnv"
	"strings"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// MysqlGenerator emits MySQL general query log and slow query log entries.
// Stage 1 of PHYSICS_PLAN.md: each query log corresponds to one Request
// visiting this datastore, carries the request's TraceID, and the SQL
// derives from the upstream HTTP method+path so the query reads as
// "what an app calling this endpoint would actually issue."
type MysqlGenerator struct{}

func (g *MysqlGenerator) Generate(target Target, _ []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Service == nil {
		return nil
	}
	effective := ctx.Override.ApplyToConfig(target.Service.Generator)
	cfg := &effective
	database := cfg.Database
	if database == "" {
		database = "app"
	}
	slowThresholdMs := cfg.SlowQueryThreshold
	if slowThresholdMs == 0 {
		slowThresholdMs = 1000
	}

	type visit struct {
		req *event.Request
		hop *event.Hop
	}
	visits := make([]visit, 0, len(ctx.Requests))
	for ri := range ctx.Requests {
		r := &ctx.Requests[ri]
		if h := r.HopAt(target.Service.Name); h != nil {
			visits = append(visits, visit{req: r, hop: h})
		}
	}
	visits = applyVolumeOverrideToVisits(visits, ctx)
	if len(visits) == 0 {
		return nil
	}

	entries := make([]event.LogEntry, 0, len(visits)*2)
	for i, v := range visits {
		ts := v.hop.EnteredAt
		latency := applyLatency(v.hop.LatencyMs, ctx)
		// Connection ID: stable per session so slow queries on the same
		// connection thread together in real-MySQL fashion.
		connID := connIDForSession(v.req.SessionID)
		query := sqlForRequest(v.req.Method, v.req.Path)

		tsStr := ts.UTC().Format("2006-01-02T15:04:05.000000Z")
		raw := fmt.Sprintf("%s\t%d Query\t%s", tsStr, connID, query)

		entries = append(entries, event.LogEntry{
			ID:         makeID(target, ctx.TickIndex, i*2),
			TS:         ts.Format("2006-01-02T15:04:05.000Z07:00"),
			Source:     target.Source,
			Level:      "INFO",
			Sourcetype: "mysql",
			Class:      "datastore_activity",
			TraceID:    v.req.TraceID,
			SpanID:     v.hop.SpanID,
			CauseIDs:   v.hop.CauseIDs,
			Raw:        raw,
			Fields: map[string]any{
				"conn_id":     connID,
				"query":       query,
				"database":    database,
				"duration_ms": latency,
				"trace_id":    v.req.TraceID,
				"span_id":     v.hop.SpanID,
			},
		})

		if latency >= slowThresholdMs {
			slowRaw := fmt.Sprintf(
				"# Time: %s\n# User@Host: app[app] @ localhost [127.0.0.1]  Id: %d\n"+
					"# Query_time: %.6f  Lock_time: 0.000001  Rows_sent: %d  Rows_examined: %d\n"+
					"# Trace_id: %s\n"+
					"SET timestamp=%d;\n%s;",
				tsStr, connID,
				float64(latency)/1000.0,
				rowsSentForQuery(v.req.Method),
				rowsExaminedForQuery(v.req.Method, ctx.Rng),
				v.req.TraceID,
				ts.Unix(), query,
			)
			entries = append(entries, event.LogEntry{
				ID:         makeID(target, ctx.TickIndex, i*2+1),
				TS:         ts.Format("2006-01-02T15:04:05.000Z07:00"),
				Source:     target.Source,
				Level:      "WARN",
				Sourcetype: "mysql",
				Class:      "datastore_activity",
				TraceID:    v.req.TraceID,
				SpanID:     v.hop.SpanID,
				Raw:        slowRaw,
				Fields: map[string]any{
					"conn_id":           connID,
					"query":             query,
					"database":          database,
					"query_time_ms":     latency,
					"slow_query":        true,
					"slow_threshold_ms": slowThresholdMs,
					"trace_id":          v.req.TraceID,
					"span_id":           v.hop.SpanID,
				},
			})
		}
	}

	return entries
}

// sqlForRequest synthesises a SQL string consistent with an HTTP request's
// method and path. Real apps issue several queries per request — Stage 1
// emits one representative query; Stage 3 (declared `endpoints[].calls`)
// will replace this with explicit per-endpoint query lists.
func sqlForRequest(method, path string) string {
	table := tableFromPath(path)
	if table == "" {
		table = "data"
	}
	id := idFromPath(path)
	switch strings.ToUpper(method) {
	case "GET":
		if id != "" {
			return fmt.Sprintf("SELECT * FROM %s WHERE id = %s", table, id)
		}
		return fmt.Sprintf("SELECT id, name, created_at FROM %s WHERE active = 1 LIMIT 50", table)
	case "POST":
		return fmt.Sprintf("INSERT INTO %s (name, created_at) VALUES (?, NOW())", table)
	case "PUT", "PATCH":
		if id != "" {
			return fmt.Sprintf("UPDATE %s SET updated_at = NOW() WHERE id = %s", table, id)
		}
		return fmt.Sprintf("UPDATE %s SET updated_at = NOW() WHERE id = ?", table)
	case "DELETE":
		if id != "" {
			return fmt.Sprintf("DELETE FROM %s WHERE id = %s", table, id)
		}
		return fmt.Sprintf("DELETE FROM %s WHERE expired_at < NOW()", table)
	}
	return fmt.Sprintf("SELECT * FROM %s LIMIT 1", table)
}

// tableFromPath returns the resource segment in a REST-ish path
// (the segment after /api/, or the first non-empty segment).
func tableFromPath(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i, p := range parts {
		if p == "api" || p == "v1" || p == "v2" {
			continue
		}
		// Skip numeric segments (they're IDs, not table names).
		if _, isID := isAllDigits(p), false; !isID {
			_ = i
		}
		if !isAllDigits(p) {
			return p
		}
	}
	return ""
}

// idFromPath returns the last numeric segment of a path, or empty if none.
func idFromPath(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if isAllDigits(parts[i]) {
			return parts[i]
		}
	}
	return ""
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// connIDForSession maps a SessionID to a stable connection ID in the
// MySQL-typical range. Same session → same connection across queries —
// what a real connection pool would produce.
func connIDForSession(session string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(session))
	return 1000 + int(h.Sum32()%9000)
}

func rowsSentForQuery(method string) int {
	switch strings.ToUpper(method) {
	case "GET":
		return 1
	case "POST", "PUT", "PATCH", "DELETE":
		return 0
	}
	return 1
}

func rowsExaminedForQuery(method string, rng interface{ Intn(int) int }) int {
	switch strings.ToUpper(method) {
	case "GET":
		return 100 + rng.Intn(10000)
	}
	return 1 + rng.Intn(10)
}

// Ensure scenario import is used (it's used by GeneratorConfig fields).
var _ = scenario.ServiceTypeMySQL
