package generators

import (
	"fmt"
	"math"
	"time"

	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/scenario"
)

// Generator produces log entries for a scenario entity on one tick.
type Generator interface {
	// Generate returns log entries for one tick.
	// target is either a *scenario.Node or *scenario.Service.
	// inbound contains flows whose TargetName matches this entity.
	Generate(target Target, inbound []event.Flow, ctx event.TickContext) []event.LogEntry
}

// Target carries everything a generator needs about the entity it represents.
type Target struct {
	Node    *scenario.Node    // set if this is a node-level generator
	Service *scenario.Service // set if this is a service-level generator
	Source  string
}

func (t Target) Name() string {
	if t.Service != nil {
		return t.Service.Name
	}
	if t.Node != nil {
		return t.Node.Name
	}
	return ""
}

// ---- shared helpers --------------------------------------------------------

var userAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0 Safari/537.36",
	"curl/8.1.2",
	"python-requests/2.31.0",
}

var commonPaths = []string{
	"/api/users", "/api/items", "/api/orders", "/api/sessions",
	"/health", "/metrics", "/api/v2/users", "/api/v2/products",
}

var httpMethods = []string{"GET", "GET", "GET", "POST", "PUT", "DELETE", "PATCH"}

func pickRandom[T any](slice []T, rng interface{ Intn(int) int }) T {
	return slice[rng.Intn(len(slice))]
}

// sampleLatency draws from an exponential-ish distribution centered on mean.
func sampleLatency(meanMs int, rng interface{ Float64() float64 }) int {
	if meanMs <= 0 {
		meanMs = 50
	}
	// Use a log-normal approximation: median ≈ mean, tail to ~3×.
	v := math.Exp(rng.Float64()*0.8-0.4) * float64(meanMs)
	if v < 1 {
		v = 1
	}
	return int(math.Round(v))
}

// makeID returns a short tick-scoped event ID.
var idCounter uint64

func makeID(tickIndex, idx int) string {
	return fmt.Sprintf("t%d-%d", tickIndex, idx)
}

// spreadTimestamps distributes n events across tickIntervalMs milliseconds.
func spreadTimestamps(base time.Time, n, tickIntervalMs int, rng interface{ Intn(int) int }) []time.Time {
	if n <= 0 {
		return nil
	}
	ts := make([]time.Time, n)
	for i := range ts {
		offsetMs := rng.Intn(tickIntervalMs)
		ts[i] = base.Add(time.Duration(offsetMs) * time.Millisecond)
	}
	return ts
}
