package generators

import "github.com/nikhilm/logsim2/internal/scenario"

// ForService returns the Generator for the given service type, or nil.
func ForService(serviceType scenario.ServiceType) Generator {
	switch serviceType {
	case scenario.ServiceTypeNodejs:
		return &NodejsGenerator{}
	case scenario.ServiceTypeMySQL:
		return &MysqlGenerator{}
	// Phase 4+: golang, postgres, redis, nginx (standalone), custom
	default:
		return nil
	}
}

// ForNode returns the Generator for a node type, or nil.
// Node must be supplied so generators that need type-specific config
// (e.g. VPC CIDR for flow logs) can initialise themselves.
func ForNode(node *scenario.Node) Generator {
	switch node.Type {
	case scenario.NodeTypeVPC:
		return NewVpcFlowGenerator(node)
	case scenario.NodeTypeLoadBalancer:
		return &LoadBalancerGenerator{}
	// user_clients, vpc, subnet emit no logs directly
	default:
		return nil
	}
}
