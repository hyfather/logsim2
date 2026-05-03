package engine

import (
	"math"
	"net"
	"strings"
	"time"

	"github.com/nikhilm/logsim2/pkg/event"
	"github.com/nikhilm/logsim2/pkg/scenario"
)

// rng is the minimal random-source interface the request simulator needs.
// Same surface as event.TickContext.Rng so callers don't need an adaptor.
type rng interface {
	Float64() float64
	Intn(int) int
}

// requestSimulator produces per-tick []Request by walking the connection
// graph from each user_clients entry point. Stage 1 of PHYSICS_PLAN.md.
//
// Each request walks one path through the graph, picking outbound
// connections uniformly at random at each fan-out. Path/method/user
// identity are picked once at entry and frozen on the Request, so every
// component the request touches sees the same values. Connection 5-tuples
// are stable per (srcEntity, dstEntity, proto) within a session.
type requestSimulator struct {
	// outbound[entityName] = indices into Scenario.Connections originating there.
	outbound map[string][]int
	// Subnet CIDR per subnet name, for IP auto-assignment.
	subnetCIDR map[string]string
	// Resolved IP per entity name.
	ipByEntity map[string]string
	// Set of names that are services (not nodes); used to know when an
	// entity has endpoints to project from.
	isService map[string]bool
	// Endpoints per service name.
	endpoints map[string][]scenario.Endpoint
	// Service type per service name (used to decide what queries to
	// synthesize for datastore generators).
	serviceType map[string]scenario.ServiceType
	// Per-service ErrorRate (residual baseline error rate).
	serviceErrorRate map[string]float64
}

func newRequestSimulator(s *scenario.Scenario) *requestSimulator {
	rs := &requestSimulator{
		outbound:         make(map[string][]int),
		subnetCIDR:       make(map[string]string),
		ipByEntity:       make(map[string]string),
		isService:        make(map[string]bool),
		endpoints:        make(map[string][]scenario.Endpoint),
		serviceType:      make(map[string]scenario.ServiceType),
		serviceErrorRate: make(map[string]float64),
	}
	for i, c := range s.Connections {
		rs.outbound[c.Source] = append(rs.outbound[c.Source], i)
	}
	for _, n := range s.Nodes {
		if n.Type == scenario.NodeTypeSubnet && n.CIDRBlock != "" {
			rs.subnetCIDR[n.Name] = n.CIDRBlock
		}
	}
	nodeByName := make(map[string]*scenario.Node, len(s.Nodes))
	for i := range s.Nodes {
		nodeByName[s.Nodes[i].Name] = &s.Nodes[i]
		if s.Nodes[i].PrivateIP != "" {
			rs.ipByEntity[s.Nodes[i].Name] = s.Nodes[i].PrivateIP
		}
	}
	for i := range s.Services {
		svc := &s.Services[i]
		rs.isService[svc.Name] = true
		rs.endpoints[svc.Name] = svc.Generator.Endpoints
		rs.serviceType[svc.Name] = svc.Type
		rs.serviceErrorRate[svc.Name] = svc.Generator.ErrorRate
		if host, ok := nodeByName[svc.Host]; ok && host.PrivateIP != "" {
			rs.ipByEntity[svc.Name] = host.PrivateIP
		}
	}
	return rs
}

// Requests produces the causal request records for one tick. Determinism:
// same scenario + same seed + same tick = byte-identical output.
func (rs *requestSimulator) Requests(
	s *scenario.Scenario,
	tickIndex int,
	tickIntervalMs int,
	rng rng,
	baseTime time.Time,
) []event.Request {
	tickSec := float64(tickIntervalMs) / 1000.0
	var out []event.Request

	// Arrivals from user_clients.
	for ni := range s.Nodes {
		n := &s.Nodes[ni]
		if n.Type != scenario.NodeTypeUserClients {
			continue
		}
		for ci := range n.Clients {
			client := &n.Clients[ci]
			pat := matchPattern(client.TrafficPattern)
			mult := multiplier(pat, tickIndex, rng)
			arrivals := int(math.Round(client.RPS * tickSec * mult))
			if arrivals <= 0 {
				continue
			}
			for k := 0; k < arrivals; k++ {
				if req := rs.buildClientRequest(s, n.Name, client, tickIntervalMs, rng, baseTime); req != nil {
					out = append(out, *req)
				}
			}
		}
	}

	// Synthesize baseline self-traffic for services that no user_clients
	// arrival reached this tick. Without this, a canvas with services but
	// no user_clients node looks broken (no logs at all). Mirrors the
	// legacy defaultServiceRPS path.
	serviceArrivals := make(map[string]int)
	for _, req := range out {
		for hi := range req.Hops {
			if rs.isService[req.Hops[hi].Entity] {
				serviceArrivals[req.Hops[hi].Entity]++
			}
		}
	}
	for i := range s.Services {
		svc := &s.Services[i]
		if serviceArrivals[svc.Name] > 0 {
			continue
		}
		arrivals := int(math.Round(defaultServiceRPS * tickSec))
		for k := 0; k < arrivals; k++ {
			if req := rs.buildSelfRequest(s, svc, tickIntervalMs, rng, baseTime); req != nil {
				out = append(out, *req)
			}
		}
	}

	return out
}

