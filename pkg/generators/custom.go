package generators

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// CustomGenerator renders user-defined log shapes from a scenario.CustomType.
//
// Output mirrors src/engine/generators/CustomLogGenerator.ts so the in-browser
// preview and the backend produce equivalent lines for the same scenario.
//
// When called with empty inbound flows the generator self-drives off
// service.Generator.TrafficRate so a lone custom node still emits — that's
// the whole point of supporting it as a top-level construct.
type CustomGenerator struct {
	customType *scenario.CustomType
}

// NewCustomGenerator returns a generator bound to one CustomType definition.
// Returns nil if ct is nil; the engine then skips the target.
func NewCustomGenerator(ct *scenario.CustomType) *CustomGenerator {
	if ct == nil || len(ct.Templates) == 0 {
		return nil
	}
	return &CustomGenerator{customType: ct}
}

func (g *CustomGenerator) Generate(target Target, inbound []event.Flow, ctx event.TickContext) []event.LogEntry {
	if g == nil || g.customType == nil || target.Service == nil {
		return nil
	}
	cfg := &target.Service.Generator

	// Inbound flows take precedence so a custom service downstream of a load
	// balancer reflects upstream traffic. Otherwise fall back to the
	// self-driven rate (the standalone-node case).
	totalReqs, totalErrs := 0, 0
	var srcIP string
	for _, f := range inbound {
		totalReqs += f.RequestCount
		totalErrs += f.ErrorCount
		if srcIP == "" {
			srcIP = f.SrcIP
		}
	}
	if totalReqs == 0 && cfg.TrafficRate > 0 {
		tickSec := float64(ctx.TickIntervalMs) / 1000.0
		totalReqs = int(math.Round(cfg.TrafficRate * tickSec))
		errRate := cfg.ErrorRate
		if errRate <= 0 {
			errRate = g.customType.DefaultErrorRate
		}
		totalErrs = int(math.Round(float64(totalReqs) * errRate))
	}

	// Apply timeline override.
	totalReqs, totalErrs = applyVolumeAndError(totalReqs, totalErrs, ctx)
	if totalReqs == 0 {
		return nil
	}

	timestamps := spreadTimestamps(ctx.Timestamp, totalReqs, ctx.TickIntervalMs, ctx.Rng)
	out := make([]event.LogEntry, 0, totalReqs)
	for i := 0; i < totalReqs; i++ {
		ts := ctx.Timestamp
		if i < len(timestamps) {
			ts = timestamps[i]
		}
		isError := i < totalErrs
		tpl := pickWeightedTemplate(g.customType.Templates, ctx.Override.TemplateWeights, ctx.Rng, isError)
		if tpl == nil {
			continue
		}
		// Placeholder overrides layer on top of the custom type's defaults.
		placeholders := g.customType.Placeholders
		if len(ctx.Override.Placeholders) > 0 {
			placeholders = mergePlaceholders(g.customType.Placeholders, ctx.Override.Placeholders)
		}
		raw := renderTemplate(tpl.Template, placeholders, ts, isError, tpl.Level, ctx.Rng)
		level := normalizeLevel(tpl.Level, isError)
		out = append(out, event.LogEntry{
			ID:         makeID(ctx.TickIndex, i),
			TS:         ts.Format(time.RFC3339Nano),
			Source:     target.Source,
			Level:      level,
			Sourcetype: "custom:" + g.customType.ID,
			Raw:        raw,
		})
	}
	return out
}

// pickWeightedTemplate picks a template by weight, preferring those whose
// IsError flag matches mustError. Falls back to the full pool if none match.
// weightOverrides (keyed by template ID) replace baseline weights when
// non-empty — that's how timeline blocks reshape the mix of log lines.
func pickWeightedTemplate(
	templates []scenario.LogTemplate,
	weightOverrides map[string]float64,
	rng interface{ Float64() float64 },
	mustError bool,
) *scenario.LogTemplate {
	if len(templates) == 0 {
		return nil
	}
	var pool []*scenario.LogTemplate
	for i := range templates {
		if templates[i].IsError == mustError {
			pool = append(pool, &templates[i])
		}
	}
	if len(pool) == 0 {
		for i := range templates {
			pool = append(pool, &templates[i])
		}
	}
	weightOf := func(t *scenario.LogTemplate) float64 {
		if w, ok := weightOverrides[t.ID]; ok {
			if w < 0 {
				return 0
			}
			return w
		}
		w := t.Weight
		if w <= 0 {
			w = 1
		}
		return w
	}
	var total float64
	for _, t := range pool {
		total += weightOf(t)
	}
	if total <= 0 {
		// All overridden to zero — fall back to uniform pick rather than
		// silently emitting nothing.
		return pool[rng.(interface{ Intn(int) int }).Intn(len(pool))]
	}
	r := rng.Float64() * total
	for _, t := range pool {
		r -= weightOf(t)
		if r <= 0 {
			return t
		}
	}
	return pool[len(pool)-1]
}

