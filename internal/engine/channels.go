package engine

import (
	"net"
	"regexp"
	"strings"

	"github.com/nikhilm/logsim2/internal/scenario"
)

var slugRe = regexp.MustCompile(`[^a-z0-9-]+`)

func slugify(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "-")
	s = slugRe.ReplaceAllString(s, "")
	return strings.Trim(s, "-")
}

// SourceMap maps every entity name (node or service) to its log source path.
type SourceMap map[string]string

// BuildSources computes source paths for all nodes and services in the scenario.
//
// Naming convention:
//
//	VPC:            <scenario>.<vpc>
//	Subnet:         <scenario>.<vpc>.<subnet>           (VPC inferred by CIDR)
//	VirtualServer:  <scenario>.<vpc>.<subnet>.<server>  (via server.Subnet field)
//	LoadBalancer:   <scenario>.<vpc>.<subnet>.<lb>      (via lb.Subnet field)
//	UserClients:    <scenario>.<node-name>
//	Service:        <scenario>.<vpc>.<subnet>.<host>.<service>
func BuildSources(s *scenario.Scenario) SourceMap {
	prefix := slugify(s.Name)
	m := make(SourceMap, len(s.Nodes)+len(s.Services)+1)

	// Index nodes by name and type for lookups.
	nodeByName := make(map[string]*scenario.Node, len(s.Nodes))
	for i := range s.Nodes {
		nodeByName[s.Nodes[i].Name] = &s.Nodes[i]
	}

	// Compute VPC channels.
	vpcChannel := make(map[string]string)
	for _, n := range s.Nodes {
		if n.Type == scenario.NodeTypeVPC {
			ch := prefix + "." + slugify(n.Name)
			vpcChannel[n.Name] = ch
			m[n.Name] = ch
		}
	}

	// Map subnet CIDR → VPC name (for implicit containment).
	subnetVPC := make(map[string]string)
	for _, subnet := range s.Nodes {
		if subnet.Type != scenario.NodeTypeSubnet || subnet.CIDRBlock == "" {
			continue
		}
		_, subNet, err := net.ParseCIDR(subnet.CIDRBlock)
		if err != nil {
			continue
		}
		for _, vpc := range s.Nodes {
			if vpc.Type != scenario.NodeTypeVPC || vpc.CIDRBlock == "" {
				continue
			}
			_, vpcNet, err := net.ParseCIDR(vpc.CIDRBlock)
			if err != nil {
				continue
			}
			if cidrContains(vpcNet, subNet) {
				subnetVPC[subnet.Name] = vpc.Name
				break
			}
		}
		// If only one VPC and CIDR containment failed, assign to it.
		if _, assigned := subnetVPC[subnet.Name]; !assigned {
			for _, vpc := range s.Nodes {
				if vpc.Type == scenario.NodeTypeVPC {
					subnetVPC[subnet.Name] = vpc.Name
					break
				}
			}
		}
	}

	// Compute subnet channels.
	subnetChannel := make(map[string]string)
	for _, n := range s.Nodes {
		if n.Type != scenario.NodeTypeSubnet {
			continue
		}
		vpcName := subnetVPC[n.Name]
		if vpc, ok := vpcChannel[vpcName]; ok {
			ch := vpc + "." + slugify(n.Name)
			subnetChannel[n.Name] = ch
			m[n.Name] = ch
		} else {
			// No VPC found — just prefix.
			ch := prefix + "." + slugify(n.Name)
			subnetChannel[n.Name] = ch
			m[n.Name] = ch
		}
	}

	// Compute channels for virtual_server, load_balancer (and VPC flow).
	hostChannel := make(map[string]string) // server/lb name → channel
	for _, n := range s.Nodes {
		switch n.Type {
		case scenario.NodeTypeVirtualServer, scenario.NodeTypeLoadBalancer:
			var ch string
			if n.Subnet != "" {
				if sc, ok := subnetChannel[n.Subnet]; ok {
					ch = sc + "." + slugify(n.Name)
				}
			}
			if ch == "" {
				ch = prefix + "." + slugify(n.Name)
			}
			hostChannel[n.Name] = ch
			m[n.Name] = ch

		case scenario.NodeTypeUserClients:
			m[n.Name] = prefix + "." + slugify(n.Name)
		}
	}

	// VPC flow log channels.
	for _, n := range s.Nodes {
		if n.Type == scenario.NodeTypeVPC {
			m[n.Name+"/flow"] = vpcChannel[n.Name] + ".flow"
		}
	}

	// Compute service channels.
	for _, svc := range s.Services {
		host := hostChannel[svc.Host]
		if host == "" {
			host = prefix + "." + slugify(svc.Host)
		}
		m[svc.Name] = host + "." + slugify(svc.Name)
	}

	return m
}

// cidrContains reports whether outer fully contains inner.
func cidrContains(outer, inner *net.IPNet) bool {
	outerOnes, outerBits := outer.Mask.Size()
	innerOnes, innerBits := inner.Mask.Size()
	if outerBits != innerBits {
		return false
	}
	return outerOnes <= innerOnes && outer.Contains(inner.IP)
}