// buildClientRequest constructs one request originating at a user_clients node.
// Returns nil if the node has no outbound connection (nothing to simulate).
func (rs *requestSimulator) buildClientRequest(
	s *scenario.Scenario,
	entryNode string,
	client *scenario.Client,
	tickIntervalMs int,
	rng rng,
	baseTime time.Time,
) *event.Request {
	path := rs.computePath(entryNode, s, rng)
	if len(path) == 0 {
		return nil
	}
	method, urlPath := rs.pickEndpoint(path, rng)
	traceID := newHexID(rng, 16)
	sessionID := newHexID(rng, 12)

	offsetMs := rng.Intn(tickIntervalMs)
	arrivalTime := baseTime.Add(time.Duration(offsetMs) * time.Millisecond)

	// Status: a residual error rate on the terminal endpoint. Stage 2
	// adds capacity-derived errors on top of this.
	status := rs.pickStatus(path, urlPath, rng)

	bodyIn := sampleBodyBytes(method, urlPath, false, rng)
	bodyOut := sampleBodyBytes(method, urlPath, status >= 500, rng)

	req := &event.Request{
		TraceID:   traceID,
		StartedAt: arrivalTime,
		Method:    method,
		Path:      urlPath,
		UserAgent: client.UserAgent,
		ClientIP:  client.IP,
		SessionID: sessionID,
		EntryNode: entryNode,
	}

	rs.fillHops(req, path, s, status, bodyIn, bodyOut, urlPath, method, arrivalTime, client.IP, entryNode, rng)

	if status >= 500 && len(req.Hops) > 0 {
		req.Failure = &event.RequestFailure{
			OffendingHop: req.Hops[len(req.Hops)-1].Entity,
			Reason:       "5xx",
		}
	}
	return req
}

// buildSelfRequest creates a synthesized arrival at one service so that
// canvases without user_clients still produce logs. The "request" is
// internal: the service's own host loops back as the client.
func (rs *requestSimulator) buildSelfRequest(
	s *scenario.Scenario,
	svc *scenario.Service,
	tickIntervalMs int,
	rng rng,
	baseTime time.Time,
) *event.Request {
	// Single-hop path: just this service.
	step := pathStep{entity: svc.Name, connIdx: -1}
	path := []pathStep{step}

	method, urlPath := rs.pickEndpoint(path, rng)
	traceID := newHexID(rng, 16)
	sessionID := newHexID(rng, 12)
	offsetMs := rng.Intn(tickIntervalMs)
	arrivalTime := baseTime.Add(time.Duration(offsetMs) * time.Millisecond)

	status := 200
	if rng.Float64() < rs.serviceErrorRate[svc.Name] {
		status = 500
	}

	bodyIn := sampleBodyBytes(method, urlPath, false, rng)
	bodyOut := sampleBodyBytes(method, urlPath, status >= 500, rng)

	req := &event.Request{
		TraceID:   traceID,
		StartedAt: arrivalTime,
		Method:    method,
		Path:      urlPath,
		UserAgent: "",
		ClientIP:  "127.0.0.1",
		SessionID: sessionID,
		EntryNode: "internal",
	}
	rs.fillHops(req, path, s, status, bodyIn, bodyOut, urlPath, method, arrivalTime, "127.0.0.1", "internal", rng)
	if status >= 500 && len(req.Hops) > 0 {
		req.Failure = &event.RequestFailure{
			OffendingHop: req.Hops[len(req.Hops)-1].Entity,
			Reason:       "5xx",
		}
	}
	return req
}

