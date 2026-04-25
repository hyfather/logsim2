'use client'
import type { AIProviderConfig } from '@/types/aiKeys'
import type { ScenarioNode, NodeType, ServiceType, NodeConfig, Provider } from '@/types/nodes'
import type { Connection, Protocol, AnchorHandleId } from '@/types/connections'
import type { ScenarioFlowNode, ConnectionFlowEdge } from '@/types/flow'
import { complete } from '@/lib/aiClient'
import { generateId } from '@/lib/id'
import { getDefaultConfig } from '@/registry/nodeRegistry'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'
import { recomputeAllChannels } from '@/engine/channels/ChannelManager'
import { asFlowNodeData, asFlowEdgeData } from '@/lib/flow-data'
import { getDefaultNodeEmoji } from '@/lib/nodeAppearance'

const VALID_NODE_TYPES: NodeType[] = ['vpc', 'subnet', 'virtual_server', 'service']
const VALID_SERVICE_TYPES: ServiceType[] = ['nodejs', 'golang', 'postgres', 'mysql', 'redis', 'nginx', 'custom']
const VALID_PROTOCOLS: Protocol[] = ['tcp', 'udp', 'icmp', 'http', 'https', 'grpc']
const VALID_PATTERNS = ['steady', 'bursty', 'diurnal', 'incident'] as const
type TrafficPattern = typeof VALID_PATTERNS[number]

// ── Schema we ask the model to produce ────────────────────────────────────────

interface ProposedNode {
  id: string
  type: NodeType
  serviceType?: ServiceType
  label?: string
  parent?: string | null
  notes?: string
}

interface ProposedEdge {
  source: string
  target: string
  protocol?: Protocol
  port?: number
  trafficRate?: number
  trafficPattern?: TrafficPattern
  errorRate?: number
}

interface ProposedScenario {
  name?: string
  description?: string
  reasoning?: string
  nodes: ProposedNode[]
  edges?: ProposedEdge[]
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You translate a natural-language description of cloud architecture into a strict JSON scenario for the LogSim canvas editor.

LogSim is an **observability and security simulation environment**. Scenarios you generate become live systems that emit realistic infrastructure logs, network flows, traffic patterns, and (optionally) attack signals so engineers can practice detection, response, and analysis. Your goal is to produce a scenario that is **realistic enough to generate interesting telemetry** — not the bare minimum the user literally typed.

═══════════════════════════════════════════════════════════════════════════
TOPOLOGY MODEL (strict)
═══════════════════════════════════════════════════════════════════════════

