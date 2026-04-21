package generators

import (
	"fmt"

	"github.com/nikhilm/logsim2/internal/event"
)

// LoadBalancerGenerator emits Nginx-combined-format access logs for each
// inbound request the load balancer receives.
//
// Log format:
//
//	<client_ip> - - [<time>] "<method> <path> HTTP/1.1" <status> <bytes> "-" "<ua>"
var httpStatusWeights = []int{200, 200, 200, 200, 201, 204, 301, 304, 400, 403, 404, 429, 500, 502, 503}

type LoadBalancerGenerator struct{}

func (g *LoadBalancerGenerator) Generate(target Target, inbound []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Node == nil {
		return nil
	}

	totalReqs := 0
	totalErrs := 0
	var clientIP string
	for _, f := range inbound {
		totalReqs += f.RequestCount
		totalErrs += f.ErrorCount
		if clientIP == "" {
			clientIP = f.SrcIP
		}
	}
	if totalReqs == 0 {
		return nil
	}

	timestamps := spreadTimestamps(ctx.Timestamp, totalReqs, ctx.TickIntervalMs, ctx.Rng)
	entries := make([]event.LogEntry, 0, totalReqs)

	for i := 0; i < totalReqs; i++ {
		ts := ctx.Timestamp
		if i < len(timestamps) {
			ts = timestamps[i]
		}
		// Nginx time format: 15/Jan/2024:10:30:00 +0000
		nginxTime := ts.UTC().Format("02/Jan/2006:15:04:05 -0700")
		tsStr := ts.Format("2006-01-02T15:04:05.000Z07:00")

		method := pickRandom(httpMethods, ctx.Rng)
		path := pickRandom(commonPaths, ctx.Rng)
		ua := pickRandom(userAgents, ctx.Rng)

		isError := i < totalErrs || ctx.Rng.Float64() < 0.01
		var status int
		if isError {
			status = pickRandom([]int{400, 403, 404, 500, 502, 503}, ctx.Rng)
		} else {
			status = pickRandom([]int{200, 200, 200, 201, 204, 301, 304}, ctx.Rng)
		}

		latency := sampleLatency(20, ctx.Rng) // LB overhead is low
		bodyBytes := 200 + ctx.Rng.Intn(8000)

		level := "INFO"
		if status >= 500 {
			level = "ERROR"
		} else if status >= 400 {
			level = "WARN"
		}

		raw := fmt.Sprintf(`%s - - [%s] "%s %s HTTP/1.1" %d %d "-" "%s" rt=%.3f`,
			clientIP, nginxTime, method, path, status, bodyBytes,
			ua[:min(len(ua), 80)], float64(latency)/1000.0)

		entries = append(entries, event.LogEntry{
			ID:      makeID(ctx.TickIndex, i),
			TS:      tsStr,
			Source:     target.Source,
			Level:      level,
			Sourcetype: "nginx",
			Raw:     raw,
			Fields: map[string]any{
				"client_ip":   clientIP,
				"method":      method,
				"path":        path,
				"status_code": status,
				"body_bytes":  bodyBytes,
				"rt_ms":       latency,
			},
		})
	}

	return entries
}
