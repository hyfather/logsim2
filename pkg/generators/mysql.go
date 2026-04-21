package generators

import (
	"fmt"
	"math/rand"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// Common query patterns for a generic user/app database.
var mysqlQueryTemplates = []string{
	"SELECT * FROM users WHERE id = %d",
	"SELECT id, name, email FROM users WHERE status = 'active' LIMIT %d",
	"INSERT INTO users (name, email, created_at) VALUES ('%s', '%s', NOW())",
	"UPDATE users SET last_login = NOW() WHERE id = %d",
	"DELETE FROM sessions WHERE expires_at < NOW()",
	"SELECT COUNT(*) FROM users WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)",
	"SELECT u.*, s.token FROM users u JOIN sessions s ON u.id = s.user_id WHERE s.token = '%s'",
	"UPDATE users SET login_count = login_count + 1, last_login = NOW() WHERE id = %d",
}

var randomStrings = []string{
	"alice", "bob", "charlie", "diana", "eve", "frank",
	"alice@example.com", "bob@example.com", "user@test.org",
	"abc123token", "xyz789secret", "qwerty456hash",
}

// MysqlGenerator emits MySQL general query log and slow query log entries.
type MysqlGenerator struct{}

func (g *MysqlGenerator) Generate(target Target, inbound []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Service == nil {
		return nil
	}
	cfg := &target.Service.Generator
	database := cfg.Database
	if database == "" {
		database = "app"
	}
	slowThresholdMs := cfg.SlowQueryThreshold
	if slowThresholdMs == 0 {
		slowThresholdMs = 1000
	}

	totalReqs := 0
	for _, f := range inbound {
		totalReqs += f.RequestCount
	}
	if totalReqs == 0 {
		return nil
	}

	timestamps := spreadTimestamps(ctx.Timestamp, totalReqs, ctx.TickIntervalMs, ctx.Rng)
	entries := make([]event.LogEntry, 0, totalReqs*2) // pre-alloc for potential slow query pairs

	for i := 0; i < totalReqs; i++ {
		ts := ctx.Timestamp
		if i < len(timestamps) {
			ts = timestamps[i]
		}
		tsStr := ts.UTC().Format("2006-01-02T15:04:05.000000Z")
		latency := sampleLatency(50, ctx.Rng)

		connID := 1000 + ctx.Rng.Intn(9000)
		query := buildQuery(ctx.Rng)

		// MySQL general log format
		raw := fmt.Sprintf("%s\t%d Query\t%s", tsStr, connID, query)

		entries = append(entries, event.LogEntry{
			ID:      makeID(ctx.TickIndex, i*2),
			TS:      ts.Format("2006-01-02T15:04:05.000Z07:00"),
			Source:     target.Source,
			Level:      "INFO",
			Sourcetype: "mysql",
			Raw:     raw,
			Fields: map[string]any{
				"conn_id":     connID,
				"query":       query,
				"database":    database,
				"duration_ms": latency,
			},
		})

		// Emit slow query log if latency exceeds threshold.
		if latency >= slowThresholdMs {
			slowRaw := fmt.Sprintf(
				"# Time: %s\n# User@Host: app[app] @ localhost [127.0.0.1]  Id: %d\n"+
					"# Query_time: %.6f  Lock_time: 0.000001  Rows_sent: %d  Rows_examined: %d\n"+
					"SET timestamp=%d;\n%s;",
				ts.UTC().Format("2006-01-02T15:04:05.000000Z"),
				connID,
				float64(latency)/1000.0,
				1+ctx.Rng.Intn(100),
				100+ctx.Rng.Intn(10000),
				ts.Unix(),
				query,
			)
			entries = append(entries, event.LogEntry{
				ID:      makeID(ctx.TickIndex, i*2+1),
				TS:      ts.Format("2006-01-02T15:04:05.000Z07:00"),
				Source:     target.Source,
				Level:      "WARN",
				Sourcetype: "mysql",
				Raw:     slowRaw,
				Fields: map[string]any{
					"conn_id":          connID,
					"query":            query,
					"database":         database,
					"query_time_ms":    latency,
					"slow_query":       true,
					"slow_threshold_ms": slowThresholdMs,
				},
			})
		}
	}

	return entries
}

func buildQuery(rng interface {
	Intn(int) int
	Float64() float64
}) string {
	tpl := mysqlQueryTemplates[rng.Intn(len(mysqlQueryTemplates))]
	// Fill in the format verbs with random realistic values.
	r := rand.New(rand.NewSource(int64(rng.Intn(1 << 30))))
	switch countVerbs(tpl) {
	case 1:
		if containsVerb(tpl, "%d") {
			return fmt.Sprintf(tpl, 1+r.Intn(9999))
		}
		return fmt.Sprintf(tpl, randomStrings[r.Intn(len(randomStrings))])
	case 2:
		return fmt.Sprintf(tpl,
			randomStrings[r.Intn(len(randomStrings))],
			randomStrings[r.Intn(len(randomStrings))])
	default:
		return tpl
	}
}

func countVerbs(s string) int {
	n := 0
	for i := 0; i < len(s)-1; i++ {
		if s[i] == '%' && (s[i+1] == 'd' || s[i+1] == 's') {
			n++
		}
	}
	return n
}

func containsVerb(s, v string) bool {
	for i := 0; i < len(s)-1; i++ {
		if s[i:i+2] == v {
			return true
		}
	}
	return false
}

// Ensure scenario import is used (it's used by GeneratorConfig fields).
var _ = scenario.ServiceTypeMySQL