  vpc            → top-level network boundary
    └ subnet     → network segment (must be inside a vpc)
        ├ service          ← default placement for processes/daemons
        └ virtual_server   ← OPT-IN host (EC2/VM)
            └ service       ← only when user explicitly mentioned hosts

Service types (pick one when type="service"):
  nodejs | golang | postgres | mysql | redis | nginx | custom

Edges connect two nodes. Almost always service ↔ service. They represent traffic.

═══════════════════════════════════════════════════════════════════════════
RESPONSE FORMAT — return ONE JSON object, no prose, no markdown fences.
═══════════════════════════════════════════════════════════════════════════

{
  "name": "Short scenario name (≤60 chars)",
  "description": "One-sentence summary of intent and traffic flow.",
  "reasoning": "1-3 short sentences: which infra you implied, why N edges, why public/private split, etc.",
  "nodes": [
    {
      "id": "stable-id-unique-in-this-response",
      "type": "vpc" | "subnet" | "virtual_server" | "service",
      "serviceType": "nodejs|golang|postgres|mysql|redis|nginx|custom",  // ONLY when type="service"
      "label": "kebab-case role label (e.g. api-gateway, user-db, edge-lb)",
      "parent": "<id of parent container>",                               // null only for vpc
      "notes": "free-form purpose, e.g. 'fronts external HTTPS' or 'stores user records'"
    }
  ],
  "edges": [
    {
      "source": "<node id>",
      "target": "<node id>",
      "protocol": "tcp|udp|icmp|http|https|grpc",
      "port": 1..65535,
      "trafficRate": 1..1000,                          // requests/sec — pick realistically per role
      "trafficPattern": "steady|bursty|diurnal|incident",
      "errorRate": 0..0.2                               // typically 0.001–0.03
    }
  ]
}

═══════════════════════════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════════════════════════

1. STRUCTURE
   • Always include at least one VPC. Subnets always have a VPC parent.
   • Default placement: \`service\` directly inside \`subnet\`. NO virtual_server in between.
   • Add \`virtual_server\` ONLY when the user explicitly says: EC2, VM, virtual machine, host, instance, hardware, machine, "running on a server".
   • Multiple environments mentioned (prod + staging) → multiple VPCs.

2. CARDINALITY (CRITICAL — most common mistake)
   • "two go app servers" → create exactly 2 service nodes.
   • If N services all "hit" / "talk to" / "connect to" / "use" the same target → emit N separate edges (one per source). NEVER collapse to one edge.
   • Load balancer in front of N services → 1 edge clients→LB plus N edges LB→service-i.

3. IMPLIED INFRASTRUCTURE — fill in what an experienced engineer would add
   • 2+ same-role app services, OR mention of "production" / "load" / "users hit" → add an \`nginx\` service in front as the load balancer/reverse proxy. Place it in a public subnet.
   • External traffic implied (public API, web app, "users", "internet") → split topology into \`public-subnet\` (ingress like nginx) and \`app-subnet\` / \`data-subnet\` (private). Apps and DBs in private subnets.
   • A database or cache in a public subnet is wrong. Always private.
   • Do NOT invent services unrelated to what the user described — only fill obvious gaps.

4. CANONICAL PORTS & PROTOCOLS (use these unless overridden)
     postgres   5432  tcp           mysql      3306  tcp
     redis      6379  tcp           nginx HTTP   80  http
     nginx TLS   443  https         nodejs     3000  http
     golang     8080  http          internal RPC 50051 grpc
   Use \`http\`/\`https\` for L7 service↔service traffic; \`tcp\` for DB/cache.

5. TRAFFIC REALISM — every edge MUST set all five edge fields. Pick numbers that make telemetry interesting:
     clients → ingress (nginx):   trafficRate 50–200,  pattern "diurnal" or "bursty",  errorRate 0.005–0.02
     ingress → app:                trafficRate 50–150,  pattern "steady",               errorRate 0.002–0.01
     app → primary DB:             trafficRate 20–80,   pattern "steady",               errorRate 0.0005–0.005
     app → cache:                  trafficRate 100–400, pattern "steady",               errorRate 0.0001–0.001
     app → app (internal RPC):     trafficRate 30–120,  pattern "steady",               errorRate 0.001–0.005
   • If user mentions "burst"/"spike" → use "bursty" on the relevant edge.
   • If user mentions "incident"/"outage"/"5xx storm" → use "incident" pattern AND bump errorRate to 0.05–0.2 ONLY on the affected edge(s).
   • If user mentions diurnal traffic / business-hours → "diurnal" on the ingress edge.

6. NAMING CONVENTIONS
   • Labels are kebab-case role names: \`api-gateway\`, \`user-db\`, \`session-cache\`, \`edge-lb\`, \`payments-api\`. NOT \`vm-1\` / \`server01\`.
   • VPC label includes environment if the user mentioned one: \`prod-vpc\`, \`staging-vpc\`, \`dev-vpc\`.
   • Subnet label describes the tier: \`public-subnet\`, \`app-subnet\`, \`data-subnet\`. (NOT just \`subnet-1\`.)
   • IDs (the \`id\` field) can be short and stable, like \`vpc\`, \`pubnet\`, \`api1\`, \`db\`. They never appear in the UI.

7. NOTES
   For services with non-obvious purpose, fill \`notes\` with one short sentence about what the service does. Future log generators read this for realism.

8. SIZE
   Keep it focused. Prefer 1 VPC, 1–3 subnets, 2–10 services unless the user explicitly asks for more.

═══════════════════════════════════════════════════════════════════════════
WORKED EXAMPLES — STUDY THESE BEFORE GENERATING
═══════════════════════════════════════════════════════════════════════════

────────────────────────────────────────────────────────────────────────
INPUT: "A production VPC with two Go app servers hitting a MySQL"

OUTPUT:
{
  "name": "Prod Go API on MySQL",
  "description": "Two Go API instances behind an Nginx load balancer, both writing to a primary MySQL.",
  "reasoning": "User said 'production' and '2 app servers' → added Nginx LB in a public subnet and split private app/data subnets. Two edges from LB→APIs and two edges from APIs→DB to preserve cardinality.",
  "nodes": [
    { "id": "vpc",      "type": "vpc",     "label": "prod-vpc",       "parent": null },
    { "id": "pubnet",   "type": "subnet",  "label": "public-subnet",  "parent": "vpc" },
    { "id": "appnet",   "type": "subnet",  "label": "app-subnet",     "parent": "vpc" },
    { "id": "datanet",  "type": "subnet",  "label": "data-subnet",    "parent": "vpc" },
    { "id": "lb",       "type": "service", "serviceType": "nginx",  "label": "edge-lb",  "parent": "pubnet",  "notes": "Fronts external HTTPS, load-balances to Go APIs." },
    { "id": "api1",     "type": "service", "serviceType": "golang", "label": "api-1",    "parent": "appnet",  "notes": "Stateless Go API." },
    { "id": "api2",     "type": "service", "serviceType": "golang", "label": "api-2",    "parent": "appnet",  "notes": "Stateless Go API." },
    { "id": "db",       "type": "service", "serviceType": "mysql",  "label": "user-db",  "parent": "datanet", "notes": "Primary user data store." }
  ],
  "edges": [
    { "source": "lb",   "target": "api1", "protocol": "http", "port": 8080, "trafficRate": 80, "trafficPattern": "steady",  "errorRate": 0.005 },
    { "source": "lb",   "target": "api2", "protocol": "http", "port": 8080, "trafficRate": 80, "trafficPattern": "steady",  "errorRate": 0.005 },
    { "source": "api1", "target": "db",   "protocol": "tcp",  "port": 3306, "trafficRate": 40, "trafficPattern": "steady",  "errorRate": 0.001 },
    { "source": "api2", "target": "db",   "protocol": "tcp",  "port": 3306, "trafficRate": 40, "trafficPattern": "steady",  "errorRate": 0.001 }
  ]
}

────────────────────────────────────────────────────────────────────────
INPUT: "One Node.js API connected to Postgres and Redis"

OUTPUT:
{
  "name": "Single API + Postgres + Redis",
  "description": "One Node.js API talking to Postgres for persistence and Redis for cache.",
  "reasoning": "No production / external traffic mentioned → no LB, single subnet, services placed directly in subnet (no virtual_server wrapper).",
  "nodes": [
    { "id": "vpc", "type": "vpc",    "label": "dev-vpc",    "parent": null },
    { "id": "net", "type": "subnet", "label": "app-subnet", "parent": "vpc" },
    { "id": "api", "type": "service", "serviceType": "nodejs",   "label": "api",            "parent": "net" },
    { "id": "pg",  "type": "service", "serviceType": "postgres", "label": "app-db",         "parent": "net", "notes": "Primary relational store." },
    { "id": "rd",  "type": "service", "serviceType": "redis",    "label": "session-cache",  "parent": "net", "notes": "Hot-key session cache." }
  ],
  "edges": [
    { "source": "api", "target": "pg", "protocol": "tcp", "port": 5432, "trafficRate": 30,  "trafficPattern": "steady", "errorRate": 0.001 },
    { "source": "api", "target": "rd", "protocol": "tcp", "port": 6379, "trafficRate": 200, "trafficPattern": "steady", "errorRate": 0.0005 }
  ]
}

────────────────────────────────────────────────────────────────────────
INPUT: "Three EC2 instances each running a Node service, all talking to a Postgres on its own EC2"

OUTPUT (note: user said "EC2" → wrap services in virtual_servers):
{
  "name": "Node fleet on EC2 + Postgres",
  "description": "Three Node.js services on EC2 instances all reading/writing to a Postgres on a dedicated EC2.",
  "reasoning": "User explicitly said EC2 → used virtual_server wrappers. No LB because user did not mention production or external traffic.",
  "nodes": [
    { "id": "vpc",   "type": "vpc",     "label": "vpc",        "parent": null },
    { "id": "net",   "type": "subnet",  "label": "app-subnet", "parent": "vpc" },
    { "id": "ec2-1", "type": "virtual_server", "label": "node-host-1", "parent": "net" },
    { "id": "ec2-2", "type": "virtual_server", "label": "node-host-2", "parent": "net" },
    { "id": "ec2-3", "type": "virtual_server", "label": "node-host-3", "parent": "net" },
    { "id": "ec2-db","type": "virtual_server", "label": "db-host",     "parent": "net" },
    { "id": "svc1",  "type": "service", "serviceType": "nodejs",   "label": "node-1", "parent": "ec2-1" },
    { "id": "svc2",  "type": "service", "serviceType": "nodejs",   "label": "node-2", "parent": "ec2-2" },
    { "id": "svc3",  "type": "service", "serviceType": "nodejs",   "label": "node-3", "parent": "ec2-3" },
    { "id": "pg",    "type": "service", "serviceType": "postgres", "label": "app-db", "parent": "ec2-db" }
  ],
  "edges": [
    { "source": "svc1", "target": "pg", "protocol": "tcp", "port": 5432, "trafficRate": 30, "trafficPattern": "steady", "errorRate": 0.001 },
    { "source": "svc2", "target": "pg", "protocol": "tcp", "port": 5432, "trafficRate": 30, "trafficPattern": "steady", "errorRate": 0.001 },
    { "source": "svc3", "target": "pg", "protocol": "tcp", "port": 5432, "trafficRate": 30, "trafficPattern": "steady", "errorRate": 0.001 }
  ]
}

═══════════════════════════════════════════════════════════════════════════
Output the JSON object only. No prose, no markdown fences, no commentary.`

function buildUserPrompt(description: string): string {
  return `Convert the following architecture description into a LogSim scenario JSON, following the system schema and rules exactly. Apply the cardinality and implied-infrastructure rules. Fill every required edge field.

Description:
${description.trim()}`
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface GenerateScenarioResult {
  flowNodes: ScenarioFlowNode[]
  flowEdges: ConnectionFlowEdge[]
  name?: string
  description?: string
  reasoning?: string
}

export async function generateScenarioFromDescription(
  config: AIProviderConfig,
  description: string,
  options: { signal?: AbortSignal } = {},
): Promise<GenerateScenarioResult> {
  const completion = await complete(config, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(description) },
    ],
    maxTokens: 4096,
    jsonMode: true,
    signal: options.signal,
  })

  const proposed = parseProposedScenario(completion.text)
  const cleaned = postProcessProposedScenario(proposed, description)
  return materializeScenario(cleaned)
}

