package engine

import (
	"math"
	"strings"
)

// pattern is a named traffic shaping function.
type pattern int

const (
	patternSteady   pattern = iota
	patternBursty
	patternDiurnal
	patternIncident
)

// matchPattern maps a free-form traffic_pattern string to a known pattern.
func matchPattern(s string) pattern {
	s = strings.ToLower(s)
	switch {
	case strings.Contains(s, "bursty") || strings.Contains(s, "burst"):
		return patternBursty
	case strings.Contains(s, "diurnal"):
		return patternDiurnal
	case strings.Contains(s, "incident"):
		return patternIncident
	default:
		return patternSteady
	}
}

// multiplier returns the traffic scaling factor (≥0) for the given tick.
// rng is used for jitter.
func multiplier(p pattern, tickIndex int, rng interface{ Float64() float64 }) float64 {
	switch p {
	case patternBursty:
		// Spike every ~30 ticks; 5× peak, 0.2× trough.
		phase := float64(tickIndex%30) / 30.0
		base := 0.2 + 0.8*(1+math.Sin(2*math.Pi*phase))/2
		jitter := 1 + (rng.Float64()-0.5)*0.3
		return base * jitter

	case patternDiurnal:
		// One full day per 86400 ticks; peak at noon (tick 43200), trough at 3am.
		hour := float64(tickIndex%86400) / 3600.0
		// Shifted cosine: 0 at 3am (hour 3), peak at 3pm (hour 15).
		v := (1 - math.Cos(2*math.Pi*(hour-3)/24)) / 2
		v = 0.05 + 0.95*v
		jitter := 1 + (rng.Float64()-0.5)*0.1
		return v * jitter

	case patternIncident:
		// normal(0–99) → spike(100–149) → degraded(150–299) → recovery(300–399)
		phase := tickIndex % 400
		var v float64
		switch {
		case phase < 100:
			v = 1.0
		case phase < 150:
			v = 1.0 + float64(phase-100)/50.0*4.0 // ramp up to 5×
		case phase < 300:
			v = 5.0
		default:
			v = 5.0 - float64(phase-300)/100.0*4.0 // ramp back down
		}
		jitter := 1 + (rng.Float64()-0.5)*0.2
		return v * jitter

	default: // steady
		jitter := 1 + (rng.Float64()-0.5)*0.1
		return jitter
	}
}
