import yaml from 'js-yaml'
import type { FlowNode, FlowEdge } from '@/store/useScenarioStore'
import type { ScenarioNode, ServiceType } from '@/types/nodes'
import type { ScenarioMetadata } from '@/types/scenario'
import type { CustomNodeType, CustomLogTemplate, PlaceholderSpec } from '@/types/customNodeType'
import type { Episode } from '@/types/episode'

interface YamlNode {
  type: string
  name: string
  description?: string
  provider?: string
  region?: string
  cidr_block?: string
  instance_type?: string
  os?: string
  private_ip?: string
  subnet?: string
}

interface YamlEndpoint {
  method: string
  path: string
  avg_latency_ms: number
  error_rate: number
}

interface YamlGenerator {
  type: string
  port?: number
  log_format?: string
  log_level?: string
  endpoints?: YamlEndpoint[]
  database?: string
  slow_query_threshold?: number
  max_memory?: string
  eviction_policy?: string
  error_rate?: number
  traffic_rate?: number
  custom_type?: string
}

interface YamlPlaceholder {
  kind: string
  enum_values?: string[]
  literal?: string
  min?: number
  max?: number
  format?: string
  length?: number
  description?: string
}

interface YamlLogTemplate {
  template: string
  weight?: number
  level?: string
  is_error?: boolean
}

interface YamlCustomType {
  id: string
  name?: string
  description?: string
  default_port?: number
  default_rate?: number
  default_error_rate?: number
  placeholders?: Record<string, YamlPlaceholder>
  templates: YamlLogTemplate[]
}

interface YamlTimelineBlock {
  from: number
  to: number
  state?: string
  error_rate?: number
  latency_mul?: number
  log_vol_mul?: number
  log_vol_abs?: number
  template_weights?: Record<string, number>
  placeholders?: Record<string, YamlPlaceholder>
  custom_log?: string
  note?: string
}

interface YamlService {
  type: string
  name: string
  description?: string
  host: string
  generator: YamlGenerator
  timeline?: YamlTimelineBlock[]
}

interface YamlConnection {
  source: string
  target: string
  protocol: string
  port: number
}

interface YamlScenario {
  name: string
  description?: string
  duration?: number
  tick_interval_ms?: number
  nodes: YamlNode[]
  services: YamlService[]
  connections: YamlConnection[]
  custom_types?: YamlCustomType[]
}

const SERVICE_GENERATOR_TYPE: Record<ServiceType, string> = {
  nodejs: 'nodejs',
  golang: 'golang',
  postgres: 'postgres',
  mysql: 'mysql',
  redis: 'redis',
  nginx: 'nginx',
  custom: 'custom',
}

// Backend Validate() requires unique names across nodes+services. The canvas
// allows duplicate labels, so deduplicate by appending a suffix derived from
// the node id when collisions occur.
function buildNameMap(scNodes: ScenarioNode[]): Map<string, string> {
  const used = new Set<string>()
  const map = new Map<string, string>()
  for (const n of scNodes) {
    const base = (n.label || n.id).trim() || n.id
    let candidate = base
    let i = 2
    while (used.has(candidate)) {
      candidate = `${base}-${i++}`
    }
    used.add(candidate)
    map.set(n.id, candidate)
  }
  return map
}

function findAncestorOfType(
  node: ScenarioNode,
  byId: Map<string, ScenarioNode>,
  targetType: ScenarioNode['type'],
): ScenarioNode | undefined {
  let current: ScenarioNode | undefined = node
  while (current?.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent) return undefined
    if (parent.type === targetType) return parent
    current = parent
  }
  return undefined
}

export interface ServiceOverride {
  /** Replaces the node's errorRate. */
  errorRate?: number
  /** Multiplies the node's trafficRate. */
  logVolMul?: number
  /** Multiplies endpoint avg_latency_ms. */
  latencyMul?: number
}

