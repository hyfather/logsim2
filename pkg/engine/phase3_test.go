package engine

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/nikhilm/logsim2/pkg/sinks"
)

const fullScenarioYAML = `
- name: Full Stack
- nodes:
  - type: vpc
    name: Main VPC
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: App Subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server
    subnet: App Subnet
    private_ip: 10.0.1.10
  - type: virtual_server
    name: DB Server
    subnet: App Subnet
    private_ip: 10.0.1.20
  - type: load_balancer
    name: LB
    subnet: App Subnet
    private_ip: 10.0.1.2
  - type: user_clients
    name: Clients
    clients:
      - name: Client 1
        ip: 203.0.113.5
        rps: 10
        traffic_pattern: steady
- services:
  - type: nodejs
    name: App Service
    host: App Server
    generator:
      type: nodejs
      port: 3000
      log_format: json
      endpoints:
        - {method: GET,  path: /api/users, avg_latency_ms: 80,  error_rate: 0.02}
        - {method: POST, path: /api/users, avg_latency_ms: 300, error_rate: 0.05}
  - type: mysql
    name: App DB
    host: DB Server
    generator:
      type: mysql
      port: 3306
      database: appdb
      slow_query_threshold: 500
- connections:
  - {source: Clients,     target: LB,          protocol: https, port: 443}
  - {source: LB,          target: App Service, protocol: http,  port: 3000}
  - {source: App Service, target: App DB,      protocol: mysql, port: 3306}
`