// fillHops populates req.Hops from the resolved path and shared request
// facts (status/bytes/path). Latency at each hop is sampled independently;
// the request's overall wall-clock time is the sum.
func (rs *requestSimulator) fillHops(
	req *event.Request,
	path []pathStep,
	s *scenario.Scenario,
	status int,
	bodyIn, bodyOut int64,
	urlPath, method string,
	arrivalTime time.Time,
	clientIP, entryNode string,
	rng rng,
) {
	cumLatencyMs := 0
	parentSpan := ""
	prevEntity := entryNode
	prevIP := clientIP

	for i, step := range path {
		var connProto string
		var connPort int
		var srcPort int
		dstPort := 0

		if step.connIdx >= 0 && step.connIdx < len(s.Connections) {
			c := s.Connections[step.connIdx]
			connProto = c.Protocol
			connPort = c.Port
		} else {
			connProto = "tcp"
		}
		// Stable ephemeral src port for (prevEntity, step.entity, proto).
		// Hash-based so it's deterministic without persisting state, and
		// constant across multiple flows on the same logical connection
		// within a tick.
		srcPort = stableSrcPort(prevEntity, step.entity, connProto, req.SessionID)
		dstPort = connPort
		if dstPort == 0 {
			dstPort = defaultPort(connProto)
		}

		// Latency at this hop: from endpoint config if we have one for
		// this entity; otherwise a default per layer.
		hopLatency := rs.sampleHopLatency(step.entity, urlPath, method, rng)
		entered := arrivalTime.Add(time.Duration(cumLatencyMs) * time.Millisecond)
		cumLatencyMs += hopLatency
		left := arrivalTime.Add(time.Duration(cumLatencyMs) * time.Millisecond)

		dstIP := rs.ipByEntity[step.entity]
		if dstIP == "" {
			dstIP = rs.fallbackIP(s, step.entity)
		}

		spanID := newHexID(rng, 8)
		overhead := protocolOverhead(connProto)
		hop := event.Hop{
			Entity:     step.entity,
			SpanID:     spanID,
			ParentSpan: parentSpan,
			EnteredAt:  entered,
			LeftAt:     left,
			SrcEntity:  prevEntity,
			SrcIP:      prevIP,
			DstIP:      dstIP,
			SrcPort:    srcPort,
			DstPort:    dstPort,
			Protocol:   connProto,
			Status:     status,
			BytesIn:    bodyIn + overhead,
			BytesOut:   bodyOut + overhead,
			LatencyMs:  hopLatency,
		}
		req.Hops = append(req.Hops, hop)
		parentSpan = spanID
		prevEntity = step.entity
		prevIP = dstIP
		_ = i
	}
}

// pathStep is one step in a request's walk through the connection graph.
type pathStep struct {
	entity  string
	connIdx int // -1 for synthesized self-arrivals
}

// computePath produces a single random walk from start, following one
// outbound connection at each step, stopping at terminals or revisits.
// Cycles are avoided by tracking visited entities.
func (rs *requestSimulator) computePath(start string, s *scenario.Scenario, rng rng) []pathStep {
	visited := map[string]bool{start: true}
	cur := start
	var path []pathStep
	for {
		conns, ok := rs.outbound[cur]
		if !ok || len(conns) == 0 {
			break
		}
		ci := conns[rng.Intn(len(conns))]
		c := s.Connections[ci]
		if visited[c.Target] {
			break
		}
		path = append(path, pathStep{entity: c.Target, connIdx: ci})
		visited[c.Target] = true
		cur = c.Target
	}
	return path
}

// pickEndpoint chooses a Method+Path for a request. Looks at the first
// service in the path that has endpoints configured; otherwise uses
// reasonable defaults so logs still look like HTTP traffic.
func (rs *requestSimulator) pickEndpoint(path []pathStep, rng rng) (method, urlPath string) {
	for _, step := range path {
		eps := rs.endpoints[step.entity]
		if len(eps) == 0 {
			continue
		}
		ep := eps[rng.Intn(len(eps))]
		return ep.Method, ep.Path
	}
	// Defaults for path-less scenarios.
	defaults := []struct{ m, p string }{
		{"GET", "/api/users"},
		{"GET", "/api/items"},
		{"POST", "/api/orders"},
		{"GET", "/health"},
	}
	d := defaults[rng.Intn(len(defaults))]
	return d.m, d.p
}

// pickStatus returns a status code for a request. Stage 1 uses the
// endpoint's configured ErrorRate as a baseline residual rate; capacity-
// derived errors arrive in Stage 2.
func (rs *requestSimulator) pickStatus(path []pathStep, urlPath string, rng rng) int {
	errRate := 0.005 // small residual
	for _, step := range path {
		eps := rs.endpoints[step.entity]
		for ei := range eps {
			if eps[ei].Path == urlPath {
				if eps[ei].ErrorRate > 0 {
					errRate = eps[ei].ErrorRate
				}
				break
			}
		}
	}
	if rng.Float64() >= errRate {
		switch rng.Intn(20) {
		case 0:
			return 201
		case 1:
			return 204
		case 2:
			return 301
		case 3:
			return 304
		default:
			return 200
		}
	}
	switch rng.Intn(7) {
	case 0:
		return 400
	case 1:
		return 403
	case 2:
		return 404
	case 3:
		return 429
	case 4:
		return 502
	case 5:
		return 503
	default:
		return 500
	}
}