// ── Parser ───────────────────────────────────────────────────────────────────

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) return fenceMatch[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return trimmed
  return trimmed.slice(start, end + 1)
}

function parseProposedScenario(raw: string): ProposedScenario {
  if (!raw || !raw.trim()) {
    throw new Error('AI returned an empty response.')
  }
  const jsonText = extractJsonBlock(raw)
  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(`AI response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!data || typeof data !== 'object') {
    throw new Error('AI response was not a JSON object.')
  }
  const obj = data as Record<string, unknown>
  const nodesRaw = obj.nodes
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw new Error('AI response had no "nodes" array.')
  }

  const nodes: ProposedNode[] = []
  for (const n of nodesRaw) {
    if (!n || typeof n !== 'object') continue
    const node = n as Record<string, unknown>
    const id = typeof node.id === 'string' ? node.id : null
    const type = typeof node.type === 'string' ? node.type as NodeType : null
    if (!id || !type || !VALID_NODE_TYPES.includes(type)) continue

    let serviceType: ServiceType | undefined
    if (type === 'service') {
      const st = typeof node.serviceType === 'string' ? node.serviceType as ServiceType : null
      serviceType = st && VALID_SERVICE_TYPES.includes(st) ? st : 'custom'
    }

    nodes.push({
      id,
      type,
      serviceType,
      label: typeof node.label === 'string' ? node.label : undefined,
      parent: typeof node.parent === 'string' ? node.parent : null,
      notes: typeof node.notes === 'string' ? node.notes : undefined,
    })
  }

  if (nodes.length === 0) {
    throw new Error('AI response did not include any valid nodes.')
  }

  const edges: ProposedEdge[] = []
  if (Array.isArray(obj.edges)) {
    for (const e of obj.edges) {
      if (!e || typeof e !== 'object') continue
      const edge = e as Record<string, unknown>
      const source = typeof edge.source === 'string' ? edge.source : null
      const target = typeof edge.target === 'string' ? edge.target : null
      if (!source || !target) continue
      const protocol = typeof edge.protocol === 'string' && VALID_PROTOCOLS.includes(edge.protocol as Protocol)
        ? edge.protocol as Protocol
        : 'tcp'
      edges.push({
        source,
        target,
        protocol,
        port: typeof edge.port === 'number' ? edge.port : undefined,
        trafficRate: typeof edge.trafficRate === 'number' ? edge.trafficRate : undefined,
        trafficPattern: VALID_PATTERNS.includes(edge.trafficPattern as TrafficPattern)
          ? (edge.trafficPattern as TrafficPattern)
          : undefined,
        errorRate: typeof edge.errorRate === 'number' ? edge.errorRate : undefined,
      })
    }
  }

  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
    nodes,
    edges,
  }
}

// ── Post-process: lift services out of unwanted virtual_servers ──────────────

const HOST_TRIGGER_RE = /\b(ec2|vm|virtual\s*machine|instance|host|hardware|bare[\s-]?metal|machine|server\s+(box|hardware))\b/i

function postProcessProposedScenario(scenario: ProposedScenario, userDescription: string): ProposedScenario {
  const userMentionedHosts = HOST_TRIGGER_RE.test(userDescription)
  if (userMentionedHosts) return scenario // model is allowed to use virtual_servers freely

  // Build child index
  const childrenByParent = new Map<string, ProposedNode[]>()
  for (const n of scenario.nodes) {
    if (n.parent) {
      const arr = childrenByParent.get(n.parent) ?? []
      arr.push(n)
      childrenByParent.set(n.parent, arr)
    }
  }

  // Find virtual_servers we want to drop. We drop a VS only if ALL its children are services
  // (otherwise structure is more complex and we leave it alone).
  const idsToDrop = new Set<string>()
  for (const n of scenario.nodes) {
    if (n.type !== 'virtual_server') continue
    const kids = childrenByParent.get(n.id) ?? []
    if (kids.length === 0) {
      idsToDrop.add(n.id)
      continue
    }
    if (kids.every(k => k.type === 'service')) {
      idsToDrop.add(n.id)
    }
  }
  if (idsToDrop.size === 0) return scenario

  // Build map: dropped VS id → its parent (the subnet)
  const reparent = new Map<string, string | null>()
  for (const droppedId of idsToDrop) {
    const vs = scenario.nodes.find(n => n.id === droppedId)
    reparent.set(droppedId, vs?.parent ?? null)
  }

  const newNodes: ProposedNode[] = []
  for (const n of scenario.nodes) {
    if (idsToDrop.has(n.id)) continue
    if (n.parent && reparent.has(n.parent)) {
      newNodes.push({ ...n, parent: reparent.get(n.parent) ?? null })
    } else {
      newNodes.push(n)
    }
  }

  return { ...scenario, nodes: newNodes }
}

// ── Materializer (proposed → ScenarioFlowNode/ConnectionFlowEdge) ────────────

interface MaterializedNode extends ScenarioNode {
  __aiId?: string
}

const PADDING = 24
const SUBNET_GAP = 30
const VS_GAP = 24
const SERVICE_GAP = 16

function materializeScenario(proposed: ProposedScenario): GenerateScenarioResult {
  const idMap = new Map<string, string>()
  for (const n of proposed.nodes) idMap.set(n.id, generateId())

  const childrenByParent = new Map<string | null, ProposedNode[]>()
  for (const n of proposed.nodes) {
    const pid = n.parent && idMap.has(n.parent) ? n.parent : null
    const arr = childrenByParent.get(pid) ?? []
    arr.push(n)
    childrenByParent.set(pid, arr)
  }

  // Sort sibling subnets within each VPC by topological tier so traffic flows
  // left-to-right (sources → sinks). This makes 3-tier (public → app → data)
  // lay out as a single horizontal row matching how the user reads the diagram.
  sortSubnetsByTier(proposed, childrenByParent)

  interface Layout {
    aiId: string
    width: number
    height: number
    x: number
    y: number
    children: Layout[]
  }

  function layoutNode(aiId: string, depth: number): Layout {
    const node = proposed.nodes.find(n => n.id === aiId)!
    const kids = (childrenByParent.get(aiId) ?? [])

    if (node.type === 'service') {
      const size = DEFAULT_NODE_SIZES.service
      return { aiId, width: size.width, height: size.height, x: 0, y: 0, children: [] }
    }

    const childLayouts = kids.map(k => layoutNode(k.id, depth + 1))

    if (childLayouts.length === 0) {
      const size = DEFAULT_NODE_SIZES[node.type]
      return { aiId, width: size.width, height: size.height, x: 0, y: 0, children: [] }
    }

    let cursorX = PADDING
    let cursorY = PADDING + 28 // header strip
    let rowHeight = 0
    let maxWidth = 0
    const gap = node.type === 'vpc' ? SUBNET_GAP : node.type === 'subnet' ? VS_GAP : SERVICE_GAP

    if (node.type === 'subnet') {
      for (const c of childLayouts) {
        c.x = PADDING
        c.y = cursorY
        cursorY += c.height + gap
        maxWidth = Math.max(maxWidth, c.width)
      }
      const width = Math.max(DEFAULT_NODE_SIZES.subnet.width, maxWidth + PADDING * 2)
      const height = Math.max(DEFAULT_NODE_SIZES.subnet.height, cursorY + PADDING - gap)
      return { aiId, width, height, x: 0, y: 0, children: childLayouts }
    }

    // Allow up to 4 subnets in a single row before wrapping, so the canonical
    // public→app→data row stays visually horizontal. virtual_servers still
    // wrap aggressively (3 per row) since they nest deeper.
    const WRAP = node.type === 'vpc' ? Math.max(2, Math.min(4, childLayouts.length)) : 3
    let inRow = 0
    for (const c of childLayouts) {
      if (inRow >= WRAP) {
        cursorX = PADDING
        cursorY += rowHeight + gap
        rowHeight = 0
        inRow = 0
      }
      c.x = cursorX
      c.y = cursorY
      cursorX += c.width + gap
      rowHeight = Math.max(rowHeight, c.height)
      maxWidth = Math.max(maxWidth, cursorX - gap)
      inRow++
    }
    const baseSize = DEFAULT_NODE_SIZES[node.type]
    const width = Math.max(baseSize.width, maxWidth + PADDING)
    const height = Math.max(baseSize.height, cursorY + rowHeight + PADDING)
    return { aiId, width, height, x: 0, y: 0, children: childLayouts }
  }

  const topLevel = childrenByParent.get(null) ?? []
  const topLayouts: Layout[] = []
  let topX = 60
  for (const t of topLevel) {
    const l = layoutNode(t.id, 0)
    l.x = topX
    l.y = 60
    topX += l.width + 80
    topLayouts.push(l)
  }

  const scenarioNodes: MaterializedNode[] = []
  function emit(layout: Layout, parentId: string | null) {
    const proposedNode = proposed.nodes.find(n => n.id === layout.aiId)!
    const realId = idMap.get(layout.aiId)!
    const baseLabel = proposedNode.label?.trim() || (proposedNode.serviceType ?? proposedNode.type)
    // Deep-clone the registry default so per-node mutations (CIDR assignment,
    // future config edits) don't bleed across nodes that share a default.
    const config = structuredClone(getDefaultConfig(proposedNode.type, proposedNode.serviceType))
    const provider: Provider = proposedNode.type === 'vpc' ? 'aws' : null

    scenarioNodes.push({
      id: realId,
      type: proposedNode.type,
      serviceType: proposedNode.serviceType,
      emoji: getDefaultNodeEmoji(proposedNode.type, proposedNode.serviceType),
      position: { x: layout.x, y: layout.y },
      size: { width: layout.width, height: layout.height },
      parentId,
      provider,
      channel: '',
      config: config as NodeConfig,
      label: baseLabel,
      __aiId: proposedNode.id,
    })
    for (const c of layout.children) {
      emit(c, realId)
    }
  }
  for (const l of topLayouts) emit(l, null)

  // Give each subnet a unique CIDR so derived per-service IPs don't collide,
  // and label public-facing subnets accordingly. Multiple VPCs get their own /16.
  assignNetworkAddresses(scenarioNodes)

  const withChannels = recomputeAllChannels(scenarioNodes)

  // Build a world-coordinate rect for every node so we can pick edge anchors
  // that don't punch through other nodes.
  const worldRect = computeWorldRects(withChannels)

  // Build flow nodes
  const flowNodes: ScenarioFlowNode[] = withChannels.map(node => {
    const base: ScenarioFlowNode = {
      id: node.id,
      type: node.type,
      position: node.position,
      data: asFlowNodeData(node),
      style: node.size ? { width: node.size.width, height: node.size.height } : {},
    }
    if (node.parentId) {
      base.parentId = node.parentId
      base.extent = 'parent'
    }
    return base
  })

  // Build flow edges with computed anchors
  const proposedEdges = proposed.edges ?? []
  interface EdgeBuild {
    conn: Connection
    sRect: WorldRect
    tRect: WorldRect
  }
  const builds: EdgeBuild[] = []
  for (const pe of proposedEdges) {
    const sourceId = idMap.get(pe.source)
    const targetId = idMap.get(pe.target)
    if (!sourceId || !targetId) continue
    if (sourceId === targetId) continue

    const sRect = worldRect.get(sourceId)
    const tRect = worldRect.get(targetId)
    if (!sRect || !tRect) continue

    const { sourceHandle, targetHandle } = pickAnchors(sRect, tRect)

    const conn: Connection = {
      id: generateId(),
      sourceId,
      targetId,
      sourceHandle,
      targetHandle,
      protocol: pe.protocol ?? 'tcp',
      port: typeof pe.port === 'number' ? Math.max(1, Math.min(65535, Math.round(pe.port))) : 80,
      trafficPattern: pe.trafficPattern ?? 'steady',
      trafficRate: typeof pe.trafficRate === 'number' ? Math.max(1, Math.min(10000, pe.trafficRate)) : 10,
      errorRate: typeof pe.errorRate === 'number' ? Math.max(0, Math.min(1, pe.errorRate)) : 0,
      config: {},
    }
    builds.push({ conn, sRect, tRect })
  }

  // Fan out edges that share an anchor on either end so they don't draw on top of each other.
  fanOverlappingEdges(builds)

  const flowEdges: ConnectionFlowEdge[] = builds.map(b => ({
    id: b.conn.id,
    source: b.conn.sourceId,
    target: b.conn.targetId,
    sourceHandle: b.conn.sourceHandle,
    targetHandle: b.conn.targetHandle,
    type: 'connectionEdge',
    data: asFlowEdgeData(b.conn),
    label: b.conn.protocol.toUpperCase(),
    reconnectable: true,
    zIndex: 1000,
  }))

  return {
    flowNodes,
    flowEdges,
    name: proposed.name,
    description: proposed.description,
    reasoning: proposed.reasoning,
  }
}

// ── Subnet ordering by topological tier ─────────────────────────────────────

const TIER_LABEL_HINTS: Array<{ pattern: RegExp; tier: number }> = [
  { pattern: /\b(public|edge|ingress|dmz|external)\b/i, tier: 0 },
  { pattern: /\b(data|db|database|storage|persistence|private)\b/i, tier: 99 },
]

/**
 * Reorder sibling subnets within each VPC so they flow left-to-right by
 * topological depth: subnets containing source-only services (e.g. an Nginx
 * LB) come first, sinks (e.g. databases) come last. With sensible ordering,
 * default smooth-step edges run cleanly between adjacent tiers instead of
 * looping across siblings.
 *
 * Algorithm: compute per-service depth as the longest path from any source
 * (no incoming edges). Per subnet, take the average service depth — falling
 * back to label hints when a subnet has no edges incident on its services.
 */
function sortSubnetsByTier(
  scenario: ProposedScenario,
  childrenByParent: Map<string | null, ProposedNode[]>,
): void {
  const nodeById = new Map(scenario.nodes.map(n => [n.id, n]))
  const edges = scenario.edges ?? []

  // Build adjacency at the service level. For each edge, walk source/target
  // up to the nearest service ancestor (handles cases where an edge points
  // at a virtual_server wrapper).
  const serviceIds = new Set(scenario.nodes.filter(n => n.type === 'service').map(n => n.id))
  function ascendToService(id: string): string | null {
    let cur: ProposedNode | undefined = nodeById.get(id)
    while (cur) {
      if (cur.type === 'service') return cur.id
      cur = cur.parent ? nodeById.get(cur.parent) : undefined
    }
    return null
  }
  const inDegree = new Map<string, number>()
  const outAdj = new Map<string, string[]>()
  for (const id of serviceIds) {
    inDegree.set(id, 0)
    outAdj.set(id, [])
  }
  for (const e of edges) {
    const s = ascendToService(e.source)
    const t = ascendToService(e.target)
    if (!s || !t || s === t) continue
    outAdj.get(s)!.push(t)
    inDegree.set(t, (inDegree.get(t) ?? 0) + 1)
  }

  // Kahn-style longest-path depth (acyclic assumption; on cycles we cap).
  const depth = new Map<string, number>()
  const queue: string[] = []
  for (const id of serviceIds) {
    if ((inDegree.get(id) ?? 0) === 0) {
      depth.set(id, 0)
      queue.push(id)
    }
  }
  const remaining = new Map(inDegree)
  let guard = serviceIds.size * 4
  while (queue.length && guard-- > 0) {
    const u = queue.shift()!
    const d = depth.get(u) ?? 0
    for (const v of outAdj.get(u) ?? []) {
      depth.set(v, Math.max(depth.get(v) ?? 0, d + 1))
      remaining.set(v, (remaining.get(v) ?? 0) - 1)
      if ((remaining.get(v) ?? 0) === 0) queue.push(v)
    }
  }

  // For each subnet, compute mean depth of contained services (recursing
  // through virtual_server wrappers). Fall back to label hints when there
  // are no services or no edges touch them.
  function servicesUnder(subnetId: string): string[] {
    const out: string[] = []
    const stack = [...(childrenByParent.get(subnetId) ?? [])]
    while (stack.length) {
      const n = stack.pop()!
      if (n.type === 'service') out.push(n.id)
      else stack.push(...(childrenByParent.get(n.id) ?? []))
    }
    return out
  }
  function labelTier(label: string | undefined): number | null {
    if (!label) return null
    for (const { pattern, tier } of TIER_LABEL_HINTS) {
      if (pattern.test(label)) return tier
    }
    return null
  }
  function subnetTier(subnet: ProposedNode): number {
    const services = servicesUnder(subnet.id)
    const depths = services.map(id => depth.get(id)).filter((d): d is number => typeof d === 'number')
    if (depths.length > 0) {
      // Bias by label too — a labelled "data-subnet" with depth 1 should still sink to the right.
      const mean = depths.reduce((a, b) => a + b, 0) / depths.length
      const labelHint = labelTier(subnet.label)
      if (labelHint === 0) return mean - 0.5
      if (labelHint === 99) return mean + 0.5
      return mean
    }
    const hint = labelTier(subnet.label)
    return hint ?? 50 // unknown subnets sit in the middle
  }

  // Sort each VPC's children: subnets first (by tier), then non-subnets.
  for (const [parentId, kids] of childrenByParent) {
    if (!parentId) continue
    const parent = nodeById.get(parentId)
    if (!parent || parent.type !== 'vpc') continue
    kids.sort((a, b) => {
      const aIsSubnet = a.type === 'subnet'
      const bIsSubnet = b.type === 'subnet'
      if (aIsSubnet && !bIsSubnet) return -1
      if (!aIsSubnet && bIsSubnet) return 1
      if (!aIsSubnet && !bIsSubnet) return 0
      return subnetTier(a) - subnetTier(b)
    })
  }
}

// ── Network address assignment ──────────────────────────────────────────────

/**
 * Walk the materialized scenario and:
 *   • give each VPC its own /16 (10.0.0.0/16, 10.1.0.0/16, ...)
 *   • give each subnet within a VPC a unique /24 so derived service IPs don't collide
 *   • mark subnets as public when their label or contained services suggest ingress
 *
 * Service IPs are derived live from subnet CIDR by `lib/network.ts:getNodeIp`,
 * so updating the subnet config here cascades automatically.
 */
function assignNetworkAddresses(nodes: ScenarioNode[]): void {
  const vpcs = nodes.filter(n => n.type === 'vpc')
  vpcs.forEach((vpc, vpcIdx) => {
    const vpcCfg = vpc.config as Record<string, unknown>
    vpcCfg.cidr = `10.${vpcIdx}.0.0/16`

    const subnets = nodes.filter(n => n.parentId === vpc.id && n.type === 'subnet')
    subnets.forEach((subnet, subnetIdx) => {
      const cfg = subnet.config as Record<string, unknown>
      cfg.cidr = `10.${vpcIdx}.${subnetIdx + 1}.0/24`
      cfg.availabilityZone = `us-east-1${String.fromCharCode(97 + (subnetIdx % 6))}`

      const label = (subnet.label || '').toLowerCase()
      const hostsIngress = nodes.some(
        n => n.parentId === subnet.id && n.type === 'service' && n.serviceType === 'nginx',
      )
      cfg.isPublic = label.includes('public') || label.includes('edge') || hostsIngress
    })
  })
}

// ── Edge fan-out ────────────────────────────────────────────────────────────

interface EdgeBuildLike {
  conn: Connection
  sRect: WorldRect
  tRect: WorldRect
}

const HANDLE_AXIS: Record<AnchorHandleId, 'x' | 'y'> = {
  left: 'x', right: 'x', top: 'y', bottom: 'y',
}

/**
 * When N edges share a (sourceId, sourceHandle) or (targetId, targetHandle),
 * their default smooth-step paths trace the same stem before fanning out, so
 * they visually stack. Set `bendX`/`bendY` so each edge's elbow lands at a
 * distinct offset along the handle's parallel axis — this lengthens/shortens
 * the stem from that end and produces a visible fan.
 */
function fanOverlappingEdges(builds: EdgeBuildLike[]): void {
  if (builds.length < 2) return

  const FAN_STEP = 28 // pixels between adjacent fanned edges

  type Off = { dx: number; dy: number }
  const offsets = new Map<EdgeBuildLike, Off>()
  for (const b of builds) offsets.set(b, { dx: 0, dy: 0 })

  function groupBy(keyFn: (b: EdgeBuildLike) => string): Map<string, EdgeBuildLike[]> {
    const m = new Map<string, EdgeBuildLike[]>()
    for (const b of builds) {
      const k = keyFn(b)
      const arr = m.get(k) ?? []
      arr.push(b)
      m.set(k, arr)
    }
    return m
  }

  function applyFan(group: EdgeBuildLike[], handle: AnchorHandleId | undefined, sortKey: 'sourceY' | 'sourceX' | 'targetY' | 'targetX') {
    if (!handle || group.length < 2) return
    const axis = HANDLE_AXIS[handle]
    const sortVal = (b: EdgeBuildLike): number => {
      switch (sortKey) {
        case 'sourceY': return b.sRect.y
        case 'sourceX': return b.sRect.x
        case 'targetY': return b.tRect.y
        case 'targetX': return b.tRect.x
      }
    }
    group.sort((a, b) => sortVal(a) - sortVal(b))
    const center = (group.length - 1) / 2
    group.forEach((e, i) => {
      const delta = (i - center) * FAN_STEP
      const o = offsets.get(e)!
      if (axis === 'x') o.dx += delta
      else o.dy += delta
    })
  }

  // Source-side fan: edges leaving the same point of the same node.
  const srcGroups = groupBy(b => `${b.conn.sourceId}|${b.conn.sourceHandle ?? ''}`)
  for (const group of srcGroups.values()) {
    if (group.length < 2) continue
    const h = group[0].conn.sourceHandle as AnchorHandleId | undefined
    const sortKey = h === 'right' || h === 'left' ? 'targetY' : 'targetX'
    applyFan(group, h, sortKey)
  }

  // Target-side fan: edges arriving at the same point of the same node.
  const tgtGroups = groupBy(b => `${b.conn.targetId}|${b.conn.targetHandle ?? ''}`)
  for (const group of tgtGroups.values()) {
    if (group.length < 2) continue
    const h = group[0].conn.targetHandle as AnchorHandleId | undefined
    const sortKey = h === 'right' || h === 'left' ? 'sourceY' : 'sourceX'
    applyFan(group, h, sortKey)
  }

  // Translate offsets into bendX/bendY relative to the natural midpoint.
  for (const b of builds) {
    const o = offsets.get(b)!
    if (o.dx === 0 && o.dy === 0) continue
    const sCx = b.sRect.x + b.sRect.width / 2
    const sCy = b.sRect.y + b.sRect.height / 2
    const tCx = b.tRect.x + b.tRect.width / 2
    const tCy = b.tRect.y + b.tRect.height / 2
    b.conn.bendX = (sCx + tCx) / 2 + o.dx
    b.conn.bendY = (sCy + tCy) / 2 + o.dy
  }
}

// ── Anchor computation ──────────────────────────────────────────────────────

interface WorldRect { x: number; y: number; width: number; height: number }

function computeWorldRects(nodes: ScenarioNode[]): Map<string, WorldRect> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const cache = new Map<string, WorldRect>()
  function world(id: string): WorldRect {
    const cached = cache.get(id)
    if (cached) return cached
    const n = byId.get(id)
    if (!n) {
      const empty = { x: 0, y: 0, width: 0, height: 0 }
      cache.set(id, empty)
      return empty
    }
    const w = n.size?.width ?? DEFAULT_NODE_SIZES[n.type].width
    const h = n.size?.height ?? DEFAULT_NODE_SIZES[n.type].height
    if (!n.parentId) {
      const r = { x: n.position.x, y: n.position.y, width: w, height: h }
      cache.set(id, r)
      return r
    }
    const parent = world(n.parentId)
    const r = { x: parent.x + n.position.x, y: parent.y + n.position.y, width: w, height: h }
    cache.set(id, r)
    return r
  }
  for (const n of nodes) world(n.id)
  return cache
}

/**
 * Pick source/target handles for an edge based on the relative geometry of the
 * two world rects. Goal: avoid drawing a straight line through a sibling node
 * by using the side of each rect that faces the other rect.
 */
function pickAnchors(s: WorldRect, t: WorldRect): { sourceHandle: AnchorHandleId; targetHandle: AnchorHandleId } {
  const sCx = s.x + s.width / 2
  const sCy = s.y + s.height / 2
  const tCx = t.x + t.width / 2
  const tCy = t.y + t.height / 2
  const dx = tCx - sCx
  const dy = tCy - sCy

  // Use a small bias so near-equal dx/dy still picks a deterministic axis.
  if (Math.abs(dy) > Math.abs(dx) * 1.05) {
    // Vertical relationship.
    return dy > 0
      ? { sourceHandle: 'bottom', targetHandle: 'top' }
      : { sourceHandle: 'top', targetHandle: 'bottom' }
  }
  // Horizontal relationship.
  return dx > 0
    ? { sourceHandle: 'right', targetHandle: 'left' }
    : { sourceHandle: 'left', targetHandle: 'right' }
}
