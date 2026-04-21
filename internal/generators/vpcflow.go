package generators

import (
	"fmt"
	"net"

	"github.com/nikhilm/logsim2/internal/event"
	"github.com/nikhilm/logsim2/internal/scenario"
)

// protocolNumber maps connection protocol strings to IANA protocol numbers.
var protocolNumber = map[string]int{
	"tcp":      6,
	"udp":      17,
	"icmp":     1,
	"http":     6,
	"https":    6,
	"mysql":    6,
	"postgres": 6,
	"redis":    6,
	"grpc":     6,
}

// VpcFlowGenerator emits AWS VPC Flow Log v2 lines for every flow that
// involves endpoints within the VPC's CIDR block.
//
// Format (space-separated):
//
//	version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status
type VpcFlowGenerator struct {
	cidr      *net.IPNet
	accountID string
}

func NewVpcFlowGenerator(node *scenario.Node) *VpcFlowGenerator {
	g := &VpcFlowGenerator{accountID: "123456789012"}
	if node.CIDRBlock != "" {
		_, ipNet, err := net.ParseCIDR(node.CIDRBlock)
		if err == nil {
			g.cidr = ipNet
		}
	}
	return g
}

func (g *VpcFlowGenerator) Generate(target Target, _ []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Node == nil {
		return nil
	}

	// Use AllFlows from context; emit one line per flow that involves
	// at least one endpoint within the VPC CIDR (or all flows if CIDR unknown).
	var entries []event.LogEntry

	for i, f := range ctx.AllFlows {
		if f.RequestCount == 0 {
			continue
		}
		if !g.includeFlow(&f) {
			continue
		}

		start := f.Timestamp.Unix()
		end := start + int64(ctx.TickIntervalMs/1000)

		proto := protocolNumber[f.Protocol]
		if proto == 0 {
			proto = 6 // default TCP
		}

		srcPort := 49152 + ctx.Rng.Intn(16383) // ephemeral range
		dstPort := f.Port
		if dstPort == 0 {
			dstPort = 80
		}

		// Approximate packet count (assume ~1500 byte MTU).
		bytes := f.BytesSent
		if bytes == 0 {
			bytes = int64(f.RequestCount) * 1400
		}
		packets := bytes/1400 + 1

		eniID := fmt.Sprintf("eni-%07x", i+1)
		tsStr := f.Timestamp.UTC().Format("2006-01-02T15:04:05Z")

		raw := fmt.Sprintf("2 %s %s %s %s %d %d %d %d %d %d %d ACCEPT OK",
			g.accountID, eniID,
			f.SrcIP, f.DstIP,
			srcPort, dstPort,
			proto, packets, bytes,
			start, end,
		)

		entries = append(entries, event.LogEntry{
			ID:      makeID(ctx.TickIndex, i),
			TS:      tsStr,
			Source:     target.Source,
			Level:      "INFO",
			Sourcetype: "vpc-flow",
			Raw:     raw,
			Fields: map[string]any{
				"src_ip":   f.SrcIP,
				"dst_ip":   f.DstIP,
				"src_port": srcPort,
				"dst_port": dstPort,
				"protocol": proto,
				"bytes":    bytes,
				"packets":  packets,
				"action":   "ACCEPT",
			},
		})
	}

	return entries
}

// includeFlow returns true if either endpoint is inside the VPC CIDR.
func (g *VpcFlowGenerator) includeFlow(f *event.Flow) bool {
	if g.cidr == nil {
		return true // no CIDR info — include everything
	}
	srcIP := net.ParseIP(f.SrcIP)
	dstIP := net.ParseIP(f.DstIP)
	if srcIP == nil && dstIP == nil {
		return false
	}
	return (srcIP != nil && g.cidr.Contains(srcIP)) ||
		(dstIP != nil && g.cidr.Contains(dstIP))
}
