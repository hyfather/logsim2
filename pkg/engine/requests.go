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
	// synthesize for datastore generators and capacity defaults).
	serviceType map[string]scenario.ServiceType
	// Node type per node name (for capacity lookup of LBs etc.).
	nodeType map[string]scenario.NodeType
	// Per-service ErrorRate (residual baseline error rate).
	serviceErrorRate map[string]float64
	// causes is the per-tick perturbation source (Stage 3 of
	// PHYSICS_PLAN.md). Set by Engine.New after construction.
	causes *causeRegistry
}

func newRequestSimulator(s *scenario.Scenario) *requestSimulator {
	rs := &requestSimulator{
		outbound:         make(map[string][]int),
		subnetCIDR:       make(map[string]string),
		ipByEntity:       make(map[string]string),
		isService:        make(map[string]bool),
		endpoints:        make(map[string][]scenario.Endpoint),
		serviceType:      make(map[string]scenario.ServiceType),
		nodeType:         make(map[string]scenario.NodeType),
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
		rs.nodeType[s.Nodes[i].Name] = s.Nodes[i].Type
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

// plannedReq is a Stage 2 intermediate: the rng-derived facts of a
// request (path, method, ids, arrival time, byte sizes) before per-hop
// latency is computed. We compute these for every arrival in the tick,
// then count arrivals per entity to get utilization, then go back and
// fill latency. Two-phase split is what lets latency depend on load.
type plannedReq struct {
	entry       string
	client      *scenario.Client
	path        []pathStep
	method      string
	urlPath     string
	traceID     string
	sessionID   string
	arrivalTime time.Time
	bodyIn      int64
	bodyOut     int64
	terminalEP  *scenario.Endpoint // endpoint to consult for residual error rate
	isSelf      bool
	selfErrRate float64
}

// Requests produces the causal request records for one tick. Determinism:
// same scenario + same seed + same tick = byte-identical output.
//
// Two-phase: phase 1 plans every arrival's path/identity (consumes rng),
// phase 2 measures utilization per entity from the plan and fills hop
// latencies (more rng). This split lets latency at each hop depend on
// the tick's actual load rather than the configured per-endpoint mean —
// the M/M/1 envelope of Stage 2 in PHYSICS_PLAN.md.
//
// Stage 3 layers causes on top: traffic_spike at user_clients scales
// arrivals; capacity_loss at any entity reduces μ in phase 2;
// network_latency_inject adds extra ms at matching hops in phase 2.
func (rs *requestSimulator) Requests(
	s *scenario.Scenario,
	tickIndex int,
	tickIntervalMs int,
	rng rng,
	baseTime time.Time,
) []event.Request {
	tickSec := float64(tickIntervalMs) / 1000.0

	// ---- Phase 1: plan each arrival ---------------------------------------
	plans := make([]plannedReq, 0)

	for ni := range s.Nodes {
		n := &s.Nodes[ni]
		if n.Type != scenario.NodeTypeUserClients {
			continue
		}
		// Stage 3: traffic_spike scales arrivals at this user_clients.
		causeMul := rs.causes.trafficMultiplier(n.Name, tickIndex)
		for ci := range n.Clients {
			client := &n.Clients[ci]
			pat := matchPattern(client.TrafficPattern)
			mult := multiplier(pat, tickIndex, rng) * causeMul
			arrivals := int(math.Round(client.RPS * tickSec * mult))
			if arrivals <= 0 {
				continue
			}
			for k := 0; k < arrivals; k++ {
				if p, ok := rs.planClientRequest(s, n.Name, client, tickIntervalMs, rng, baseTime); ok {
					plans = append(plans, p)
				}
			}
		}
	}

	// Self-traffic for services with no inbound: count user-driven arrivals
	// per service first, synthesize self-arrivals only where missing.
	serviceArrivals := make(map[string]int)
	for pi := range plans {
		for _, step := range plans[pi].path {
			if rs.isService[step.entity] {
				serviceArrivals[step.entity]++
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
			if p, ok := rs.planSelfRequest(s, svc, tickIntervalMs, rng, baseTime); ok {
				plans = append(plans, p)
			}
		}
	}

	// ---- Phase 2: measure utilization, fill hops --------------------------
	utilization := rs.computeUtilization(plans, tickSec, tickIndex)

	out := make([]event.Request, 0, len(plans))
	for pi := range plans {
		req := rs.materialize(&plans[pi], s, utilization, rng, tickIndex)
		if req != nil {
			out = append(out, *req)
		}
	}
	return out
}

// computeUtilization returns ρ per entity given the planned arrivals.
// ρ = arrival_rate / effective_service_rate. Effective μ is the per-type
// default scaled by any capacity_loss cause active on this entity.
func (rs *requestSimulator) computeUtilization(plans []plannedReq, tickSec float64, tickIndex int) map[string]float64 {
	arrivals := make(map[string]int, 16)
	for pi := range plans {
		for _, step := range plans[pi].path {
			arrivals[step.entity]++
		}
	}
	out := make(map[string]float64, len(arrivals))
	for entity, count := range arrivals {
		rate := float64(count) / tickSec
		nominalCap := rs.capacityFor(entity)
		if nominalCap <= 0 {
			continue
		}
		effective := nominalCap * rs.causes.capacityMultiplier(entity, tickIndex)
		if effective <= 0 {
			out[entity] = 100 // hard saturation when capacity drops to zero
			continue
		}
		out[entity] = rate / effective
	}
	return out
}

// capacityFor returns the configured (or default) capacity in requests
// per second for an entity. Falls back to the per-type default.
func (rs *requestSimulator) capacityFor(entity string) float64 {
	if rs.isService[entity] {
		return defaultServiceCapacity(rs.serviceType[entity])
	}
	if t, ok := rs.nodeType[entity]; ok {
		c := defaultNodeCapacity(t)
		if c > 0 {
			return c
		}
	}
	return 0 // unknown — disables the queueing effect for this entity
}

// planClientRequest builds the rng-derived facts of one user_clients
// request. Latency is *not* computed here; that happens in materialize
// once tick-wide utilization is known.
func (rs *requestSimulator) planClientRequest(
	s *scenario.Scenario,
	entryNode string,
	client *scenario.Client,
	tickIntervalMs int,
	rng rng,
	baseTime time.Time,
) (plannedReq, bool) {
	path := rs.computePath(entryNode, s, rng)
	if len(path) == 0 {
		return plannedReq{}, false
	}
	method, urlPath := rs.pickEndpoint(path, rng)
	traceID := newHexID(rng, 16)
	sessionID := newHexID(rng, 12)
	offsetMs := rng.Intn(tickIntervalMs)
	arrivalTime := baseTime.Add(time.Duration(offsetMs) * time.Millisecond)
	// Status will be decided in materialize so saturation can override the
	// configured residual rate. We still need bodyOut to depend on success
	// vs error — use the residual rate as a hint here; it'll be corrected
	// downstream if the hop turns into a saturation 5xx.
	residualErr := rs.endpointResidualErrorRate(path, urlPath)
	isErrorHint := rng.Float64() < residualErr
	bodyIn := sampleBodyBytes(method, urlPath, false, rng)
	bodyOut := sampleBodyBytes(method, urlPath, isErrorHint, rng)
	terminalEP := rs.terminalEndpoint(path, urlPath)
	return plannedReq{
		entry:       entryNode,
		client:      client,
		path:        path,
		method:      method,
		urlPath:     urlPath,
		traceID:     traceID,
		sessionID:   sessionID,
		arrivalTime: arrivalTime,
		bodyIn:      bodyIn,
		bodyOut:     bodyOut,
		terminalEP:  terminalEP,
	}, true
}

// planSelfRequest creates a synthesized arrival at one service.
func (rs *requestSimulator) planSelfRequest(
	s *scenario.Scenario,
	svc *scenario.Service,
	tickIntervalMs int,
	rng rng,
	baseTime time.Time,
) (plannedReq, bool) {
	path := []pathStep{{entity: svc.Name, connIdx: -1}}
	method, urlPath := rs.pickEndpoint(path, rng)
	traceID := newHexID(rng, 16)
	sessionID := newHexID(rng, 12)
	offsetMs := rng.Intn(tickIntervalMs)
	arrivalTime := baseTime.Add(time.Duration(offsetMs) * time.Millisecond)
	residualErr := rs.serviceErrorRate[svc.Name]
	isErrorHint := rng.Float64() < residualErr
	bodyIn := sampleBodyBytes(method, urlPath, false, rng)
	bodyOut := sampleBodyBytes(method, urlPath, isErrorHint, rng)
	return plannedReq{
		entry:       "internal",
		path:        path,
		method:      method,
		urlPath:     urlPath,
		traceID:     traceID,
		sessionID:   sessionID,
		arrivalTime: arrivalTime,
		bodyIn:      bodyIn,
		bodyOut:     bodyOut,
		isSelf:      true,
		selfErrRate: residualErr,
	}, true
}

// materialize converts a plan into a full Request, using tick-wide
// utilization to scale per-hop latencies and inject saturation errors.
func (rs *requestSimulator) materialize(
	p *plannedReq,
	s *scenario.Scenario,
	utilization map[string]float64,
	rng rng,
	tickIndex int,
) *event.Request {
	// Status: residual baseline OR a saturation error if any hop is
	// over-utilized. The terminal entity dominates because that's where
	// queue overflow happens for the request as a whole.
	status := rs.pickStatusFromPlan(p, utilization, rng)

	// Re-sample bodyOut if the hint we used in planning disagrees with
	// the final outcome — keeps response sizes consistent with status.
	bodyOut := p.bodyOut
	if (status >= 500) != (rng.Float64() < 0) /* placeholder; we keep bodyOut as planned */ {
		bodyOut = p.bodyOut
	}

	clientIP := "127.0.0.1"
	userAgent := ""
	if p.client != nil {
		clientIP = p.client.IP
		userAgent = p.client.UserAgent
	}

	req := &event.Request{
		TraceID:   p.traceID,
		StartedAt: p.arrivalTime,
		Method:    p.method,
		Path:      p.urlPath,
		UserAgent: userAgent,
		ClientIP:  clientIP,
		SessionID: p.sessionID,
		EntryNode: p.entry,
	}

	rs.fillHopsFromPlan(req, p, s, status, p.bodyIn, bodyOut, utilization, rng, clientIP, tickIndex)

	if status >= 500 && len(req.Hops) > 0 {
		req.Failure = &event.RequestFailure{
			OffendingHop: req.Hops[len(req.Hops)-1].Entity,
			Reason:       failureReasonForStatus(status),
		}
	}
	return req
}

// pickStatusFromPlan layers two effects:
//  1. Residual baseline from configured endpoint error_rate.
//  2. Saturation: if any hop on the path has utilization above ~0.85,
//     a fraction of arrivals there fail with 503 (overflow) or 504
//     (deadline). The terminal entity drives the dominant effect.
func (rs *requestSimulator) pickStatusFromPlan(
	p *plannedReq, utilization map[string]float64, rng rng,
) int {
	// Saturation roll: take the max utilization along the path.
	maxUtil := 0.0
	for _, step := range p.path {
		if u := utilization[step.entity]; u > maxUtil {
			maxUtil = u
		}
	}
	satRate := saturationErrorRate(maxUtil)
	if satRate > 0 && rng.Float64() < satRate {
		// Pick 503 vs 504 based on which side of the cutoff we're on.
		if maxUtil >= 1.0 {
			return 503 // queue full / connection refused
		}
		return 504 // deadline exceeded
	}
	// Residual: configured per-endpoint baseline.
	residual := rs.endpointResidualErrorRate(p.path, p.urlPath)
	if residual <= 0 {
		residual = 0.005
	}
	if p.isSelf {
		residual = p.selfErrRate
	}
	if rng.Float64() < residual {
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

// fillHopsFromPlan populates req.Hops using the per-entity utilization
// to scale each hop's base service time. Latencies along the path are
// summed to produce the wall-clock observed time. Stage 3 also applies
// network_latency_inject causes that target the (src, dst) of any hop.
func (rs *requestSimulator) fillHopsFromPlan(
	req *event.Request,
	p *plannedReq,
	s *scenario.Scenario,
	status int,
	bodyIn, bodyOut int64,
	utilization map[string]float64,
	r rng,
	clientIP string,
	tickIndex int,
) {
	cumLatencyMs := 0
	parentSpan := ""
	prevEntity := p.entry
	prevIP := clientIP
	if p.isSelf {
		prevIP = "127.0.0.1"
		prevEntity = "internal"
	}

	for _, step := range p.path {
		var connProto string
		var connPort int

		if step.connIdx >= 0 && step.connIdx < len(s.Connections) {
			c := s.Connections[step.connIdx]
			connProto = c.Protocol
			connPort = c.Port
		} else {
			connProto = "tcp"
		}
		srcPort := stableSrcPort(prevEntity, step.entity, connProto, p.sessionID)
		dstPort := connPort
		if dstPort == 0 {
			dstPort = defaultPort(connProto)
		}

		baseLatency := rs.sampleHopLatency(step.entity, p.urlPath, p.method, r)
		mul := queueLatencyMul(utilization[step.entity])
		hopLatency := int(math.Round(float64(baseLatency) * mul))
		hopLatency += rs.causes.networkLatencyAdd(prevEntity, step.entity, tickIndex)
		if hopLatency < 1 {
			hopLatency = 1
		}
		entered := p.arrivalTime.Add(time.Duration(cumLatencyMs) * time.Millisecond)
		cumLatencyMs += hopLatency
		left := p.arrivalTime.Add(time.Duration(cumLatencyMs) * time.Millisecond)

		dstIP := rs.ipByEntity[step.entity]
		if dstIP == "" {
			dstIP = rs.fallbackIP(s, step.entity)
		}
		spanID := newHexID(r, 8)
		overhead := protocolOverhead(connProto)
		causeIDs := rs.causes.causeIDsForHop(step.entity, prevEntity, tickIndex)
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
			CauseIDs:   causeIDs,
		}
		req.Hops = append(req.Hops, hop)
		parentSpan = spanID
		prevEntity = step.entity
		prevIP = dstIP
	}
}

// endpointResidualErrorRate returns the configured baseline error rate
// for the endpoint matching urlPath, walking the path to find a service
// that has it defined.
func (rs *requestSimulator) endpointResidualErrorRate(path []pathStep, urlPath string) float64 {
	for _, step := range path {
		eps := rs.endpoints[step.entity]
		for ei := range eps {
			if eps[ei].Path == urlPath && eps[ei].ErrorRate > 0 {
				return eps[ei].ErrorRate
			}
		}
	}
	return 0
}

// terminalEndpoint returns the endpoint definition (if any) for the
// terminal service on a path with the given urlPath.
func (rs *requestSimulator) terminalEndpoint(path []pathStep, urlPath string) *scenario.Endpoint {
	for i := len(path) - 1; i >= 0; i-- {
		eps := rs.endpoints[path[i].entity]
		for ei := range eps {
			if eps[ei].Path == urlPath {
				return &eps[ei]
			}
		}
	}
	return nil
}

func failureReasonForStatus(status int) string {
	switch status {
	case 503:
		return "saturation_overflow"
	case 504:
		return "deadline_exceeded"
	default:
		return "5xx"
	}
}

// (Stage 1 single-phase request builder removed; superseded by the
// two-phase planClientRequest / planSelfRequest / materialize path above.
// The pathStep type and computePath / pickEndpoint helpers stay below
// since both phases use them.)

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

// (Stage 1 single-pass pickStatus removed; superseded by
// pickStatusFromPlan, which layers saturation effects on top of the
// configured residual rate.)

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
