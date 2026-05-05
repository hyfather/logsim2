package generators

import (
	"fmt"
	"net"
	"sort"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
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

// VpcFlowGenerator emits AWS VPC Flow Log v2 lines, aggregated by stable
// 5-tuple per tick. Stage 1 of PHYSICS_PLAN.md: src/dst/ports come from
// Request Hops (stable per session) so the same logical connection shows
// up under a consistent 5-tuple across multiple flow records — which is
// the conservation property real VPC flow logs satisfy.
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

type flowKey struct {
	srcIP, dstIP, proto string
	srcPort, dstPort    int
}

type flowAgg struct {
	bytes    int64
	packets  int64
	startTS  int64
	endTS    int64
	firstHop *event.Hop
}

func (g *VpcFlowGenerator) Generate(target Target, _ []event.Flow, ctx event.TickContext) []event.LogEntry {
	if target.Node == nil {
		return nil
	}

	// Aggregate every Hop touching this VPC into per-5-tuple flow records.
	bucket := make(map[flowKey]*flowAgg)
	for ri := range ctx.Requests {
		r := &ctx.Requests[ri]
		for hi := range r.Hops {
			h := &r.Hops[hi]
			if !g.includeHop(h) {
				continue
			}
			k := flowKey{
				srcIP:   h.SrcIP,
				dstIP:   h.DstIP,
				proto:   h.Protocol,
				srcPort: h.SrcPort,
				dstPort: h.DstPort,
			}
			a, ok := bucket[k]
			if !ok {
				a = &flowAgg{
					startTS:  h.EnteredAt.Unix(),
					endTS:    h.LeftAt.Unix(),
					firstHop: h,
				}
				bucket[k] = a
			}
			// MTU 1500 → packets ≈ bytes/1400 (approx with framing).
			b := h.BytesIn + h.BytesOut
			a.bytes += b
			a.packets += b/1400 + 1
			if h.EnteredAt.Unix() < a.startTS {
				a.startTS = h.EnteredAt.Unix()
			}
			if h.LeftAt.Unix() > a.endTS {
				a.endTS = h.LeftAt.Unix()
			}
		}
	}

	if len(bucket) == 0 {
		return nil
	}

	// Deterministic ordering: sort keys.
	keys := make([]flowKey, 0, len(bucket))
	for k := range bucket {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		ki, kj := keys[i], keys[j]
		if ki.srcIP != kj.srcIP {
			return ki.srcIP < kj.srcIP
		}
		if ki.dstIP != kj.dstIP {
			return ki.dstIP < kj.dstIP
		}
		if ki.dstPort != kj.dstPort {
			return ki.dstPort < kj.dstPort
		}
		if ki.srcPort != kj.srcPort {
			return ki.srcPort < kj.srcPort
		}
		return ki.proto < kj.proto
	})

	entries := make([]event.LogEntry, 0, len(keys))
	for i, k := range keys {
		a := bucket[k]
		proto := protocolNumber[k.proto]
		if proto == 0 {
			proto = 6
		}
		eniID := fmt.Sprintf("eni-%07x", i+1)
		tsStr := a.firstHop.EnteredAt.UTC().Format("2006-01-02T15:04:05Z")

		raw := fmt.Sprintf("2 %s %s %s %s %d %d %d %d %d %d %d ACCEPT OK",
			g.accountID, eniID,
			k.srcIP, k.dstIP,
			k.srcPort, k.dstPort,
			proto, a.packets, a.bytes,
			a.startTS, a.endTS,
		)

		entries = append(entries, event.LogEntry{
			ID:         makeFlowID(target, ctx.TickIndex, i),
			TS:         tsStr,
			Source:     target.Source,
			Level:      "INFO",
			Sourcetype: "vpc-flow",
			Class:      "network_activity",
			Raw:        raw,
			Fields: map[string]any{
				"src_ip":   k.srcIP,
				"dst_ip":   k.dstIP,
				"src_port": k.srcPort,
				"dst_port": k.dstPort,
				"protocol": proto,
				"bytes":    a.bytes,
				"packets":  a.packets,
				"action":   "ACCEPT",
			},
		})
	}
	return entries
}

// includeHop returns true if the Hop's endpoints are within the VPC CIDR.
func (g *VpcFlowGenerator) includeHop(h *event.Hop) bool {
	if g.cidr == nil {
		return true
	}
	srcIP := net.ParseIP(h.SrcIP)
	dstIP := net.ParseIP(h.DstIP)
	if srcIP == nil && dstIP == nil {
		return false
	}
	return (srcIP != nil && g.cidr.Contains(srcIP)) ||
		(dstIP != nil && g.cidr.Contains(dstIP))
}

// makeFlowID is the VPC flow log specialisation of makeID — flow records
// don't have a per-request span_id since multiple requests aggregate into
// one record, so we don't reuse makeID's request-index encoding.
func makeFlowID(target Target, tickIndex, idx int) string {
	return fmt.Sprintf("t%d-vpcflow-%d-%s", tickIndex, idx, target.Source)
}
