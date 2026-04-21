package config

import (
	"strings"
	"testing"
)

const validYAML = `
destinations:
  - name: prod-cribl
    type: cribl_hec
    enabled: true
    url: https://cribl.example.com/services/collector/event
    token: secret-token
    batch_size: 100
    flush_interval_ms: 2000
  - name: staging-cribl
    type: cribl_hec
    enabled: false
    url: https://staging.example.com/services/collector/event
    token: staging-secret
    batch_size: 50
`

func TestDestinations_ParseValid(t *testing.T) {
	cfg, err := Parse(strings.NewReader(validYAML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(cfg.Destinations) != 2 {
		t.Fatalf("expected 2 destinations, got %d", len(cfg.Destinations))
	}

	d := cfg.Get("prod-cribl")
	if d == nil {
		t.Fatal("prod-cribl not found")
	}
	if d.BatchSize != 100 {
		t.Errorf("batch_size: got %d, want 100", d.BatchSize)
	}
	if !d.Enabled {
		t.Error("prod-cribl should be enabled")
	}

	s := cfg.Get("staging-cribl")
	if s == nil {
		t.Fatal("staging-cribl not found")
	}
	if s.Enabled {
		t.Error("staging-cribl should be disabled")
	}
}

func TestDestinations_GetMissing(t *testing.T) {
	cfg, _ := Parse(strings.NewReader(validYAML))
	if cfg.Get("does-not-exist") != nil {
		t.Error("expected nil for unknown destination")
	}
}

func TestDestinations_DefaultBatchSize(t *testing.T) {
	yaml := `
destinations:
  - name: d1
    type: cribl_hec
    enabled: true
    url: https://example.com
    token: tok
`
	cfg, err := Parse(strings.NewReader(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Destinations[0].BatchSize != 100 {
		t.Errorf("default batch_size should be 100, got %d", cfg.Destinations[0].BatchSize)
	}
}

func TestDestinations_RejectMissingName(t *testing.T) {
	yaml := `
destinations:
  - type: cribl_hec
    url: https://example.com
    token: tok
`
	_, err := Parse(strings.NewReader(yaml))
	if err == nil {
		t.Error("expected error for missing name")
	}
}

func TestDestinations_RejectMissingURL(t *testing.T) {
	yaml := `
destinations:
  - name: d1
    type: cribl_hec
    token: tok
`
	_, err := Parse(strings.NewReader(yaml))
	if err == nil {
		t.Error("expected error for missing url")
	}
}

func TestDestinations_RejectMissingToken(t *testing.T) {
	yaml := `
destinations:
  - name: d1
    type: cribl_hec
    url: https://example.com
`
	_, err := Parse(strings.NewReader(yaml))
	if err == nil {
		t.Error("expected error for missing token")
	}
}

func TestDestinations_RejectUnknownType(t *testing.T) {
	yaml := `
destinations:
  - name: d1
    type: kafka
    url: https://example.com
    token: tok
`
	_, err := Parse(strings.NewReader(yaml))
	if err == nil {
		t.Error("expected error for unknown type")
	}
}

func TestDestinations_RejectBatchSizeOutOfRange(t *testing.T) {
	yaml := `
destinations:
  - name: d1
    type: cribl_hec
    url: https://example.com
    token: tok
    batch_size: 600
`
	_, err := Parse(strings.NewReader(yaml))
	if err == nil {
		t.Error("expected error for batch_size > 500")
	}
}

func TestDestinations_RejectDuplicateName(t *testing.T) {
	yaml := `
destinations:
  - name: same
    type: cribl_hec
    url: https://example.com
    token: tok
  - name: same
    type: cribl_hec
    url: https://example.com
    token: tok
`
	_, err := Parse(strings.NewReader(yaml))
	if err == nil {
		t.Error("expected error for duplicate destination name")
	}
}

func TestDestinations_ParseExampleFile(t *testing.T) {
	cfg, err := ParseFile("../../destinations.yaml.example")
	if err != nil {
		t.Fatalf("parse example: %v", err)
	}
	if len(cfg.Destinations) == 0 {
		t.Error("example file should have at least one destination")
	}
}
