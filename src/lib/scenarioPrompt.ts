'use client'
import type { AIProviderConfig } from '@/types/aiKeys'
import type { ScenarioNode, NodeType, ServiceType, NodeConfig, Provider } from '@/types/nodes'
import type { Connection, Protocol } from '@/types/connections'
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

// ── Schema we ask the model to produce ────────────────────────────────────────

interface ProposedNode {
  /** Stable identifier used to reference this node in `parent` and edges. */
  id: string
  type: NodeType
  serviceType?: ServiceType
  label?: string
  /** Either an `id` from the same response, or null/undefined for top-level. */
  parent?: string | null
  /** Free-form notes that become a hint in the node's config (optional). */
  notes?: string
}

interface ProposedEdge {
  source: string
  target: string
  protocol?: Protocol
  port?: number
  trafficRate?: number
  trafficPattern?: 'steady' | 'bursty' | 'diurnal' | 'incident'
  errorRate?: number
}

interface ProposedScenario {
  name?: string
  description?: string
  nodes: ProposedNode[]
  edges?: ProposedEdge[]
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You translate natural-language descriptions of cloud architectures into a strict JSON scenario for the LogSim canvas editor.

LogSim models a layered topology:
  - "vpc" containers hold "subnet" containers
  - "subnet" containers hold "virtual_server" containers and/or "service" leaves
  - "virtual_server" containers hold "service" leaves
  - "service" nodes also have a "serviceType": one of nodejs | golang | postgres | mysql | redis | nginx | custom

Edges connect any two nodes (typically service-to-service or service-to-database) and represent traffic between them.

Respond with ONE JSON object and nothing else. No prose, no markdown fences. Schema:
{
  "name": "Short scenario name",
  "description": "One-sentence summary",
  "nodes": [
    {
      "id": "vpc-prod",          // unique within this response
      "type": "vpc",             // one of: vpc | subnet | virtual_server | service
      "serviceType": "postgres",  // ONLY when type="service". one of: nodejs | golang | postgres | mysql | redis | nginx | custom
      "label": "prod-vpc",        // short human label
      "parent": null,             // id of the parent container, or null for top-level
      "notes": "optional"
    }
  ],
  "edges": [
    {
      "source": "svc-api",       // node id
      "target": "svc-db",        // node id
      "protocol": "tcp",         // tcp | udp | icmp | http | https | grpc
      "port": 5432,               // 1..65535
      "trafficRate": 50,          // requests per second; 1..1000
      "trafficPattern": "steady", // steady | bursty | diurnal | incident
      "errorRate": 0.01           // 0..1
    }
  ]
}

Rules:
  - Always include at least one VPC. Place subnets inside the VPC, not at top level.
  - Use realistic labels (e.g. "api-gateway", "user-db", "cache").
  - Choose sensible default ports (postgres:5432, mysql:3306, redis:6379, nginx:80, services:8080).
  - Keep the topology compact: 1 VPC, 1-3 subnets, 2-8 services unless the user asks for more.
  - Every node id must be unique. Every "parent", "source", "target" must reference an id present in "nodes".
  - Output ONLY the JSON object. Do not wrap it in code fences.`

function buildUserPrompt(description: string): string {
  return `Describe the following architecture as a LogSim scenario JSON, following the system schema exactly:\n\n${description.trim()}`
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface GenerateScenarioResult {
  flowNodes: ScenarioFlowNode[]
  flowEdges: ConnectionFlowEdge[]
  name?: string
  description?: string
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
    maxTokens: 2048,
    jsonMode: true,
    signal: options.signal,
  })

  const proposed = parseProposedScenario(completion.text)
  return materializeScenario(proposed)
}

// ── Parser ───────────────────────────────────────────────────────────────────

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim()
  // Strip ```json ... ``` fences if the model returned them despite instructions.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) return fenceMatch[1].trim()
  // Otherwise pull the first {...} balanced span.
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
        trafficPattern: ['steady', 'bursty', 'diurnal', 'incident'].includes(edge.trafficPattern as string)
          ? (edge.trafficPattern as ProposedEdge['trafficPattern'])
          : undefined,
        errorRate: typeof edge.errorRate === 'number' ? edge.errorRate : undefined,
      })
    }
  }

  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    nodes,
    edges,
  }
}

// ── Materializer (proposed → ScenarioFlowNode/ConnectionFlowEdge) ────────────

interface MaterializedNode extends ScenarioNode {
  /** Original id used by the LLM, kept so we can resolve edges by it. */
  __aiId?: string
}

const PADDING = 24
const SUBNET_GAP = 30
const VS_GAP = 24
const SERVICE_GAP = 16

function materializeScenario(proposed: ProposedScenario): GenerateScenarioResult {
  // Map from AI id → real generated id.
  const idMap = new Map<string, string>()
  for (const n of proposed.nodes) idMap.set(n.id, generateId())

  // Build a parent → children index for layout.
  const childrenByParent = new Map<string | null, ProposedNode[]>()
  for (const n of proposed.nodes) {
    const pid = n.parent && idMap.has(n.parent) ? n.parent : null
    const arr = childrenByParent.get(pid) ?? []
    arr.push(n)
    childrenByParent.set(pid, arr)
  }

  // Compute size + position recursively. Returns pixel size of the laid-out node.
  // Positions are RELATIVE to the parent (React Flow handles nested coords).
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

    // Layout strategy:
    //  - vpc      → tile its subnets in a horizontal row (wraps every 2)
    //  - subnet   → stack virtual_servers/services vertically
    //  - vserver  → tile services horizontally
    let cursorX = PADDING
    let cursorY = PADDING + 28 // header strip
    let rowHeight = 0
    let maxWidth = 0
    const gap = node.type === 'vpc' ? SUBNET_GAP : node.type === 'subnet' ? VS_GAP : SERVICE_GAP

    if (node.type === 'subnet') {
      // vertical stack
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

    // vpc + virtual_server: horizontal row that wraps every WRAP children
    const WRAP = node.type === 'vpc' ? 2 : 3
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

  // Build the actual ScenarioNode list using the layout.
  const scenarioNodes: MaterializedNode[] = []
  function emit(layout: Layout, parentId: string | null) {
    const proposedNode = proposed.nodes.find(n => n.id === layout.aiId)!
    const realId = idMap.get(layout.aiId)!
    const baseLabel = proposedNode.label?.trim() || (proposedNode.serviceType ?? proposedNode.type)
    const config = getDefaultConfig(proposedNode.type, proposedNode.serviceType)
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

  const withChannels = recomputeAllChannels(scenarioNodes)

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

  // Build flow edges
  const proposedEdges = proposed.edges ?? []
  const flowEdges: ConnectionFlowEdge[] = []
  for (const pe of proposedEdges) {
    const sourceId = idMap.get(pe.source)
    const targetId = idMap.get(pe.target)
    if (!sourceId || !targetId) continue

    const conn: Connection = {
      id: generateId(),
      sourceId,
      targetId,
      protocol: pe.protocol ?? 'tcp',
      port: typeof pe.port === 'number' ? Math.max(1, Math.min(65535, Math.round(pe.port))) : 80,
      trafficPattern: pe.trafficPattern ?? 'steady',
      trafficRate: typeof pe.trafficRate === 'number' ? Math.max(1, Math.min(10000, pe.trafficRate)) : 10,
      errorRate: typeof pe.errorRate === 'number' ? Math.max(0, Math.min(1, pe.errorRate)) : 0,
      config: {},
    }
    flowEdges.push({
      id: conn.id,
      source: conn.sourceId,
      target: conn.targetId,
      type: 'connectionEdge',
      data: asFlowEdgeData(conn),
      label: conn.protocol.toUpperCase(),
      reconnectable: true,
      zIndex: 1000,
    })
  }

  return {
    flowNodes,
    flowEdges,
    name: proposed.name,
    description: proposed.description,
  }
}
