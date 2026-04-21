package sinks

import (
	"fmt"

	"github.com/nikhilm/logsim2/internal/config"
)

// ForDestination constructs a Sink from a parsed Destination config.
func ForDestination(d *config.Destination) (Sink, error) {
	switch d.Type {
	case config.DestinationTypeCribl:
		return NewCribl(d.URL, d.Token, d.BatchSize, d.FlushInterval), nil
	default:
		return nil, fmt.Errorf("unknown destination type %q", d.Type)
	}
}
