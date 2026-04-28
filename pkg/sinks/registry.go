package sinks

import (
	"fmt"

	"github.com/nikhilm/logsim2/pkg/config"
)

// ForDestination constructs a Sink from a parsed Destination config. The
// destination's Format (native/ocsf/...) is honored when the underlying sink
// supports schema mapping; native is always safe.
func ForDestination(d *config.Destination) (Sink, error) {
	switch d.Type {
	case config.DestinationTypeCribl:
		return NewCriblWithFormat(d.URL, d.Token, d.BatchSize, d.FlushInterval, Format(d.Format)), nil
	default:
		return nil, fmt.Errorf("unknown destination type %q", d.Type)
	}
}
