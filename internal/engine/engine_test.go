package engine

import (
	"context"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/scenario"
	"github.com/nikhilm/logsim2/internal/sinks"
)

const webServiceYAML = `
- name: Web Service
- nodes:
  - type: vpc
    name: Web Service VPC
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: Web Service Subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server 1
    subnet: Web Service Subnet
    private_ip: 10.0.1.10
  - type: virtual_server
    name: Database Server
    subnet: Web Service Subnet
    private_ip: 10.0.1.12
  - type: load_balancer
    name: Load Balancer
    subnet: Web Service Subnet
    private_ip: 10.0.1.13
  - type: user_clients
    name: User Clients
    clients:
      - name: Web Client 1
        ip: 45.45.45.1
        rps: 10
        traffic_pattern: steady
- services:
  - type: nodejs
    name: User Directory Service
    host: App Server 1
    generator:
      type: nodejs
      port: 3000
      log_format: json
      endpoints:
        - method: GET
          path: /api/users
          avg_latency_ms: 100
          error_rate: 0.01
- connections:
  - source: User Clients
    target: Load Balancer
    protocol: https
    port: 443
  - source: Load Balancer
    target: User Directory Service
    protocol: http
    port: 3000
`

func parseScenario(t *testing.T, yaml string) *scenario.Scenario {
	t.Helper()
	s, err := scenario.Parse(strings.NewReader(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := scenario.Validate(s); err != nil {
		t.Fatalf("validate: %v", err)
	}
	return s
}

func TestEngine_Flows(t *testing.T) {
	s := parseScenario(t, webServiceYAML)
	ts := newTrafficSimulator(s)
	rng := rand.New(rand.NewSource(42))

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	flows := ts.Flows(s, 0, 1000, rng, start)

	if len(flows) == 0 {
		t.Fatal("expected flows, got none")
	}

	// Find flow targeting User Directory Service
	var udsFlow *event.Flow
	for i := range flows {
		if flows[i].TargetName == "User Directory Service" {
			udsFlow = &flows[i]
			break
		}
	}
	if udsFlow == nil {
		t.Fatalf("no flow targeting 'User Directory Service'; flows: %+v", flows)
	}
	if udsFlow.RequestCount == 0 {
		t.Errorf("UDS flow has RequestCount=0")
	}
	t.Logf("UDS flow: %+v", udsFlow)
}

func TestEngine_ProducesNodejsLogs(t *testing.T) {
	s := parseScenario(t, webServiceYAML)

	var buf strings.Builder
	sink := sinks.NewWriter(&buf, sinks.FormatJSONL)

	cfg := Config{
		Seed:           42,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:  "*",
	}

	eng := New(s, cfg)
	if err := eng.Run(context.Background(), 5, []sinks.Sink{sink}); err != nil {
		t.Fatalf("run: %v", err)
	}

	output := strings.TrimSpace(buf.String())
	if output == "" {
		t.Fatal("no log output produced")
	}

	lines := strings.Split(output, "\n")
	t.Logf("produced %d log lines over 5 ticks", len(lines))

	if len(lines) <= 1 {
		t.Errorf("expected >1 log lines, got %d:\n%s", len(lines), output)
	}

	udsLines := 0
	for _, l := range lines {
		if strings.Contains(l, "user-directory-service") && strings.Contains(l, `"sourcetype":"nodejs"`) {
			udsLines++
		}
	}
	if udsLines == 0 {
		t.Errorf("expected nodejs lines from user-directory-service, got none")
	}
	t.Logf("UDS nodejs lines: %d / %d total", udsLines, len(lines))
}

func TestEngine_ReferenceScenario(t *testing.T) {
	// Test against the actual scenarios/web-service.yaml on disk.
	s, err := scenario.ValidateFile("../../scenarios/web-service.yaml")
	if err != nil {
		t.Fatalf("validate: %v", err)
	}

	var buf strings.Builder
	sink := sinks.NewWriter(&buf, sinks.FormatJSONL)

	cfg := Config{
		Seed:           42,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:  "*",
	}

	eng := New(s, cfg)
	if err := eng.Run(context.Background(), 3, []sinks.Sink{sink}); err != nil {
		t.Fatalf("run: %v", err)
	}

	output := strings.TrimSpace(buf.String())
	lines := strings.Split(output, "\n")
	t.Logf("reference scenario: %d lines over 3 ticks", len(lines))
	for _, l := range lines[:min(5, len(lines))] {
		t.Log(l)
	}

	if len(lines) <= 1 {
		t.Errorf("expected >1 log lines from reference scenario, got %d", len(lines))
	}
}

func TestEngine_Deterministic(t *testing.T) {
	s := parseScenario(t, webServiceYAML)
	cfg := Config{
		Seed:           999,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:  "*",
	}

	run := func() string {
		var buf strings.Builder
		eng := New(s, cfg)
		if err := eng.Run(context.Background(), 10, []sinks.Sink{sinks.NewWriter(&buf, sinks.FormatJSONL)}); err != nil {
			t.Fatalf("run: %v", err)
		}
		return buf.String()
	}

	a, b := run(), run()
	if a != b {
		t.Error("runs with same seed produced different output")
	}
	if a == "" {
		t.Error("no output produced")
	}
}

func TestEngine_SourceFilter(t *testing.T) {
	s := parseScenario(t, webServiceYAML)
	cfg := Config{
		Seed:           1,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:  "web-service.web-service-vpc.*",
	}

	var buf strings.Builder
	eng := New(s, cfg)
	if err := eng.Run(context.Background(), 3, []sinks.Sink{sinks.NewWriter(&buf, sinks.FormatJSONL)}); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(buf.String()) == "" {
		t.Error("channel filter 'web-service.web-service-vpc.*' should pass UDS logs")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
