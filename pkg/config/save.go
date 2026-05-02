package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Save writes the config to path, creating parent directories if needed.
// The file is written with 0600 permissions because it contains HEC tokens.
// Writes are atomic: data goes to a temp file first and is then renamed.
func (c *DestinationsConfig) Save(path string) error {
	if err := validate(c); err != nil {
		return fmt.Errorf("validate before save: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	body, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), ".destinations.*.yaml.tmp")
	if err != nil {
		return fmt.Errorf("temp file: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// Upsert inserts or replaces a destination by name. Returns true if a
// destination with the same name was replaced.
func (c *DestinationsConfig) Upsert(d Destination) bool {
	for i := range c.Destinations {
		if c.Destinations[i].Name == d.Name {
			c.Destinations[i] = d
			return true
		}
	}
	c.Destinations = append(c.Destinations, d)
	return false
}

// Remove deletes a destination by name. Returns true if a destination was
// removed.
func (c *DestinationsConfig) Remove(name string) bool {
	for i := range c.Destinations {
		if c.Destinations[i].Name == name {
			c.Destinations = append(c.Destinations[:i], c.Destinations[i+1:]...)
			return true
		}
	}
	return false
}

// SetEnabled flips a destination's enabled flag. Returns false if no such
// destination exists.
func (c *DestinationsConfig) SetEnabled(name string, enabled bool) bool {
	for i := range c.Destinations {
		if c.Destinations[i].Name == name {
			c.Destinations[i].Enabled = enabled
			return true
		}
	}
	return false
}

// EnabledDestinations returns all destinations with Enabled=true.
func (c *DestinationsConfig) EnabledDestinations() []Destination {
	var out []Destination
	for i := range c.Destinations {
		if c.Destinations[i].Enabled {
			out = append(out, c.Destinations[i])
		}
	}
	return out
}