function buildGeneratorConfig(node: ScenarioNode, override?: ServiceOverride): YamlGenerator {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const serviceType = node.serviceType ?? 'custom'
  const gen: YamlGenerator = { type: SERVICE_GENERATOR_TYPE[serviceType] ?? serviceType }

  if (typeof cfg.port === 'number') gen.port = cfg.port
  if (typeof cfg.logFormat === 'string') gen.log_format = cfg.logFormat
  if (typeof cfg.logLevel === 'string') gen.log_level = cfg.logLevel

  const baseErrorRate = typeof cfg.errorRate === 'number' ? cfg.errorRate : undefined
  const baseTrafficRate = typeof cfg.trafficRate === 'number' ? cfg.trafficRate : undefined
  const errorRate = override?.errorRate ?? baseErrorRate
  const logVolMul = override?.logVolMul ?? 1
  const trafficRate = baseTrafficRate !== undefined ? baseTrafficRate * logVolMul : undefined
  const latencyMul = override?.latencyMul ?? 1

  if (errorRate !== undefined) gen.error_rate = errorRate
  if (trafficRate !== undefined) gen.traffic_rate = trafficRate

  if (Array.isArray(cfg.endpoints)) {
    gen.endpoints = (cfg.endpoints as Array<Record<string, unknown>>).map(ep => ({
      method: String(ep.method ?? 'GET'),
      path: String(ep.path ?? '/'),
      avg_latency_ms: Number(ep.avgLatencyMs ?? 100) * latencyMul,
      error_rate: errorRate ?? Number(ep.errorRate ?? 0),
    }))
  }

  if (serviceType === 'mysql' || serviceType === 'postgres') {
    if (Array.isArray(cfg.databases) && cfg.databases.length > 0) {
      gen.database = String(cfg.databases[0])
    }
    if (typeof cfg.slowQueryThresholdMs === 'number') {
      gen.slow_query_threshold = cfg.slowQueryThresholdMs
    }
  }

  if (serviceType === 'redis') {
    if (typeof cfg.maxmemory === 'string') gen.max_memory = cfg.maxmemory
    if (typeof cfg.evictionPolicy === 'string') gen.eviction_policy = cfg.evictionPolicy
  }

  if (serviceType === 'custom') {
    const ct = cfg.customType as CustomNodeType | undefined
    if (ct?.id) gen.custom_type = ct.id
    if (gen.traffic_rate === undefined && typeof ct?.defaultRate === 'number') {
      gen.traffic_rate = ct.defaultRate * logVolMul
    }
    if (gen.error_rate === undefined && typeof ct?.defaultErrorRate === 'number') {
      gen.error_rate = ct.defaultErrorRate
    }
  }

  return gen
}

function toYamlPlaceholder(spec: PlaceholderSpec): YamlPlaceholder {
  const out: YamlPlaceholder = { kind: spec.kind }
  if (spec.enumValues?.length) out.enum_values = spec.enumValues
  if (typeof spec.literal === 'string') out.literal = spec.literal
  if (typeof spec.min === 'number') out.min = spec.min
  if (typeof spec.max === 'number') out.max = spec.max
  if (typeof spec.format === 'string') out.format = spec.format
  if (typeof spec.length === 'number') out.length = spec.length
  if (typeof spec.description === 'string') out.description = spec.description
  return out
}

function toYamlTemplate(t: CustomLogTemplate): YamlLogTemplate {
  const out: YamlLogTemplate = { template: t.template }
  if (typeof t.weight === 'number') out.weight = t.weight
  if (t.level) out.level = t.level
  if (t.isError) out.is_error = true
  return out
}