// sampleHopLatency returns a per-hop service time in ms. Derived from
// endpoint config when available; otherwise from a tier-default. Stage 2
// will replace this with utilization-driven queueing math.
func (rs *requestSimulator) sampleHopLatency(entity, urlPath, method string, rng rng) int {
	mean := 0
	for _, ep := range rs.endpoints[entity] {
		if ep.Path == urlPath && (ep.Method == "" || ep.Method == method) {
			mean = ep.AvgLatencyMs
			break
		}
	}
	if mean == 0 {
		switch rs.serviceType[entity] {
		case scenario.ServiceTypeMySQL, scenario.ServiceTypePostgres:
			mean = 8
		case scenario.ServiceTypeRedis:
			mean = 1
		case scenario.ServiceTypeNginx:
			mean = 2
		default:
			// Node-level (LB) or unknown: small fixed cost.
			mean = 5
		}
	}
	// Log-normal-ish: median ~ mean, modest tail.
	v := math.Exp(rng.Float64()*0.6-0.3) * float64(mean)
	if v < 1 {
		v = 1
	}
	return int(math.Round(v))
}

// sampleBodyBytes returns a body-bytes draw for a method+path that's stable
// across layers — same bytes show up at LB and at backend within an
// overhead envelope.
func sampleBodyBytes(method, urlPath string, isError bool, rng rng) int64 {
	// Reads tend to return larger bodies than writes; errors return small JSON.
	if isError {
		return int64(80 + rng.Intn(400))
	}
	switch method {
	case "POST", "PUT", "PATCH":
		return int64(120 + rng.Intn(1500))
	case "DELETE":
		return int64(40 + rng.Intn(80))
	case "HEAD":
		return 0
	}
	// GET-ish: list endpoints return more, single-resource less.
	if strings.HasSuffix(urlPath, "s") || strings.Contains(urlPath, "list") {
		return int64(800 + rng.Intn(8000))
	}
	return int64(200 + rng.Intn(2000))
}

// protocolOverhead returns the TCP/TLS/HTTP framing overhead in bytes —
// used to keep VPC flow log bytes within a known envelope of HTTP body
// bytes per connection.
func protocolOverhead(proto string) int64 {
	switch strings.ToLower(proto) {
	case "https", "tls":
		return 280
	case "http":
		return 180
	case "mysql", "postgres":
		return 120
	case "redis":
		return 60
	default:
		return 100
	}
}

// defaultPort returns a sensible port for a protocol when none is set on
// the scenario connection.
func defaultPort(proto string) int {
	switch strings.ToLower(proto) {
	case "https":
		return 443
	case "http":
		return 80
	case "mysql":
		return 3306
	case "postgres":
		return 5432
	case "redis":
		return 6379
	}
	return 80
}

// stableSrcPort returns a deterministic ephemeral src port for a logical
// connection. Same (src, dst, proto) → same port across every hop within
// a tick — what real VPC flow logs see for a persistent TCP connection.
// Session is intentionally NOT included: two requests from the same client
// to the same target should appear under the same 5-tuple in flow logs
// (which is how real VPC flow logs aggregate). Per-session port variation
// is a Stage 4 observer concern.
func stableSrcPort(src, dst, proto, _ string) int {
	h := uint32(2166136261)
	for i := 0; i < len(src); i++ {
		h ^= uint32(src[i])
		h *= 16777619
	}
	for i := 0; i < len(dst); i++ {
		h ^= uint32(dst[i])
		h *= 16777619
	}
	for i := 0; i < len(proto); i++ {
		h ^= uint32(proto[i])
		h *= 16777619
	}
	return 49152 + int(h%16383)
}

// fallbackIP returns an IP for an entity that doesn't have a private_ip
// set, drawing from its parent subnet's CIDR.
func (rs *requestSimulator) fallbackIP(s *scenario.Scenario, entity string) string {
	for i := range s.Nodes {
		if s.Nodes[i].Name == entity && s.Nodes[i].Subnet != "" {
			if cidr, ok := rs.subnetCIDR[s.Nodes[i].Subnet]; ok {
				return firstUsableIPInCIDR(cidr)
			}
		}
	}
	return "0.0.0.0"
}

func firstUsableIPInCIDR(cidr string) string {
	ip, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return "0.0.0.0"
	}
	ip = ip.Mask(ipNet.Mask)
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

// newHexID returns a deterministic hex id of length 2*nBytes drawn from
// the engine's RNG.
func newHexID(rng rng, nBytes int) string {
	const hex = "0123456789abcdef"
	out := make([]byte, nBytes*2)
	for i := range out {
		out[i] = hex[rng.Intn(16)]
	}
	return string(out)
}