// mergePlaceholders returns a new map with base layered under override.
// Override entries replace base entries with the same key.
func mergePlaceholders(base, override map[string]scenario.Placeholder) map[string]scenario.Placeholder {
	out := make(map[string]scenario.Placeholder, len(base)+len(override))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range override {
		out[k] = v
	}
	return out
}

// renderTemplate replaces every `{{name}}` marker by filling the matching
// Placeholder definition. Unknown markers expand to `<name>` so missing
// placeholder defs surface visibly rather than silently emitting blanks.
func renderTemplate(
	template string,
	placeholders map[string]scenario.Placeholder,
	ts time.Time,
	isError bool,
	level string,
	rng interface {
		Float64() float64
		Intn(int) int
	},
) string {
	var b strings.Builder
	b.Grow(len(template))
	i := 0
	for i < len(template) {
		// Look for `{{`. Anything else copies through.
		if i+1 < len(template) && template[i] == '{' && template[i+1] == '{' {
			end := strings.Index(template[i+2:], "}}")
			if end < 0 {
				b.WriteString(template[i:])
				break
			}
			name := strings.TrimSpace(template[i+2 : i+2+end])
			if !isIdent(name) {
				// Not a valid placeholder; emit the raw `{{...}}` chunk.
				b.WriteString(template[i : i+2+end+2])
			} else {
				spec, ok := placeholders[name]
				if !ok {
					b.WriteString("<")
					b.WriteString(name)
					b.WriteString(">")
				} else {
					b.WriteString(fillPlaceholder(name, &spec, ts, isError, level, rng))
				}
			}
			i = i + 2 + end + 2
			continue
		}
		b.WriteByte(template[i])
		i++
	}
	return b.String()
}

func isIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		isLetter := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_'
		isDigit := r >= '0' && r <= '9'
		if i == 0 && !isLetter {
			return false
		}
		if !isLetter && !isDigit {
			return false
		}
	}
	return true
}

// ---- placeholder fill ------------------------------------------------------

var (
	successStatuses = []int{200, 200, 200, 200, 201, 202, 204, 301, 304}
	errorStatuses   = []int{400, 401, 403, 404, 408, 429, 500, 502, 503, 504}
	fallbackPaths   = []string{"/api/items", "/api/users", "/api/health", "/login", "/static/app.js"}
	fallbackWords   = []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "gamma", "sigma", "epsilon", "tango"}
	monthsShort     = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
)