function toYamlCustomType(ct: CustomNodeType): YamlCustomType {
  const placeholders: Record<string, YamlPlaceholder> = {}
  for (const [name, spec] of Object.entries(ct.placeholders ?? {})) {
    placeholders[name] = toYamlPlaceholder(spec)
  }
  const out: YamlCustomType = {
    id: ct.id,
    name: ct.name,
    templates: (ct.templates ?? []).map(toYamlTemplate),
  }
  if (ct.description) out.description = ct.description
  if (typeof ct.defaultPort === 'number') out.default_port = ct.defaultPort
  if (typeof ct.defaultRate === 'number') out.default_rate = ct.defaultRate
  if (typeof ct.defaultErrorRate === 'number') out.default_error_rate = ct.defaultErrorRate
  if (Object.keys(placeholders).length > 0) out.placeholders = placeholders
  return out
}

// Default modifiers for each behavior state. Mirrors the Go side's
// stateDefaults() so the frontend understands what gets sent without
// re-asking the server. Used to elide redundant explicit fields when they
// equal the state preset.
const STATE_DEFAULTS: Record<string, { errorRate: number; latencyMul: number; logVolMul: number }> = {
  healthy:      { errorRate: 0,    latencyMul: 1,   logVolMul: 1 },
  degraded:     { errorRate: 0.1,  latencyMul: 2,   logVolMul: 1.2 },
  down:         { errorRate: 1,    latencyMul: 5,   logVolMul: 0.3 },
  recovering:   { errorRate: 0.05, latencyMul: 1.5, logVolMul: 1.4 },
  under_attack: { errorRate: 0.3,  latencyMul: 3,   logVolMul: 4 },
  throttled:    { errorRate: 0.15, latencyMul: 2.5, logVolMul: 0.5 },
  compromised:  { errorRate: 0.2,  latencyMul: 2,   logVolMul: 2 },
}

function toYamlTimelineBlock(b: import('@/types/episode').BehaviorBlock): YamlTimelineBlock {
  const out: YamlTimelineBlock = {
    from: b.start,
    to: b.start + b.duration,
    state: b.state,
  }
  // Only emit a field when it differs from the state preset; keeps YAML
  // readable for the common case where the user accepted the preset.
  const d = STATE_DEFAULTS[b.state]
  if (!d || b.errorRate !== d.errorRate) out.error_rate = b.errorRate
  if (!d || b.latencyMul !== d.latencyMul) out.latency_mul = b.latencyMul
  if (!d || b.logVolMul !== d.logVolMul) out.log_vol_mul = b.logVolMul
  if (b.customLog) out.custom_log = b.customLog
  if (b.note) out.note = b.note
  return out
}

function buildInfraNode(node: ScenarioNode, name: string, parentSubnetName?: string): YamlNode {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const out: YamlNode = { type: node.type, name }

  if (node.type === 'vpc') {
    if (node.provider) out.provider = node.provider
    if (typeof cfg.region === 'string') out.region = cfg.region
    if (typeof cfg.cidr === 'string') out.cidr_block = cfg.cidr
  } else if (node.type === 'subnet') {
    if (typeof cfg.cidr === 'string') out.cidr_block = cfg.cidr
  } else if (node.type === 'virtual_server') {
    if (typeof cfg.instanceType === 'string') out.instance_type = cfg.instanceType
    if (typeof cfg.os === 'string') out.os = cfg.os
    if (typeof cfg.privateIp === 'string' && cfg.privateIp) out.private_ip = cfg.privateIp
    if (parentSubnetName) out.subnet = parentSubnetName
  }
  return out
}

export interface CanvasToYamlOptions {
  /** Per-service single-tick override (legacy path; mutually exclusive with episode). */
  overrides?: Record<string, ServiceOverride>
  /** Embed the episode's per-service behavior blocks as scenario `timeline:`. */
  episode?: Episode
  /** Default 1000 if omitted. */
  tickIntervalMs?: number
}

