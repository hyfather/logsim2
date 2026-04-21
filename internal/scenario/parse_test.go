package scenario

import (
	"strings"
	"testing"
)

const referenceYAML = `
- name: Test Scenario
- description: A test scenario
- nodes:
  - type: vpc
    name: My VPC
    cidr_block: 10.0.0.0/16
  - type: subnet
    name: My Subnet
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: App Server
    subnet: My Subnet
    private_ip: 10.0.1.10
  - type: user_clients
    name: Clients
    clients:
      - name: Web Client
        ip: 1.2.3.4
        rps: 5
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
        - method: GET
          path: /api/test
          avg_latency_ms: 50
          error_rate: 0.01
- connections:
  - source: Clients
    target: App Service
    protocol: http
    port: 3000
`

func TestParse_ReferenceFormat(t *testing.T) {
	s, err := Parse(strings.NewReader(referenceYAML))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Name != "Test Scenario" {
		t.Errorf("name = %q, want %q", s.Name, "Test Scenario")
	}
	if len(s.Nodes) != 4 {
		t.Errorf("nodes = %d, want 4", len(s.Nodes))
	}
	if len(s.Services) != 1 {
		t.Errorf("services = %d, want 1", len(s.Services))
	}
	if len(s.Connections) != 1 {
		t.Errorf("connections = %d, want 1", len(s.Connections))
	}
	svc := s.Services[0]
	if svc.Host != "App Server" {
		t.Errorf("service host = %q, want %q", svc.Host, "App Server")
	}
	if svc.Generator.Port != 3000 {
		t.Errorf("generator port = %d, want 3000", svc.Generator.Port)
	}
	if len(svc.Generator.Endpoints) != 1 {
		t.Errorf("endpoints = %d, want 1", len(svc.Generator.Endpoints))
	}
}

func TestParse_PlainMapFormat(t *testing.T) {
	plain := `
name: Plain Map
nodes:
  - type: vpc
    name: VPC1
`
	s, err := Parse(strings.NewReader(plain))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Name != "Plain Map" {
		t.Errorf("name = %q, want %q", s.Name, "Plain Map")
	}
}

func TestParse_MissingName(t *testing.T) {
	_, err := Parse(strings.NewReader("- nodes:\n  - type: vpc\n    name: VPC1\n"))
	if err == nil {
		t.Fatal("expected error for missing name")
	}
}

func TestParse_UserClientsNode(t *testing.T) {
	s, err := Parse(strings.NewReader(referenceYAML))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var clients *Node
	for i := range s.Nodes {
		if s.Nodes[i].Type == NodeTypeUserClients {
			clients = &s.Nodes[i]
			break
		}
	}
	if clients == nil {
		t.Fatal("no user_clients node found")
	}
	if len(clients.Clients) != 1 {
		t.Errorf("clients = %d, want 1", len(clients.Clients))
	}
	if clients.Clients[0].RPS != 5 {
		t.Errorf("rps = %v, want 5", clients.Clients[0].RPS)
	}
}
