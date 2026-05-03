package generators

import (
	"fmt"

	"github.com/nikhilm/logsim2/pkg/event"
)

// LoadBalancerGenerator emits Nginx-combined-format access logs as
// projections of Requests passing through the load balancer. Stage 1 of
// PHYSICS_PLAN.md: the LB's view of a request agrees with the backend's
// view (same method/path/status/trace_id) because both project from the
// same Request rather than rolling dice independently.
//
// Log format:
//
//	<client_ip> - - [<time>] "<method> <path> HTTP/1.1" <status> <bytes> "-" "<ua>"
type LoadBalancerGenerator struct{}

func (g *LoadBalancerGenerator) Generate(target Target, _ []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Node == nil {
		return nil
	}
	type visit struct {
		req *event.Request
		hop *event.Hop
	}
	visits := make([]visit, 0, len(ctx.Requests))
	for ri := range ctx.Requests {
		r := &ctx.Requests[ri]
		if h := r.HopAt(target.Node.Name); h != nil {
			visits = append(visits, visit{req: r, hop: h})
		}
	}
	visits = applyVolumeOverrideToVisits(visits, ctx)
	if len(visits) == 0 {
		return nil
	}

	entries := make([]event.LogEntry, 0, len(visits))
	for i, v := range visits {
		ts := v.hop.EnteredAt
		nginxTime := ts.UTC().Format("02/Jan/2006:15:04:05 -0700")
		tsStr := ts.Format("2006-01-02T15:04:05.000Z07:00")

		method := v.req.Method
		path := v.req.Path
		status := v.hop.Status
		ua := v.req.UserAgent
		if ua == "" {
			ua = pickRandom(userAgents, ctx.Rng)
		}
		clientIP := v.hop.SrcIP
		bodyBytes := v.hop.BytesOut
		// nginx rt = wall-clock time the LB observed for this request:
		// own service time plus everything downstream the LB waited on.
		// That's how real nginx access logs report request_time.
		latency := applyLatency(observedRequestTimeFrom(v.req, target.Node.Name), ctx)
		level := levelForStatus(status)

		raw := fmt.Sprintf(`%s - - [%s] "%s %s HTTP/1.1" %d %d "-" "%s" rt=%.3f trace=%s`,
			clientIP, nginxTime, method, path, status, bodyBytes,
			ua[:min(len(ua), 80)], float64(latency)/1000.0, v.req.TraceID)

		entries = append(entries, event.LogEntry{
			ID:         makeID(target, ctx.TickIndex, i),
			TS:         tsStr,
			Source:     target.Source,
			Level:      level,
			Sourcetype: "nginx",
			Class:      "http_activity",
			TraceID:    v.req.TraceID,
			SpanID:     v.hop.SpanID,
			Raw:        raw,
			Fields: map[string]any{
				"client_ip":   clientIP,
				"method":      method,
				"path":        path,
				"status_code": status,
				"body_bytes":  bodyBytes,
				"rt_ms":       latency,
				"trace_id":    v.req.TraceID,
				"span_id":     v.hop.SpanID,
			},
		})
	}
	return entries
}
