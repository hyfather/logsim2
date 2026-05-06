//go:build cgo

package search

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "github.com/marcboeker/go-duckdb/v2"
)

// DuckDBBackend stores events in a single in-memory DuckDB database. Each
// instance owns its database — call NewDuckDBBackend per logical db.
//
// Schema is deliberately fixed and modelled on Splunk HEC so the same shape
// translates cleanly to other backends:
//
//	id          VARCHAR  -- engine event id, may be empty for HEC ingests
//	time        TIMESTAMPTZ
//	host        VARCHAR
//	source      VARCHAR
//	sourcetype  VARCHAR
//	"index"     VARCHAR  -- quoted because INDEX is reserved in DuckDB
//	raw         VARCHAR  -- the rendered log line (or stringified JSON)
//	fields      JSON     -- queried via ->>
//
// Field access in IR functions goes through DuckDB's JSON operators, e.g.
// fields->>'status_code', so callers don't have to materialise dynamic
// columns. That's the same shape Splunk's tstats / Cribl Search expose.
type DuckDBBackend struct {
	mu sync.Mutex
	db *sql.DB
}

// NewDuckDBBackend creates a fresh in-memory DuckDB and bootstraps the schema.
func NewDuckDBBackend() (*DuckDBBackend, error) {
	db, err := sql.Open("duckdb", "")
	if err != nil {
		return nil, fmt.Errorf("open duckdb: %w", err)
	}
	// One conn keeps the in-memory database addressable from every query.
	// DuckDB's database/sql driver routes queries to whichever connection
	// the pool hands out, but each in-memory database is per-connection
	// unless you pin to one — so we pin.
	db.SetMaxOpenConns(1)

	const ddl = `
CREATE TABLE IF NOT EXISTS events (
    id          VARCHAR,
    time        TIMESTAMPTZ NOT NULL,
    host        VARCHAR,
    source      VARCHAR,
    sourcetype  VARCHAR,
    "index"     VARCHAR,
    raw         VARCHAR,
    fields      JSON
);
`
	if _, err := db.ExecContext(context.Background(), ddl); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &DuckDBBackend{db: db}, nil
}

func (b *DuckDBBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return nil
	}
	err := b.db.Close()
	b.db = nil
	return err
}

func (b *DuckDBBackend) Ingest(ctx context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return fmt.Errorf("backend closed")
	}

	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO events
        (id, time, host, source, sourcetype, "index", raw, fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for i := range events {
		e := &events[i]
		var fieldsJSON any
		if len(e.Fields) > 0 {
			b, err := json.Marshal(e.Fields)
			if err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("marshal fields: %w", err)
			}
			fieldsJSON = string(b)
		}
		ts := e.Time
		if ts.IsZero() {
			ts = time.Now()
		}
		if _, err := stmt.ExecContext(ctx,
			e.ID, ts.UTC(), e.Host, e.Source, e.Sourcetype, e.Index, e.Raw, fieldsJSON); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("insert: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func (b *DuckDBBackend) Stats(ctx context.Context) (Stats, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return Stats{}, fmt.Errorf("backend closed")
	}
	var (
		count    int64
		oldestNT sql.NullTime
		newestNT sql.NullTime
	)
	row := b.db.QueryRowContext(ctx, `SELECT count(*), min(time), max(time) FROM events`)
	if err := row.Scan(&count, &oldestNT, &newestNT); err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	s := Stats{EventCount: count}
	if oldestNT.Valid {
		s.OldestEvent = oldestNT.Time
	}
	if newestNT.Valid {
		s.NewestEvent = newestNT.Time
	}
	return s, nil
}

