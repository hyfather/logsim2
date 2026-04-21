// Package config parses and validates logsim destinations.yaml.
package config

import (
	"fmt"
	"io"
	"os"

	"gopkg.in/yaml.v3"
)

// DestinationType is the kind of log destination.
type DestinationType string

const (
	DestinationTypeCribl DestinationType = "cribl_hec"
)

// Destination is a single named output target.
type Destination struct {
	Name          string          `yaml:"name"`
	Type          DestinationType `yaml:"type"`
	Enabled       bool            `yaml:"enabled"`
	URL           string          `yaml:"url"`
	Token         string          `yaml:"token"`
	BatchSize     int             `yaml:"batch_size"`
	FlushInterval int             `yaml:"flush_interval_ms"` // ms; 0 → flush each batch immediately
}

// DestinationsConfig is the top-level structure of destinations.yaml.
type DestinationsConfig struct {
	Destinations []Destination `yaml:"destinations"`
}

// Parse decodes destinations YAML from r and validates the result.
func Parse(r io.Reader) (*DestinationsConfig, error) {
	var cfg DestinationsConfig
	dec := yaml.NewDecoder(r)
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if err := validate(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// ParseFile is a convenience wrapper around Parse.
func ParseFile(path string) (*DestinationsConfig, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", path, err)
	}
	defer f.Close()
	return Parse(f)
}

// Get returns the named destination, or nil if not found.
func (c *DestinationsConfig) Get(name string) *Destination {
	for i := range c.Destinations {
		if c.Destinations[i].Name == name {
			return &c.Destinations[i]
		}
	}
	return nil
}

// validate checks all destinations for required fields.
func validate(cfg *DestinationsConfig) error {
	names := map[string]bool{}
	for i := range cfg.Destinations {
		d := &cfg.Destinations[i]
		if d.Name == "" {
			return fmt.Errorf("destinations[%d]: name is required", i)
		}
		if names[d.Name] {
			return fmt.Errorf("duplicate destination name %q", d.Name)
		}
		names[d.Name] = true

		switch d.Type {
		case DestinationTypeCribl:
			if d.URL == "" {
				return fmt.Errorf("destination %q: url is required for type %q", d.Name, d.Type)
			}
			if d.Token == "" {
				return fmt.Errorf("destination %q: token is required for type %q", d.Name, d.Type)
			}
		case "":
			return fmt.Errorf("destination %q: type is required", d.Name)
		default:
			return fmt.Errorf("destination %q: unknown type %q (supported: cribl_hec)", d.Name, d.Type)
		}

		if d.BatchSize == 0 {
			d.BatchSize = 100 // default
		}
		if d.BatchSize < 1 || d.BatchSize > 500 {
			return fmt.Errorf("destination %q: batch_size must be in [1,500], got %d", d.Name, d.BatchSize)
		}
	}
	return nil
}
