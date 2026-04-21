package scenario

import (
	"fmt"
	"net"
	"strings"
)

// ValidationError collects all problems found in a scenario.
type ValidationError struct {
	Errors []string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%d validation error(s):\n  - %s", len(e.Errors), strings.Join(e.Errors, "\n  - "))
}

func (e *ValidationError) add(format string, args ...any) {
	e.Errors = append(e.Errors, fmt.Sprintf(format, args...))
}

func (e *ValidationError) hasErrors() bool { return len(e.Errors) > 0 }

// Validate checks a parsed scenario for semantic errors.
// Returns a *ValidationError (with all problems listed) or nil.
func Validate(s *Scenario) error {
	ve := &ValidationError{}

	// Build name lookup tables.
	nodeByName := make(map[string]*Node, len(s.Nodes))
	for i := range s.Nodes {
		n := &s.Nodes[i]
		if n.Name == "" {
			ve.add("node at index %d has no name", i)
			continue
		}
		if _, exists := nodeByName[n.Name]; exists {
			ve.add("duplicate name %q (nodes)", n.Name)
		}
		nodeByName[n.Name] = n
	}

	serviceByName := make(map[string]*Service, len(s.Services))
	for i := range s.Services {
		svc := &s.Services[i]
		if svc.Name == "" {
			ve.add("service at index %d has no name", i)
			continue
		}
		if _, exists := serviceByName[svc.Name]; exists {
			ve.add("duplicate name %q (services)", svc.Name)
		}
		if _, exists := nodeByName[svc.Name]; exists {
			ve.add("name %q used by both a node and a service", svc.Name)
		}
		serviceByName[svc.Name] = svc
	}

	// Validate service host references.
	for i := range s.Services {
		svc := &s.Services[i]
		if svc.Host == "" {
			ve.add("service %q is missing required field 'host'", svc.Name)
			continue
		}
		n, ok := nodeByName[svc.Host]
		if !ok {
			ve.add("service %q references unknown host %q", svc.Name, svc.Host)
			continue
		}
		if n.Type != NodeTypeVirtualServer {
			ve.add("service %q host %q is type %q, must be virtual_server", svc.Name, svc.Host, n.Type)
		}
	}

	// Validate connection endpoints.
	allNames := make(map[string]bool, len(nodeByName)+len(serviceByName))
	for k := range nodeByName {
		allNames[k] = true
	}
	for k := range serviceByName {
		allNames[k] = true
	}

	for i, c := range s.Connections {
		if c.Source == "" {
			ve.add("connection[%d] has no source", i)
		} else if !allNames[c.Source] {
			ve.add("connection[%d] source %q does not match any node or service name", i, c.Source)
		}
		if c.Target == "" {
			ve.add("connection[%d] has no target", i)
		} else if !allNames[c.Target] {
			ve.add("connection[%d] target %q does not match any node or service name", i, c.Target)
		}
	}

	// Validate private_ip against parent subnet CIDR (warning-level, not fatal).
	subnetCIDR := make(map[string]string)
	for _, n := range s.Nodes {
		if n.Type == NodeTypeSubnet && n.CIDRBlock != "" {
			subnetCIDR[n.Name] = n.CIDRBlock
		}
	}
	for _, n := range s.Nodes {
		if n.PrivateIP == "" || n.Subnet == "" {
			continue
		}
		cidr, ok := subnetCIDR[n.Subnet]
		if !ok {
			continue // subnet CIDR unknown, skip
		}
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		ip := net.ParseIP(n.PrivateIP)
		if ip == nil {
			ve.add("node %q has invalid private_ip %q", n.Name, n.PrivateIP)
			continue
		}
		if !ipNet.Contains(ip) {
			ve.add("node %q private_ip %q is outside subnet %q CIDR %s", n.Name, n.PrivateIP, n.Subnet, cidr)
		}
	}

	// Validate subnet references on nodes.
	for _, n := range s.Nodes {
		if n.Subnet == "" {
			continue
		}
		if _, ok := nodeByName[n.Subnet]; !ok {
			ve.add("node %q references unknown subnet %q", n.Name, n.Subnet)
		}
	}

	if ve.hasErrors() {
		return ve
	}
	return nil
}

// ValidateFile parses and validates a scenario file in one step.
func ValidateFile(path string) (*Scenario, error) {
	s, err := ParseFile(path)
	if err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if err := Validate(s); err != nil {
		return nil, err
	}
	return s, nil
}
