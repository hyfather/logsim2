package engine

import (
	"math"
	"net"
	"time"

	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/scenario"
)

// trafficSimulator computes per-tick Flows for all connections in a scenario.
type trafficSimulator struct {
	// Pre-computed per-connection pattern and base RPS.
	connMeta []connMeta
	// IP pools per entity name (drawn from private_ip or subnet CIDR).
	ipByEntity map[string]string
	// Subnet CIDR blocks for auto-assigning IPs.
	subnetCIDR map[string]string
}

type connMeta struct {
	pat    pattern
	baseRPS float64
}

func newTrafficSimulator(s *scenario.Scenario) *trafficSimulator {
	ts := &trafficSimulator{
		connMeta:   make([]connMeta, len(s.Connections)),
		ipByEntity: make(map[string]string),
		subnetCIDR: make(map[string]string),
	}

	// Index subnet CIDRs.
	for _, n := range s.Nodes {
		if n.Type == scenario.NodeTypeSubnet && n.CIDRBlock != "" {
			ts.subnetCIDR[n.Name] = n.CIDRBlock
		}
	}

	// Build IP map for nodes that have a private_ip or belong to a subnet.
	nodeByName := make(map[string]*scenario.Node, len(s.Nodes))
	for i := range s.Nodes {
		nodeByName[s.Nodes[i].Name] = &s.Nodes[i]
	}
	for _, n := range s.Nodes {
		if n.PrivateIP != "" {
			ts.ipByEntity[n.Name] = n.PrivateIP
		}
	}
	for _, svc := range s.Services {
		if host, ok := nodeByName[svc.Host]; ok && host.PrivateIP != "" {
			ts.ipByEntity[svc.Name] = host.PrivateIP
		}
	}

	// Compute base RPS and pattern for each connection.
	// Source of RPS: if source is a user_clients node → sum of client RPS.
	// Otherwise → use total inbound RPS (propagated; computed at tick time).
	userRPS := make(map[string]float64) // user_clients node name → total RPS
	clientPattern := make(map[string]pattern)
	for _, n := range s.Nodes {
		if n.Type != scenario.NodeTypeUserClients {
			continue
		}
		var total float64
		pat := patternSteady
		for _, c := range n.Clients {
			total += c.RPS
			pat = matchPattern(c.TrafficPattern)
		}
		userRPS[n.Name] = total
		clientPattern[n.Name] = pat
	}

	for i, c := range s.Connections {
		rps := userRPS[c.Source]
		pat := clientPattern[c.Source]
		ts.connMeta[i] = connMeta{pat: pat, baseRPS: rps}
	}

	return ts
}

// Flows generates traffic flows for one tick.
// It propagates traffic through intermediate nodes (e.g. load balancers)
// so downstream generators see realistic inbound flows.
func (ts *trafficSimulator) Flows(
	s *scenario.Scenario,
	tickIndex int,
	tickIntervalMs int,
	rng interface{ Float64() float64; Intn(int) int },
	ts2 time.Time,
) []event.Flow {
	tickSec := float64(tickIntervalMs) / 1000.0

	// Phase 1: compute direct flows from user_clients.
	// inbound[name] = total request count flowing into that entity this tick.
	inbound := make(map[string]int, len(s.Connections))

	flows := make([]event.Flow, 0, len(s.Connections)*2)

	for i, c := range s.Connections {
		meta := ts.connMeta[i]
		if meta.baseRPS <= 0 {
			continue // not directly from a user_clients; handled in phase 2
		}
		mult := multiplier(meta.pat, tickIndex, rng)
		reqCount := int(math.Round(meta.baseRPS * tickSec * mult))
		if reqCount < 0 {
			reqCount = 0
		}
		errCount := int(math.Round(float64(reqCount) * 0.01))

		f := event.Flow{
			ConnectionIdx: i,
			SourceName:    c.Source,
			TargetName:    c.Target,
			Protocol:      c.Protocol,
			Port:          c.Port,
			RequestCount:  reqCount,
			BytesSent:     int64(reqCount) * int64(500+rng.Intn(2000)),
			BytesReceived: int64(reqCount) * int64(200+rng.Intn(1000)),
			ErrorCount:    errCount,
			SrcIP:         ts.ipForEntity(c.Source, s),
			DstIP:         ts.ipForEntity(c.Target, s),
			Timestamp:     ts2,
		}
		flows = append(flows, f)
		inbound[c.Target] += reqCount
	}

	// Phase 2: propagate traffic through intermediate nodes.
	// Any entity that received inbound traffic also forwards on its outbound connections
	// (proportionally if there are multiple upstreams; for now distribute evenly).
	outboundConns := make(map[string][]int) // entity → connection indices
	for i, c := range s.Connections {
		if ts.connMeta[i].baseRPS > 0 {
			continue // already handled above
		}
		outboundConns[c.Source] = append(outboundConns[c.Source], i)
	}

	// Iterate until no new traffic propagates (handles simple chains, not cycles).
	changed := true
	for changed {
		changed = false
		for src, conns := range outboundConns {
			total := inbound[src]
			if total == 0 {
				continue
			}
			perConn := total / len(conns)
			if perConn == 0 {
				perConn = 1
			}
			for _, ci := range conns {
				c := s.Connections[ci]
				if inbound[c.Target] == 0 {
					changed = true
				}
				errCount := int(math.Round(float64(perConn) * 0.01))
				f := event.Flow{
					ConnectionIdx: ci,
					SourceName:    c.Source,
					TargetName:    c.Target,
					Protocol:      c.Protocol,
					Port:          c.Port,
					RequestCount:  perConn,
					BytesSent:     int64(perConn) * int64(500+rng.Intn(2000)),
					BytesReceived: int64(perConn) * int64(200+rng.Intn(1000)),
					ErrorCount:    errCount,
					SrcIP:         ts.ipForEntity(c.Source, s),
					DstIP:         ts.ipForEntity(c.Target, s),
					Timestamp:     ts2,
				}
				flows = append(flows, f)
				inbound[c.Target] += perConn
			}
			// Zero out so we don't re-propagate this tick.
			delete(outboundConns, src)
		}
	}

	return flows
}

func (ts *trafficSimulator) ipForEntity(name string, s *scenario.Scenario) string {
	if ip, ok := ts.ipByEntity[name]; ok {
		return ip
	}
	// Try to find the entity's subnet and pick an IP from the CIDR.
	for _, n := range s.Nodes {
		if n.Name == name && n.Subnet != "" {
			if cidr, ok := ts.subnetCIDR[n.Subnet]; ok {
				return firstUsableIP(cidr)
			}
		}
	}
	// For user_clients, look up their first client's IP.
	for _, n := range s.Nodes {
		if n.Name == name && n.Type == scenario.NodeTypeUserClients && len(n.Clients) > 0 {
			return n.Clients[0].IP
		}
	}
	return "0.0.0.0"
}

func firstUsableIP(cidr string) string {
	ip, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return "0.0.0.0"
	}
	ip = ip.Mask(ipNet.Mask)
	// Increment to first usable host.
	inc := make(net.IP, len(ip))
	copy(inc, ip)
	for i := len(inc) - 1; i >= 0; i-- {
		inc[i]++
		if inc[i] != 0 {
			break
		}
	}
	return inc.String()
}
