package generators

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// NodejsGenerator emits Node.js / Express-style access logs as projections
// of Requests visiting this service. Stage 1 of PHYSICS_PLAN.md: every log
// derives its method/path/status from the Request — not from independent
// random draws — so the LB's view and the backend's view of the same
// request agree.
type NodejsGenerator struct{}

func (g *NodejsGenerator) Generate(target Target, _ []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Service == nil {
		return nil
	}
	effective := ctx.Override.ApplyToConfig(target.Service.Generator)
	cfg := &effective
	framework := "express"
	logFormat := cfg.LogFormat
	if logFormat == "" {
		logFormat = "json"
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
		if ctx.TickIndex == 0 {
			return []event.LogEntry{g.startupLog(target, cfg, framework, logFormat, ctx)}
		}
		return nil
	}

	entries := make([]event.LogEntry, 0, len(visits))
	for i, v := range visits {
		ts := v.hop.EnteredAt
		method := v.req.Method
		path := v.req.Path
		status := v.hop.Status
		// responseTime is the backend's wall-clock view of the request:
		// own service time plus any downstream calls (DB, cache) it
		// synchronously waited on.
		latency := applyLatency(observedRequestTimeFrom(v.req, target.Service.Name), ctx)
		level := levelForStatus(status)
		srcIP := v.hop.SrcIP
		dstIP := v.hop.DstIP
		ua := v.req.UserAgent
		if ua == "" {
			ua = pickRandom(userAgents, ctx.Rng)
		}
		tsStr := ts.Format("2006-01-02T15:04:05.000Z07:00")

		fields := map[string]any{
			"method":           method,
			"path":             path,
			"status_code":      status,
			"response_time_ms": latency,
			"remote_addr":      srcIP,
			"trace_id":         v.req.TraceID,
			"span_id":          v.hop.SpanID,
		}

		var raw string
		if logFormat == "json" {
			obj := map[string]any{
				"level":        strings.ToLower(level),
				"timestamp":    tsStr,
				"method":       method,
				"path":         path,
				"statusCode":   status,
				"responseTime": latency,
				"remoteAddr":   srcIP,
				"userAgent":    ua[:min(len(ua), 80)],
				"framework":    framework,
				"traceId":      v.req.TraceID,
				"spanId":       v.hop.SpanID,
			}
			if dstIP != "" {
				obj["localAddr"] = dstIP
			}
			b, _ := json.Marshal(obj)
			raw = string(b)
		} else {
			raw = fmt.Sprintf(`%s %s [%s] %s %s %d %dms "%s" trace=%s`,
				tsStr, level, framework, method, path, status, latency,
				ua[:min(len(ua), 60)], v.req.TraceID)
		}

		entries = append(entries, event.LogEntry{
			ID:         makeID(target, ctx.TickIndex, i),
			TS:         tsStr,
			Source:     target.Source,
			Level:      level,
			Sourcetype: "nodejs",
			Class:      "http_activity",
			TraceID:    v.req.TraceID,
			SpanID:     v.hop.SpanID,
			Raw:        raw,
			Fields:     fields,
		})
	}
	return entries
}

func (g *NodejsGenerator) startupLog(
	target Target, cfg *scenario.GeneratorConfig,
	framework, logFormat string, ctx event.TickContext,
) event.LogEntry {
	port := cfg.Port
	if port == 0 {
		port = 3000
	}
	ts := ctx.Timestamp.Format("2006-01-02T15:04:05.000Z07:00")
	var raw string
	if logFormat == "json" {
		b, _ := json.Marshal(map[string]any{
			"level":     "info",
			"timestamp": ts,
			"message":   fmt.Sprintf("Server listening on port %d", port),
			"framework": framework,
		})
		raw = string(b)
	} else {
		raw = fmt.Sprintf("%s INFO [%s] Server listening on port %d", ts, framework, port)
	}
	return event.LogEntry{
		ID:         makeID(target, ctx.TickIndex, 0),
		TS:         ts,
		Source:     target.Source,
		Level:      "INFO",
		Sourcetype: "nodejs",
		Class:      "application_lifecycle",
		Raw:        raw,
		Fields:     map[string]any{"port": port, "framework": framework},
	}
}

// observedRequestTimeFrom returns the wall-clock time the named entity's
// hop sees for the whole request — its own service time plus the sum of
// all downstream hops it synchronously waited on. This is what an HTTP
// proxy or app server reports as request_time / responseTime; the
// generator's own LatencyMs is just the local service time and is not
// what callers expect to see in access logs.
func observedRequestTimeFrom(req *event.Request, entity string) int {
	total := 0
	found := false
	for hi := range req.Hops {
		h := &req.Hops[hi]
		if h.Entity == entity {
			found = true
		}
		if found {
			total += h.LatencyMs
		}
	}
	if total == 0 {
		// Fallback: at least the entity's own latency.
		if h := req.HopAt(entity); h != nil {
			return h.LatencyMs
		}
	}
	return total
}

// levelForStatus maps an HTTP status to a log level.
func levelForStatus(status int) string {
	switch {
	case status >= 500:
		return "ERROR"
	case status >= 400:
		return "WARN"
	default:
		return "INFO"
	}
}

// applyVolumeOverrideToVisits scales a per-generator slice per the
// timeline LogVolMul/LogVolAbs override. When LogVolAbs is set, it wins
// (lines/sec). When LogVolMul ≠ 1, it scales. The slice is duplicated
// cyclically when the target count exceeds the source — kept simple for
// Stage 1; the resulting per-line trace_ids may repeat, which is the
// smallest violation we can live with for kinematic-mode override use.
func applyVolumeOverrideToVisits[V any](visits []V, ctx event.TickContext) []V {
	ov := ctx.Override
	tickSec := float64(ctx.TickIntervalMs) / 1000.0
	target := len(visits)
	if ov.LogVolAbs != nil {
		target = int(math.Round(*ov.LogVolAbs * tickSec))
	} else if ov.LogVolMul > 0 && ov.LogVolMul != 1 {
		target = int(math.Round(float64(len(visits)) * ov.LogVolMul))
	}
	if target <= 0 {
		return nil
	}
	if target == len(visits) {
		return visits
	}
	if len(visits) == 0 {
		return nil
	}
	out := make([]V, 0, target)
	for i := 0; i < target; i++ {
		out = append(out, visits[i%len(visits)])
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
