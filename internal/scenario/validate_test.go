package scenario

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, yaml string) *Scenario {
	t.Helper()
	s, err := Parse(strings.NewReader(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return s
}

func TestValidate_ValidScenario(t *testing.T) {
	if err := Validate(mustParse(t, referenceYAML)); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidate_MissingHost(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: virtual_server
    name: VM1
- services:
  - type: nodejs
    name: Svc1
    generator: {type: nodejs}
- connections: []
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error for missing host")
	}
	if !strings.Contains(err.Error(), "missing required field 'host'") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidate_UnknownHost(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: virtual_server
    name: VM1
- services:
  - type: nodejs
    name: Svc1
    host: NonExistent
    generator: {type: nodejs}
- connections: []
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error for unknown host")
	}
	if !strings.Contains(err.Error(), `unknown host "NonExistent"`) {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidate_HostNotVirtualServer(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: subnet
    name: SubnetA
- services:
  - type: nodejs
    name: Svc1
    host: SubnetA
    generator: {type: nodejs}
- connections: []
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error when host is not a virtual_server")
	}
}

func TestValidate_UnknownConnectionEndpoint(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: user_clients
    name: Clients
- services: []
- connections:
  - source: Clients
    target: Ghost
    protocol: http
    port: 80
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error for unknown connection target")
	}
	if !strings.Contains(err.Error(), `"Ghost"`) {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidate_DuplicateName(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: virtual_server
    name: Shared
  - type: subnet
    name: Shared
- services: []
- connections: []
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error for duplicate name")
	}
}

func TestValidate_IPOutsideCIDR(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: subnet
    name: SubA
    cidr_block: 10.0.1.0/24
  - type: virtual_server
    name: VM1
    subnet: SubA
    private_ip: 192.168.1.5
- services: []
- connections: []
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error for IP outside CIDR")
	}
	if !strings.Contains(err.Error(), "outside subnet") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidate_UnknownSubnetRef(t *testing.T) {
	yaml := `
- name: Bad
- nodes:
  - type: virtual_server
    name: VM1
    subnet: NoSuchSubnet
- services: []
- connections: []
`
	s := mustParse(t, yaml)
	err := Validate(s)
	if err == nil {
		t.Fatal("expected error for unknown subnet reference")
	}
}

func TestValidate_ReferenceScenarioFile(t *testing.T) {
	s, err := ValidateFile("../../scenarios/web-service.yaml")
	if err != nil {
		t.Fatalf("reference scenario failed validation: %v", err)
	}
	if s.Name != "Web Service" {
		t.Errorf("name = %q, want %q", s.Name, "Web Service")
	}
}
