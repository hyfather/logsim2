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
	// ConfigOverrides is the per-tick partial GeneratorConfig (YAML-keyed) to
	// merge over the service's baseline generator config. nil/empty = no-op.
	ConfigOverrides map[string]any
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
		if len(b.ConfigOverrides) > 0 {
			if o.ConfigOverrides == nil {
				o.ConfigOverrides = make(map[string]any, len(b.ConfigOverrides))
			}
			for k, v := range b.ConfigOverrides {
				o.ConfigOverrides[k] = v
			}
		}
		if b.CustomLog != "" {
			o.CustomLog = b.CustomLog
		}
		if b.Note != "" {
			o.Note = b.Note
		}
	}
	// If config_overrides supplies error_rate and the explicit override hasn't
	// already been set (by state preset or block.error_rate), promote it so
	// generators that route errors through Override.ErrorRate (nodejs, etc.)
	// reflect the per-block edit.
	if !o.HasErrorRate {
		if v, ok := o.ConfigOverrides["error_rate"]; ok {
			if f, ok := toFloat(v); ok {
				o.HasErrorRate = true
				o.ErrorRate = f
			}
		}
	}
	return o
}

// ApplyToConfig returns a copy of base with any ConfigOverrides applied.
// Unrecognized keys are ignored. Wrong-typed values are skipped silently.
func (o Override) ApplyToConfig(base GeneratorConfig) GeneratorConfig {
	if len(o.ConfigOverrides) == 0 {
		return base
	}
	out := base
	for k, v := range o.ConfigOverrides {
		switch k {
		case "port":
			if i, ok := toInt(v); ok {
				out.Port = i
			}
		case "log_format":
			if s, ok := v.(string); ok {
				out.LogFormat = s
			}
		case "log_level":
			if s, ok := v.(string); ok {
				out.LogLevel = s
			}
		case "database":
			if s, ok := v.(string); ok {
				out.Database = s
			}
		case "slow_query_threshold":
			if i, ok := toInt(v); ok {
				out.SlowQueryThreshold = i
			}
		case "max_memory":
			if s, ok := v.(string); ok {
				out.MaxMemory = s
			}
		case "eviction_policy":
			if s, ok := v.(string); ok {
				out.EvictionPolicy = s
			}
		case "error_rate":
			if f, ok := toFloat(v); ok {
				out.ErrorRate = f
			}
		case "traffic_rate":
			if f, ok := toFloat(v); ok {
				out.TrafficRate = f
			}
		case "custom_type":
			if s, ok := v.(string); ok {
				out.CustomType = s
			}
		}
	}
	return out
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case float32:
		return int(n), true
	}
	return 0, false
}
