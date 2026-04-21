package generators

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

var nodejsSuccessCodes = []int{200, 200, 200, 200, 201, 202, 204, 301, 304}
var nodejsErrorCodes = []int{400, 401, 403, 404, 408, 429, 500, 502, 503, 504}

// NodejsGenerator produces Node.js / Express-style access logs.
type NodejsGenerator struct{}

func (g *NodejsGenerator) Generate(target Target, inbound []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Service == nil {
		return nil
	}
	cfg := &target.Service.Generator
	framework := "express"
	logFormat := cfg.LogFormat
	if logFormat == "" {
		logFormat = "json"
	}

	// Collect endpoints from config; fall back to common paths.
	endpoints := cfg.Endpoints
	if len(endpoints) == 0 {
		for _, p := range commonPaths {
			endpoints = append(endpoints, scenario.Endpoint{
				Method:       pickRandom(httpMethods, ctx.Rng),
				Path:         p,
				AvgLatencyMs: 50,
				ErrorRate:    0.02,
			})
		}
	}

	// Count total inbound requests.
	totalReqs := 0
	totalErrs := 0
	var srcIP string
	for _, f := range inbound {
		totalReqs += f.RequestCount
		totalErrs += f.ErrorCount
		if srcIP == "" {
			srcIP = f.SrcIP
		}
	}

	if totalReqs == 0 {
		// Emit a startup heartbeat on tick 0.
		if ctx.TickIndex == 0 {
			return []event.LogEntry{g.startupLog(target, cfg, framework, logFormat, ctx)}
		}
		return nil
	}

	dstIP := ""
	if len(inbound) > 0 {
		dstIP = inbound[0].DstIP
	}

	timestamps := spreadTimestamps(ctx.Timestamp, totalReqs, ctx.TickIntervalMs, ctx.Rng)
	entries := make([]event.LogEntry, 0, totalReqs)

	for i := 0; i < totalReqs; i++ {
		ep := pickRandom(endpoints, ctx.Rng)
		ts := ctx.Timestamp
		if i < len(timestamps) {
			ts = timestamps[i]
		}
		isError := i < totalErrs || ctx.Rng.Float64() < ep.ErrorRate

		var status int
		var level string
		if isError {
			status = pickRandom(nodejsErrorCodes, ctx.Rng)
		} else {
			status = pickRandom(nodejsSuccessCodes, ctx.Rng)
		}
		latency := sampleLatency(ep.AvgLatencyMs, ctx.Rng)
		switch {
		case status >= 500:
			level = "ERROR"
		case status >= 400:
			level = "WARN"
		default:
			level = "INFO"
		}

		ua := pickRandom(userAgents, ctx.Rng)
		tsStr := ts.Format("2006-01-02T15:04:05.000Z07:00")

		var raw string
		fields := map[string]any{
			"method":          ep.Method,
			"path":            ep.Path,
			"status_code":     status,
			"response_time_ms": latency,
			"remote_addr":     srcIP,
		}

		if logFormat == "json" {
			obj := map[string]any{
				"level":        strings.ToLower(level),
				"timestamp":    tsStr,
				"method":       ep.Method,
				"path":         ep.Path,
				"statusCode":   status,
				"responseTime": latency,
				"remoteAddr":   srcIP,
				"userAgent":    ua[:min(len(ua), 80)],
				"framework":    framework,
			}
			if dstIP != "" {
				obj["localAddr"] = dstIP
			}
			b, _ := json.Marshal(obj)
			raw = string(b)
		} else {
			raw = fmt.Sprintf(`%s %s [%s] %s %s %d %dms "%s"`,
				tsStr, level, framework, ep.Method, ep.Path, status, latency, ua[:min(len(ua), 60)])
		}

		entries = append(entries, event.LogEntry{
			ID:      makeID(ctx.TickIndex, i),
			TS:      tsStr,
			Source:     target.Source,
			Level:      level,
			Sourcetype: "nodejs",
			Raw:     raw,
			Fields:  fields,
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
		ID:      makeID(ctx.TickIndex, 0),
		TS:      ts,
		Source:     target.Source,
		Level:      "INFO",
		Sourcetype: "nodejs",
		Raw:     raw,
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