export function canvasToScenarioYaml(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  metadata: ScenarioMetadata,
  optsOrOverrides?: CanvasToYamlOptions | Record<string, ServiceOverride>,
): string {
  // Back-compat: callers passing the old override map keep working.
  const opts: CanvasToYamlOptions =
    optsOrOverrides && 'overrides' in optsOrOverrides
      ? (optsOrOverrides as CanvasToYamlOptions)
      : optsOrOverrides && ('episode' in optsOrOverrides || 'tickIntervalMs' in optsOrOverrides)
        ? (optsOrOverrides as CanvasToYamlOptions)
        : { overrides: optsOrOverrides as Record<string, ServiceOverride> | undefined }
  const overrides = opts.overrides
  const episode = opts.episode
  const scNodes: ScenarioNode[] = flowNodes.map(n => n.data)
  const byId = new Map(scNodes.map(n => [n.id, n]))
  const nameById = buildNameMap(scNodes)

  const nodes: YamlNode[] = []
  const services: YamlService[] = []

  // Services on the canvas need a virtual_server host. If a service is
  // dropped onto a subnet (no virtual_server parent), the backend will
  // reject it — synthesize a host node so the scenario stays valid.
  const synthesizedHostByServiceId = new Map<string, string>()

  for (const node of scNodes) {
    const name = nameById.get(node.id)!
    if (node.type === 'service') continue
    const parentSubnet = findAncestorOfType(node, byId, 'subnet')
    nodes.push(buildInfraNode(node, name, parentSubnet ? nameById.get(parentSubnet.id) : undefined))
  }

  for (const node of scNodes) {
    if (node.type !== 'service') continue
    const serviceName = nameById.get(node.id)!
    const host = findAncestorOfType(node, byId, 'virtual_server')
    let hostName: string
    if (host) {
      hostName = nameById.get(host.id)!
    } else {
      // Synthesize a virtual_server host so the backend validator accepts
      // an unhosted service — keeps "drop service onto canvas" usable.
      hostName = `${serviceName}-host`
      const subnet = findAncestorOfType(node, byId, 'subnet')
      nodes.push({
        type: 'virtual_server',
        name: hostName,
        ...(subnet ? { subnet: nameById.get(subnet.id) } : {}),
      })
      synthesizedHostByServiceId.set(node.id, hostName)
    }

    const svcEntry: YamlService = {
      type: SERVICE_GENERATOR_TYPE[node.serviceType ?? 'custom'] ?? 'custom',
      name: serviceName,
      host: hostName,
      generator: buildGeneratorConfig(node, overrides?.[node.id]),
    }
    const blocks = episode?.lanes?.[node.id]
    if (blocks && blocks.length > 0) {
      svcEntry.timeline = blocks.map(toYamlTimelineBlock)
    }
    services.push(svcEntry)
  }

  // Dedupe custom-type definitions across services that share an id.
  const customTypesById = new Map<string, YamlCustomType>()
  for (const node of scNodes) {
    if (node.type !== 'service' || node.serviceType !== 'custom') continue
    const ct = (node.config as Record<string, unknown> | undefined)?.customType as CustomNodeType | undefined
    if (!ct?.id || customTypesById.has(ct.id)) continue
    customTypesById.set(ct.id, toYamlCustomType(ct))
  }

  const allNames = new Set<string>([...nodes.map(n => n.name), ...services.map(s => s.name)])

  const connections: YamlConnection[] = []
  for (const edge of flowEdges) {
    const sourceName = nameById.get(edge.source)
    const targetName = nameById.get(edge.target)
    if (!sourceName || !targetName) continue
    if (!allNames.has(sourceName) || !allNames.has(targetName)) continue
    const data = edge.data
    connections.push({
      source: sourceName,
      target: targetName,
      protocol: (data?.protocol as string) ?? 'tcp',
      port: (data?.port as number) ?? 80,
    })
  }

  const scenario: YamlScenario = {
    name: metadata.name || 'Untitled Scenario',
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(episode?.duration ? { duration: episode.duration } : {}),
    ...(opts.tickIntervalMs ? { tick_interval_ms: opts.tickIntervalMs } : {}),
    nodes,
    services,
    connections,
    ...(customTypesById.size > 0 ? { custom_types: [...customTypesById.values()] } : {}),
  }

  return yaml.dump(scenario, { lineWidth: 120, noRefs: true })
}