func runFullScenario(t *testing.T, ticks int, seed int64) []string {
	t.Helper()
	s, err := scenario.Parse(strings.NewReader(fullScenarioYAML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := scenario.Validate(s); err != nil {
		t.Fatalf("validate: %v", err)
	}

	var buf strings.Builder
	cfg := Config{
		Seed:           seed,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:  "*",
	}
	eng := New(s, cfg)
	if err := eng.Run(context.Background(), ticks, []sinks.Sink{sinks.NewWriter(&buf, sinks.FormatJSONL)}); err != nil {
		t.Fatalf("run: %v", err)
	}
	output := strings.TrimSpace(buf.String())
	if output == "" {
		return nil
	}
	return strings.Split(output, "\n")
}

func TestPhase3_AllSourcesPresent(t *testing.T) {
	lines := runFullScenario(t, 5, 42)
	if len(lines) == 0 {
		t.Fatal("no log lines produced")
	}
	t.Logf("total lines: %d", len(lines))

	sources := map[string]int{}
	for _, l := range lines {
		for _, src := range []string{"nodejs", "mysql", "nginx", "vpc-flow"} {
			if strings.Contains(l, `"sourcetype":"`+src+`"`) {
				sources[src]++
			}
		}
	}
	t.Logf("sources: %v", sources)

	for _, expected := range []string{"nodejs", "mysql", "nginx", "vpc-flow"} {
		if sources[expected] == 0 {
			t.Errorf("expected logs from source %q, got none", expected)
		}
	}
}

func TestPhase3_LoadBalancerNginxFormat(t *testing.T) {
	lines := runFullScenario(t, 3, 1)
	found := false
	for _, l := range lines {
		if strings.Contains(l, `"sourcetype":"nginx"`) {
			// Raw field should look like an nginx access log.
			if strings.Contains(l, "HTTP/1.1") {
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("no nginx access log lines with HTTP/1.1 found")
	}
}

func TestPhase3_MysqlQueryLogs(t *testing.T) {
	lines := runFullScenario(t, 5, 7)
	queryCount := 0
	for _, l := range lines {
		if strings.Contains(l, `"sourcetype":"mysql"`) {
			queryCount++
		}
	}
	if queryCount == 0 {
		t.Error("no mysql log lines found")
	}
	t.Logf("mysql lines: %d", queryCount)
}

func TestPhase3_VpcFlowLogs(t *testing.T) {
	lines := runFullScenario(t, 3, 5)
	flowCount := 0
	for _, l := range lines {
		if strings.Contains(l, `"sourcetype":"vpc-flow"`) {
			flowCount++
			// VPC flow log raw should start with "2 " (version 2)
			if !strings.Contains(l, `"raw":"2 `) {
				t.Errorf("vpc-flow raw doesn't start with version 2: %s", l[:minTest(200, len(l))])
			}
		}
	}
	if flowCount == 0 {
		t.Error("no vpc-flow log lines found")
	}
	t.Logf("vpc-flow lines: %d", flowCount)
}

func TestPhase3_FileSink(t *testing.T) {
	path := t.TempDir() + "/out.jsonl"
	s, _ := scenario.Parse(strings.NewReader(fullScenarioYAML))
	_ = scenario.Validate(s)

	sink, err := sinks.NewFile(path, sinks.FormatJSONL, false)
	if err != nil {
		t.Fatalf("NewFile: %v", err)
	}

	cfg := Config{
		Seed:           42,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
	}
	eng := New(s, cfg)
	if err := eng.Run(context.Background(), 3, []sinks.Sink{sink}); err != nil {
		t.Fatalf("run: %v", err)
	}
	if err := sink.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) < 5 {
		t.Errorf("expected ≥5 lines in file, got %d", len(lines))
	}
	t.Logf("file lines: %d", len(lines))
}

func TestPhase3_FileSink_Append(t *testing.T) {
	path := t.TempDir() + "/append.jsonl"
	s, _ := scenario.Parse(strings.NewReader(fullScenarioYAML))
	_ = scenario.Validate(s)

	cfg := Config{
		Seed:           1,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
	}

	runOnce := func(app bool) int {
		sink, _ := sinks.NewFile(path, sinks.FormatJSONL, app)
		eng := New(s, cfg)
		_ = eng.Run(context.Background(), 2, []sinks.Sink{sink})
		_ = sink.Close()
		data, _ := os.ReadFile(path)
		return len(strings.Split(strings.TrimSpace(string(data)), "\n"))
	}

	first := runOnce(false) // truncate
	second := runOnce(true) // append
	if second <= first {
		t.Errorf("append mode: second run (%d lines) should be > first (%d lines)", second, first)
	}
}

func TestPhase3_SourceFilter_VpcOnly(t *testing.T) {
	s, _ := scenario.Parse(strings.NewReader(fullScenarioYAML))
	_ = scenario.Validate(s)

	var buf strings.Builder
	cfg := Config{
		Seed:           3,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
		SourceFilter:  "full-stack.main-vpc.flow",
	}
	eng := New(s, cfg)
	_ = eng.Run(context.Background(), 3, []sinks.Sink{sinks.NewWriter(&buf, sinks.FormatJSONL)})

	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if l == "" {
			continue
		}
		if !strings.Contains(l, "vpc-flow") {
			t.Errorf("channel filter leaked non-vpc-flow line: %s", l[:minTest(100, len(l))])
		}
	}
}

func TestPhase3_ReferenceScenarioAllSources(t *testing.T) {
	s, err := scenario.ValidateFile("../../scenarios/web-service.yaml")
	if err != nil {
		t.Fatalf("validate: %v", err)
	}

	var buf strings.Builder
	cfg := Config{
		Seed:           42,
		StartTime:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TickIntervalMs: 1000,
	}
	eng := New(s, cfg)
	if err := eng.Run(context.Background(), 5, []sinks.Sink{sinks.NewWriter(&buf, sinks.FormatJSONL)}); err != nil {
		t.Fatalf("run: %v", err)
	}

	output := buf.String()
	sources := map[string]bool{}
	for _, src := range []string{"nodejs", "mysql", "nginx", "vpc-flow"} {
		sources[src] = strings.Contains(output, `"sourcetype":"`+src+`"`)
	}
	t.Logf("reference scenario sources: %v", sources)

	for src, present := range sources {
		if !present {
			t.Errorf("reference scenario missing source %q", src)
		}
	}
}

// ---- helpers ---------------------------------------------------------------

func minTest(a, b int) int {
	if a < b {
		return a
	}
	return b
}
