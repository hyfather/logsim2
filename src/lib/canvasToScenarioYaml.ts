import yaml from 'js-yaml'
import type { FlowNode, FlowEdge } from '@/store/useScenarioStore'
import type { ScenarioNode, ServiceType } from '@/types/nodes'
import type { ScenarioMetadata } from '@/types/scenario'

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
}

interface YamlService {
  type: string
  name: string
  description?: string
  host: string
  generator: YamlGenerator
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
  nodes: YamlNode[]
  services: YamlService[]
  connections: YamlConnection[]
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

function buildGeneratorConfig(node: ScenarioNode): YamlGenerator {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const serviceType = node.serviceType ?? 'custom'
  const gen: YamlGenerator = { type: SERVICE_GENERATOR_TYPE[serviceType] ?? serviceType }

  if (typeof cfg.port === 'number') gen.port = cfg.port
  if (typeof cfg.logFormat === 'string') gen.log_format = cfg.logFormat
  if (typeof cfg.logLevel === 'string') gen.log_level = cfg.logLevel
  if (typeof cfg.errorRate === 'number') gen.error_rate = cfg.errorRate
  if (typeof cfg.trafficRate === 'number') gen.traffic_rate = cfg.trafficRate

  if (Array.isArray(cfg.endpoints)) {
    gen.endpoints = (cfg.endpoints as Array<Record<string, unknown>>).map(ep => ({
      method: String(ep.method ?? 'GET'),
      path: String(ep.path ?? '/'),
      avg_latency_ms: Number(ep.avgLatencyMs ?? 100),
      error_rate: Number(ep.errorRate ?? 0),
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

  return gen
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

export function canvasToScenarioYaml(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  metadata: ScenarioMetadata,
): string {
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

    services.push({
      type: SERVICE_GENERATOR_TYPE[node.serviceType ?? 'custom'] ?? 'custom',
      name: serviceName,
      host: hostName,
      generator: buildGeneratorConfig(node),
    })
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
    nodes,
    services,
    connections,
  }

  return yaml.dump(scenario, { lineWidth: 120, noRefs: true })
}