func (b *DuckDBBackend) GetRaw(ctx context.Context, q RawQuery) (RawResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return RawResult{}, fmt.Errorf("backend closed")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}

	var total int64
	if err := b.db.QueryRowContext(ctx,
		`SELECT count(*) FROM events WHERE time >= ? AND time < ?`,
		q.From.UTC(), q.To.UTC()).Scan(&total); err != nil {
		return RawResult{}, fmt.Errorf("count: %w", err)
	}

	rows, err := b.db.QueryContext(ctx,
		`SELECT id, time, host, source, sourcetype, "index", raw, fields
         FROM events
         WHERE time >= ? AND time < ?
         ORDER BY time ASC
         LIMIT ? OFFSET ?`,
		q.From.UTC(), q.To.UTC(), limit, q.Offset)
	if err != nil {
		return RawResult{}, fmt.Errorf("select: %w", err)
	}
	defer rows.Close()

	out := RawResult{Total: total}
	for rows.Next() {
		var e Event
		var t time.Time
		// fields is JSON; the duckdb driver decodes it eagerly into
		// map[string]any for objects (or returns nil/string), so scan
		// into `any` and dispatch.
		var fieldsAny any
		var host, source, sourcetype, index, raw, id sql.NullString
		if err := rows.Scan(&id, &t, &host, &source, &sourcetype, &index, &raw, &fieldsAny); err != nil {
			return RawResult{}, fmt.Errorf("scan: %w", err)
		}
		e.ID = id.String
		e.Time = t
		e.Host = host.String
		e.Source = source.String
		e.Sourcetype = sourcetype.String
		e.Index = index.String
		e.Raw = raw.String
		switch fv := fieldsAny.(type) {
		case nil:
			// no fields
		case map[string]any:
			e.Fields = fv
		case string:
			if fv != "" {
				_ = json.Unmarshal([]byte(fv), &e.Fields)
			}
		case []byte:
			if len(fv) > 0 {
				_ = json.Unmarshal(fv, &e.Fields)
			}
		}
		out.Events = append(out.Events, e)
	}
	return out, rows.Err()
}

// fieldExpr maps a caller-supplied field name to a DuckDB SQL expression.
// Top-level columns (host, source, sourcetype, level, raw, time) are
// referenced directly; everything else is read out of the JSON fields blob.
// `level` is mapped to fields->>'level' since we don't promote it to a
// column — that mirrors how Splunk indexes it as a metadata field.
func fieldExpr(name string) string {
	switch strings.ToLower(name) {
	case "host", "source", "sourcetype":
		return strings.ToLower(name)
	case "index":
		return `"index"`
	case "raw":
		return "raw"
	case "time":
		return "time"
	case "":
		return ""
	}
	// Anything else: JSON path lookup. We deliberately do not interpolate
	// the raw name into the SQL; instead it goes via the JSON path operator
	// which DuckDB parameterises safely.
	return fmt.Sprintf("(fields->>%s)", quoteSQLString(name))
}

// quoteSQLString returns a single-quoted SQL string literal with embedded
// quotes doubled. We use it for identifiers we control (field names) where
// passing through ? would interfere with DuckDB's JSON operator parser.
func quoteSQLString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func (b *DuckDBBackend) GetSummary(ctx context.Context, q SummaryQuery) (SummaryResult, error) {
	if !IsValidAggFn(string(q.AggFn)) {
		return SummaryResult{}, fmt.Errorf("invalid agg_fn %q", q.AggFn)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return SummaryResult{}, fmt.Errorf("backend closed")
	}

	var aggExpr string
	switch q.AggFn {
	case AggCount:
		aggExpr = "count(*)"
	case AggDistinctCount:
		if q.AggField == "" {
			return SummaryResult{}, fmt.Errorf("distinct_count requires agg_field")
		}
		aggExpr = fmt.Sprintf("count(DISTINCT %s)", fieldExpr(q.AggField))
	default:
		if q.AggField == "" {
			return SummaryResult{}, fmt.Errorf("%s requires agg_field", q.AggFn)
		}
		// Cast through DOUBLE so JSON-extracted strings like "200" sum.
		aggExpr = fmt.Sprintf("%s(TRY_CAST(%s AS DOUBLE))", q.AggFn, fieldExpr(q.AggField))
	}

	var sqlStr string
	if q.GroupBy == "" {
		sqlStr = fmt.Sprintf(`SELECT '' AS grp, %s AS val
            FROM events WHERE time >= ? AND time < ?`, aggExpr)
	} else {
		grpExpr := fieldExpr(q.GroupBy)
		sqlStr = fmt.Sprintf(`SELECT COALESCE(%s, '') AS grp, %s AS val
            FROM events WHERE time >= ? AND time < ?
            GROUP BY grp ORDER BY val DESC`, grpExpr, aggExpr)
	}

	rows, err := b.db.QueryContext(ctx, sqlStr, q.From.UTC(), q.To.UTC())
	if err != nil {
		return SummaryResult{}, fmt.Errorf("summary: %w", err)
	}
	defer rows.Close()

	var out SummaryResult
	for rows.Next() {
		var grp sql.NullString
		var val sql.NullFloat64
		if err := rows.Scan(&grp, &val); err != nil {
			return SummaryResult{}, fmt.Errorf("scan: %w", err)
		}
		out.Rows = append(out.Rows, SummaryRow{Group: grp.String, Value: val.Float64})
	}
	return out, rows.Err()
}

