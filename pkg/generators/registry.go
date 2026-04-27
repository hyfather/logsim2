package generators

import "github.com/nikhilm/logsim2/pkg/scenario"

// ForService returns the Generator for the given service type, or nil.
//
// nodejs and mysql have first-class generators. Other web/db service types
// (golang, nginx, postgres, redis) currently fall back to the closest
// analogue so any scenario the canvas can author actually emits logs at
// runtime — without that fallback an "nginx" or "redis" service is silent
// and the user thinks the simulator is broken. Custom is handled by
// NewCustomGenerator at the call site.
func ForService(serviceType scenario.ServiceType) Generator {
	switch serviceType {
	case scenario.ServiceTypeNodejs,
		scenario.ServiceTypeGolang,
		scenario.ServiceTypeNginx:
		return &NodejsGenerator{}
	case scenario.ServiceTypeMySQL,
		scenario.ServiceTypePostgres,
		scenario.ServiceTypeRedis:
		return &MysqlGenerator{}
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
