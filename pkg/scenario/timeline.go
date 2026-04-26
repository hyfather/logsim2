package scenario

// Override is the merged effect of timeline blocks active at a specific tick.
// Mirrors the frontend's ServiceOverride model. The zero value is a no-op
// (LatencyMul=1, LogVolMul=1, no error/template overrides).
type Override struct {
	HasErrorRate    bool
	ErrorRate       float64
	LatencyMul      float64 // multiplier on baseline latency, default 1
	LogVolMul       float64 // multiplier on baseline log volume, default 1
	LogVolAbs       *float64
	TemplateWeights map[string]float64 // override weights keyed by template id
	Placeholders    map[string]Placeholder
	State           string
	CustomLog       string
	Note            string
}

// identityOverride returns a zero-effect override.
func identityOverride() Override {
	return Override{LatencyMul: 1, LogVolMul: 1}
}

// stateDefaults mirrors the frontend's defaultsFor(state). Returns the
// modifier preset for a behavior state. Unknown states return the identity.
func stateDefaults(state string) Override {
	o := identityOverride()
	switch state {
	case "healthy":
		// identity
	case "degraded":
		o.HasErrorRate = true
		o.ErrorRate = 0.1
		o.LatencyMul = 2
		o.LogVolMul = 1.2
	case "down":
		o.HasErrorRate = true
		o.ErrorRate = 1
		o.LatencyMul = 5
		o.LogVolMul = 0.3
	case "recovering":
		o.HasErrorRate = true
		o.ErrorRate = 0.05
		o.LatencyMul = 1.5
		o.LogVolMul = 1.4
	case "under_attack":
		o.HasErrorRate = true
		o.ErrorRate = 0.3
		o.LatencyMul = 3
		o.LogVolMul = 4
	case "throttled":
		o.HasErrorRate = true
		o.ErrorRate = 0.15
		o.LatencyMul = 2.5
		o.LogVolMul = 0.5
	case "compromised":
		o.HasErrorRate = true
		o.ErrorRate = 0.2
		o.LatencyMul = 2
		o.LogVolMul = 2
	}
	return o
}

// ResolveOverride returns the merged Override for a service at tick t. Blocks
// are evaluated in slice order; later blocks win for overlapping ticks. Each
// block's State preset is applied first, then explicit fields layer on top.
func (s *Service) ResolveOverride(tick int) Override {
	o := identityOverride()
	for i := range s.Timeline {
		b := &s.Timeline[i]
		if tick < b.From || tick >= b.To {
			continue
		}
		if b.State != "" {
			d := stateDefaults(b.State)
			o.State = b.State
			if d.HasErrorRate {
				o.HasErrorRate = true
				o.ErrorRate = d.ErrorRate
			}
			o.LatencyMul = d.LatencyMul
			o.LogVolMul = d.LogVolMul
		}
		if b.ErrorRate != nil {
			o.HasErrorRate = true
			o.ErrorRate = *b.ErrorRate
		}
		if b.LatencyMul != nil {
			o.LatencyMul = *b.LatencyMul
		}
		if b.LogVolMul != nil {
			o.LogVolMul = *b.LogVolMul
		}
		if b.LogVolAbs != nil {
			v := *b.LogVolAbs
			o.LogVolAbs = &v
		}
		if len(b.TemplateWeights) > 0 {
			if o.TemplateWeights == nil {
				o.TemplateWeights = make(map[string]float64, len(b.TemplateWeights))
			}
			for k, v := range b.TemplateWeights {
				o.TemplateWeights[k] = v
			}
		}
		if len(b.Placeholders) > 0 {
			if o.Placeholders == nil {
				o.Placeholders = make(map[string]Placeholder, len(b.Placeholders))
			}
			for k, v := range b.Placeholders {
				o.Placeholders[k] = v
			}
		}
		if b.CustomLog != "" {
			o.CustomLog = b.CustomLog
		}
		if b.Note != "" {
			o.Note = b.Note
		}
	}
	return o
}