func fillPlaceholder(
	name string,
	spec *scenario.Placeholder,
	ts time.Time,
	isError bool,
	level string,
	rng interface {
		Float64() float64
		Intn(int) int
	},
) string {
	kind := spec.Kind
	if kind == "" {
		kind = "literal"
	}

	// For text-shaped kinds an enum override is meaningful.
	if len(spec.EnumValues) > 0 {
		switch kind {
		case "enum", "free_text", "level", "method", "path", "word", "host":
			return pickRandom(spec.EnumValues, rng)
		}
	}

	switch kind {
	case "timestamp", "iso_timestamp":
		f := spec.Format
		if kind == "iso_timestamp" {
			f = "iso"
		}
		return formatTimestamp(ts, f)
	case "epoch_seconds":
		return formatTimestamp(ts, "epoch_s")
	case "epoch_millis":
		return formatTimestamp(ts, "epoch_ms")
	case "level":
		return normalizeLevel(level, isError)
	case "ip":
		return randomIP(rng)
	case "ipv6":
		return randomIPv6(rng)
	case "host":
		return fmt.Sprintf("host-%d.local", randInt(rng, 1, 99))
	case "port":
		return fmt.Sprintf("%d", randInt(rng, 1024, 65535))
	case "method":
		return pickRandom(httpMethods, rng)
	case "path":
		return pickRandom(fallbackPaths, rng)
	case "status":
		if isError {
			return fmt.Sprintf("%d", pickRandom(errorStatuses, rng))
		}
		return fmt.Sprintf("%d", pickRandom(successStatuses, rng))
	case "latency_ms", "duration_ms":
		mn := intOr(spec.Min, 1)
		mx := intOr(spec.Max, defaultLatencyMax(isError))
		return fmt.Sprintf("%d", randInt(rng, mn, mx))
	case "bytes":
		return fmt.Sprintf("%d", randInt(rng, intOr(spec.Min, 50), intOr(spec.Max, 50000)))
	case "request_id":
		return randHex(rng, intDefault(spec.Length, 16))
	case "trace_id":
		return randHex(rng, intDefault(spec.Length, 32))
	case "uuid":
		return randUUID()
	case "user_id":
		return fmt.Sprintf("%d", randInt(rng, intOr(spec.Min, 1), intOr(spec.Max, 999999)))
	case "session_id":
		return randHex(rng, intDefault(spec.Length, 24))
	case "email":
		return fmt.Sprintf("user%d@example.com", randInt(rng, 1, 99999))
	case "pid":
		return fmt.Sprintf("%d", randInt(rng, intOr(spec.Min, 100), intOr(spec.Max, 65535)))
	case "thread":
		return fmt.Sprintf("t-%d", randInt(rng, 1, 64))
	case "integer":
		return fmt.Sprintf("%d", randInt(rng, intOr(spec.Min, 0), intOr(spec.Max, 100)))
	case "float":
		mn := floatOr(spec.Min, 0)
		mx := floatOr(spec.Max, 1)
		return fmt.Sprintf("%.3f", mn+rng.Float64()*(mx-mn))
	case "hex":
		return randHex(rng, intDefault(spec.Length, 8))
	case "word":
		return pickRandom(fallbackWords, rng)
	case "user_agent":
		return pickRandom(userAgents, rng)
	case "enum", "free_text":
		if len(spec.EnumValues) > 0 {
			return pickRandom(spec.EnumValues, rng)
		}
		return "<" + name + ">"
	case "literal":
		return spec.Literal
	}
	return spec.Literal
}

func formatTimestamp(t time.Time, format string) string {
	switch strings.ToLower(format) {
	case "epoch_s", "epoch_seconds", "epoch":
		return fmt.Sprintf("%d", t.Unix())
	case "epoch_ms", "epoch_millis":
		return fmt.Sprintf("%d", t.UnixMilli())
	case "rfc3164", "syslog":
		return fmt.Sprintf("%s %2d %s", monthsShort[t.UTC().Month()-1], t.UTC().Day(), t.UTC().Format("15:04:05"))
	case "apache", "clf":
		return fmt.Sprintf("%02d/%s/%d:%s +0000", t.UTC().Day(), monthsShort[t.UTC().Month()-1], t.UTC().Year(), t.UTC().Format("15:04:05"))
	default:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
}

func normalizeLevel(level string, isError bool) string {
	if level != "" {
		return strings.ToUpper(level)
	}
	if isError {
		return "ERROR"
	}
	return "INFO"
}

// intOr returns *p as int if non-nil, else def.
func intOr(p *float64, def int) int {
	if p == nil {
		return def
	}
	return int(*p)
}

func floatOr(p *float64, def float64) float64 {
	if p == nil {
		return def
	}
	return *p
}

func intDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func defaultLatencyMax(isError bool) int {
	if isError {
		return 3000
	}
	return 500
}

func randInt(rng interface{ Intn(int) int }, mn, mx int) int {
	if mx < mn {
		mn, mx = mx, mn
	}
	if mx == mn {
		return mn
	}
	return mn + rng.Intn(mx-mn+1)
}

func randHex(rng interface{ Intn(int) int }, length int) string {
	if length <= 0 {
		length = 8
	}
	const hexChars = "0123456789abcdef"
	var b strings.Builder
	b.Grow(length)
	for i := 0; i < length; i++ {
		b.WriteByte(hexChars[rng.Intn(16)])
	}
	return b.String()
}

func randomIP(rng interface{ Intn(int) int }) string {
	return fmt.Sprintf("%d.%d.%d.%d",
		randInt(rng, 10, 240),
		randInt(rng, 0, 255),
		randInt(rng, 0, 255),
		randInt(rng, 1, 254),
	)
}

func randomIPv6(rng interface{ Intn(int) int }) string {
	parts := make([]string, 8)
	for i := range parts {
		parts[i] = randHex(rng, 4)
	}
	return strings.Join(parts, ":")
}

// randUUID uses crypto/rand because UUIDv4 is normally cryptographic; the
// deterministic-replay rng isn't load-bearing for trace ids.
func randUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}