func (b *DuckDBBackend) GetDistribution(ctx context.Context, q DistributionQuery) (DistributionResult, error) {
	if q.BucketSeconds <= 0 {
		return DistributionResult{}, fmt.Errorf("bucket_seconds must be > 0")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return DistributionResult{}, fmt.Errorf("backend closed")
	}

	bucketExpr := fmt.Sprintf("time_bucket(INTERVAL '%d seconds', time)", q.BucketSeconds)
	var sqlStr string
	args := []any{q.From.UTC(), q.To.UTC()}

	if q.GroupBy == "" {
		sqlStr = fmt.Sprintf(`SELECT %s AS bucket, '' AS grp, count(*) AS n
            FROM events WHERE time >= ? AND time < ?
            GROUP BY bucket ORDER BY bucket ASC`, bucketExpr)
	} else {
		grpExpr := fieldExpr(q.GroupBy)
		sqlStr = fmt.Sprintf(`SELECT %s AS bucket, COALESCE(%s, '') AS grp, count(*) AS n
            FROM events WHERE time >= ? AND time < ?
            GROUP BY bucket, grp ORDER BY bucket ASC, n DESC`, bucketExpr, grpExpr)
	}

	rows, err := b.db.QueryContext(ctx, sqlStr, args...)
	if err != nil {
		return DistributionResult{}, fmt.Errorf("distribution: %w", err)
	}
	defer rows.Close()

	var out DistributionResult
	for rows.Next() {
		var bucket time.Time
		var grp sql.NullString
		var n int64
		if err := rows.Scan(&bucket, &grp, &n); err != nil {
			return DistributionResult{}, fmt.Errorf("scan: %w", err)
		}
		out.Buckets = append(out.Buckets, DistributionBucket{
			Start: bucket, Group: grp.String, Count: n,
		})
	}
	return out, rows.Err()
}

func (b *DuckDBBackend) GetTopValues(ctx context.Context, q TopValuesQuery) (TopValuesResult, error) {
	if q.Field == "" {
		return TopValuesResult{}, fmt.Errorf("field is required")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 10
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.db == nil {
		return TopValuesResult{}, fmt.Errorf("backend closed")
	}

	expr := fieldExpr(q.Field)
	sqlStr := fmt.Sprintf(`SELECT %s AS v, count(*) AS n
        FROM events WHERE time >= ? AND time < ? AND %s IS NOT NULL
        GROUP BY v ORDER BY n DESC LIMIT ?`, expr, expr)

	rows, err := b.db.QueryContext(ctx, sqlStr, q.From.UTC(), q.To.UTC(), limit)
	if err != nil {
		return TopValuesResult{}, fmt.Errorf("top_values: %w", err)
	}
	defer rows.Close()

	var out TopValuesResult
	for rows.Next() {
		var v sql.NullString
		var n int64
		if err := rows.Scan(&v, &n); err != nil {
			return TopValuesResult{}, fmt.Errorf("scan: %w", err)
		}
		out.Values = append(out.Values, TopValue{Value: v.String, Count: n})
	}
	return out, rows.Err()
}
