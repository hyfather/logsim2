import type { FlowNode, FlowEdge } from '@/store/useScenarioStore'
import type { ScenarioNode, ServiceType } from '@/types/nodes'
import type { ScenarioMetadata } from '@/types/scenario'
import type { CustomNodeType } from '@/types/customNodeType'
import type { Episode, BehaviorBlock, NarrativeBeat } from '@/types/episode'

export interface BuildGroundTruthOptions {
  episode?: Episode
  /** Default 1000. Used to convert tick numbers into wall-clock offsets. */
  tickIntervalMs?: number
}

const STATE_DEFAULTS: Record<string, { errorRate: number; latencyMul: number; logVolMul: number }> = {
  healthy:      { errorRate: 0,    latencyMul: 1,   logVolMul: 1 },
  degraded:     { errorRate: 0.1,  latencyMul: 2,   logVolMul: 1.2 },
  down:         { errorRate: 1,    latencyMul: 5,   logVolMul: 0.3 },
  recovering:   { errorRate: 0.05, latencyMul: 1.5, logVolMul: 1.4 },
  under_attack: { errorRate: 0.3,  latencyMul: 3,   logVolMul: 4 },
  throttled:    { errorRate: 0.15, latencyMul: 2.5, logVolMul: 0.5 },
  compromised:  { errorRate: 0.2,  latencyMul: 2,   logVolMul: 2 },
}

const SERVICE_TYPE_LABEL: Record<ServiceType, string> = {
  nodejs: 'Node.js',
  golang: 'Go',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  redis: 'Redis',
  nginx: 'Nginx',
  custom: 'custom',
}

function formatTickClock(tick: number, tickIntervalMs: number): string {
  const totalSeconds = Math.floor((tick * tickIntervalMs) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${mm}:${ss}`
  return `${mm}:${ss}`
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  // Trim trailing zeros so 0.10 → 0.1; cap at 4 decimals to keep output stable.
  return Number(n.toFixed(4)).toString()
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural ?? singular + 's'}`
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

function buildNameMap(scNodes: ScenarioNode[]): Map<string, string> {
  const used = new Set<string>()
  const map = new Map<string, string>()
  for (const n of scNodes) {
    const base = (n.label || n.id).trim() || n.id
    let candidate = base
    let i = 2
    while (used.has(candidate)) candidate = `${base}-${i++}`
    used.add(candidate)
    map.set(n.id, candidate)
  }
  return map
}

function describeBlockEffects(b: BehaviorBlock): string {
  const d = STATE_DEFAULTS[b.state]
  const parts: string[] = []
  if (!d || b.errorRate !== d.errorRate) parts.push(`error_rate=${formatNumber(b.errorRate)}`)
  if (!d || b.latencyMul !== d.latencyMul) parts.push(`latency_mul=${formatNumber(b.latencyMul)}`)
  if (!d || b.logVolMul !== d.logVolMul) parts.push(`log_vol_mul=${formatNumber(b.logVolMul)}`)
  if (parts.length === 0 && d) {
    parts.push(
      `error_rate=${formatNumber(d.errorRate)}`,
      `latency_mul=${formatNumber(d.latencyMul)}`,
      `log_vol_mul=${formatNumber(d.logVolMul)}`,
    )
  }
  return parts.join(', ')
}

function pad(line: string, indent: number): string {
  return ' '.repeat(indent) + line
}

export function buildScenarioGroundTruth(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  metadata: ScenarioMetadata,
  options: BuildGroundTruthOptions = {},
): string {
  const tickIntervalMs = options.tickIntervalMs ?? 1000
  const episode = options.episode
  const scNodes: ScenarioNode[] = flowNodes.map(n => n.data)
  const byId = new Map(scNodes.map(n => [n.id, n]))
  const nameById = buildNameMap(scNodes)
  const lines: string[] = []

  // ── Header ────────────────────────────────────────────────────────
  lines.push(`SCENARIO: ${metadata.name || 'Untitled Scenario'}`)
  if (metadata.description?.trim()) {
    lines.push(`Description: ${metadata.description.trim()}`)
  }
  if (episode?.duration) {
    const totalSec = Math.floor((episode.duration * tickIntervalMs) / 1000)
    const minutes = Math.floor(totalSec / 60)
    const seconds = totalSec % 60
    const wall = minutes > 0
      ? `${minutes} min${seconds > 0 ? ` ${seconds} s` : ''}`
      : `${seconds} s`
    lines.push(`Duration: ${episode.duration} ticks (${wall} at ${tickIntervalMs}ms/tick)`)
  } else {
    lines.push(`Tick interval: ${tickIntervalMs}ms`)
  }
  lines.push('')

  // ── Infrastructure ────────────────────────────────────────────────
  const vpcs = scNodes.filter(n => n.type === 'vpc')
  const subnets = scNodes.filter(n => n.type === 'subnet')
  const servers = scNodes.filter(n => n.type === 'virtual_server')
  const services = scNodes.filter(n => n.type === 'service')

  // Sort everything by display name for determinism.
  const byName = (a: ScenarioNode, b: ScenarioNode) =>
    nameById.get(a.id)!.localeCompare(nameById.get(b.id)!)
  vpcs.sort(byName)
  subnets.sort(byName)
  servers.sort(byName)
  services.sort(byName)

  lines.push('================================================================')
  lines.push('INFRASTRUCTURE')
  lines.push('================================================================')
  lines.push(
    `Counts: ${pluralize(vpcs.length, 'VPC')}, ${pluralize(subnets.length, 'subnet')}, ` +
    `${pluralize(servers.length, 'virtual server')}, ${pluralize(services.length, 'service')}.`,
  )
  lines.push('')

  if (vpcs.length > 0) {
    lines.push('VPCs:')
    for (const v of vpcs) {
      const cfg = (v.config ?? {}) as Record<string, unknown>
      const attrs: string[] = []
      if (v.provider) attrs.push(`provider=${v.provider}`)
      if (typeof cfg.region === 'string') attrs.push(`region=${cfg.region}`)
      if (typeof cfg.cidr === 'string') attrs.push(`cidr=${cfg.cidr}`)
      const tail = attrs.length > 0 ? ` (${attrs.join(', ')})` : ''
      lines.push(pad(`- ${nameById.get(v.id)}${tail}`, 2))
    }
    lines.push('')
  }

  if (subnets.length > 0) {
    lines.push('Subnets:')
    for (const s of subnets) {
      const cfg = (s.config ?? {}) as Record<string, unknown>
      const parentVpc = findAncestorOfType(s, byId, 'vpc')
      const attrs: string[] = []
      if (parentVpc) attrs.push(`in ${nameById.get(parentVpc.id)}`)
      if (typeof cfg.cidr === 'string') attrs.push(`cidr=${cfg.cidr}`)
      if (typeof cfg.availabilityZone === 'string') attrs.push(`az=${cfg.availabilityZone}`)
      if (typeof cfg.isPublic === 'boolean') attrs.push(cfg.isPublic ? 'public' : 'private')
      const tail = attrs.length > 0 ? ` (${attrs.join(', ')})` : ''
      lines.push(pad(`- ${nameById.get(s.id)}${tail}`, 2))
    }
    lines.push('')
  }

  if (servers.length > 0) {
    lines.push('Virtual servers:')
    for (const srv of servers) {
      const cfg = (srv.config ?? {}) as Record<string, unknown>
      const parentSubnet = findAncestorOfType(srv, byId, 'subnet')
      const attrs: string[] = []
      if (parentSubnet) attrs.push(`in ${nameById.get(parentSubnet.id)}`)
      if (typeof cfg.instanceType === 'string') attrs.push(cfg.instanceType)
      if (typeof cfg.os === 'string') attrs.push(cfg.os)
      if (typeof cfg.privateIp === 'string' && cfg.privateIp) attrs.push(`ip=${cfg.privateIp}`)
      const tail = attrs.length > 0 ? ` (${attrs.join(', ')})` : ''
      lines.push(pad(`- ${nameById.get(srv.id)}${tail}`, 2))
    }
    lines.push('')
  }

  // ── Services ──────────────────────────────────────────────────────
  lines.push('================================================================')
  lines.push('SERVICES')
  lines.push('================================================================')
  if (services.length === 0) {
    lines.push('(none)')
    lines.push('')
  } else {
    for (let i = 0; i < services.length; i++) {
      const svc = services[i]
      const cfg = (svc.config ?? {}) as Record<string, unknown>
      const serviceType: ServiceType = svc.serviceType ?? 'custom'
      const typeLabel = SERVICE_TYPE_LABEL[serviceType] ?? serviceType
      const host = findAncestorOfType(svc, byId, 'virtual_server')
      const hostName = host ? nameById.get(host.id) : `${nameById.get(svc.id)}-host (synthesized)`

      lines.push(`${nameById.get(svc.id)} (${typeLabel})`)
      lines.push(pad(`Host: ${hostName}`, 2))

      if (typeof cfg.port === 'number') lines.push(pad(`Port: ${cfg.port}`, 2))
      if (typeof cfg.logFormat === 'string' || typeof cfg.logLevel === 'string') {
        const fmt = typeof cfg.logFormat === 'string' ? cfg.logFormat : '?'
        const lvl = typeof cfg.logLevel === 'string' ? cfg.logLevel : '?'
        lines.push(pad(`Log: format=${fmt}, level=${lvl}`, 2))
      }
      if (typeof cfg.trafficRate === 'number') {
        lines.push(pad(`Base traffic rate: ${formatNumber(cfg.trafficRate)} req/s`, 2))
      }
      if (typeof cfg.errorRate === 'number') {
        lines.push(pad(`Base error rate: ${formatNumber(cfg.errorRate)}`, 2))
      }

      if (Array.isArray(cfg.endpoints) && cfg.endpoints.length > 0) {
        lines.push(pad('Endpoints:', 2))
        const eps = (cfg.endpoints as Array<Record<string, unknown>>)
          .slice()
          .sort((a, b) => {
            const am = String(a.method ?? ''), bm = String(b.method ?? '')
            const ap = String(a.path ?? ''), bp = String(b.path ?? '')
            return am === bm ? ap.localeCompare(bp) : am.localeCompare(bm)
          })
        for (const ep of eps) {
          const method = String(ep.method ?? 'GET')
          const path = String(ep.path ?? '/')
          const lat = Number(ep.avgLatencyMs ?? 0)
          const err = Number(ep.errorRate ?? 0)
          lines.push(pad(`- ${method} ${path} (avg ${formatNumber(lat)}ms, error_rate=${formatNumber(err)})`, 4))
        }
      }

      if (serviceType === 'postgres' || serviceType === 'mysql') {
        if (Array.isArray(cfg.databases) && cfg.databases.length > 0) {
          lines.push(pad(`Databases: ${(cfg.databases as unknown[]).map(String).join(', ')}`, 2))
        }
        if (typeof cfg.slowQueryThresholdMs === 'number') {
          lines.push(pad(`Slow query threshold: ${cfg.slowQueryThresholdMs}ms`, 2))
        }
      }
      if (serviceType === 'redis') {
        if (typeof cfg.maxmemory === 'string') lines.push(pad(`Max memory: ${cfg.maxmemory}`, 2))
        if (typeof cfg.evictionPolicy === 'string') lines.push(pad(`Eviction policy: ${cfg.evictionPolicy}`, 2))
      }
      if (serviceType === 'custom') {
        const ct = cfg.customType as CustomNodeType | undefined
        if (ct) {
          lines.push(pad(`Custom type: ${ct.name || ct.id}`, 2))
          if (ct.description) lines.push(pad(`Description: ${ct.description}`, 2))
          if (typeof ct.defaultRate === 'number') {
            lines.push(pad(`Default rate: ${formatNumber(ct.defaultRate)} events/s`, 2))
          }
          if (typeof ct.defaultErrorRate === 'number') {
            lines.push(pad(`Default error rate: ${formatNumber(ct.defaultErrorRate)}`, 2))
          }
          if (Array.isArray(ct.templates) && ct.templates.length > 0) {
            lines.push(pad(`Log templates: ${ct.templates.length}`, 2))
          }
        }
      }
      if (i < services.length - 1) lines.push('')
    }
    lines.push('')
  }

  // ── Connections ───────────────────────────────────────────────────
  lines.push('================================================================')
  lines.push('CONNECTIONS')
  lines.push('================================================================')
  const renderableEdges = flowEdges
    .map(e => ({
      sourceName: nameById.get(e.source),
      targetName: nameById.get(e.target),
      protocol: (e.data?.protocol as string) ?? 'tcp',
      port: (e.data?.port as number) ?? 0,
    }))
    .filter((e): e is { sourceName: string; targetName: string; protocol: string; port: number } =>
      Boolean(e.sourceName && e.targetName))
    .sort((a, b) => {
      if (a.sourceName !== b.sourceName) return a.sourceName.localeCompare(b.sourceName)
      if (a.targetName !== b.targetName) return a.targetName.localeCompare(b.targetName)
      if (a.protocol !== b.protocol) return a.protocol.localeCompare(b.protocol)
      return a.port - b.port
    })
  if (renderableEdges.length === 0) {
    lines.push('(none)')
  } else {
    for (const e of renderableEdges) {
      lines.push(pad(`- ${e.sourceName} -> ${e.targetName} (${e.protocol}:${e.port})`, 2))
    }
  }
  lines.push('')

  // ── Timeline ──────────────────────────────────────────────────────
  lines.push('================================================================')
  lines.push('TIMELINE')
  lines.push('================================================================')

  const beats: NarrativeBeat[] = (episode?.narrative ?? []).slice().sort((a, b) => a.tick - b.tick)
  if (beats.length > 0) {
    lines.push('Narrative beats:')
    for (const beat of beats) {
      lines.push(pad(`[tick ${beat.tick}, ${formatTickClock(beat.tick, tickIntervalMs)}] ${beat.text}`, 2))
    }
    lines.push('')
  }

  // Service behavior, sorted by service name then by block start.
  const lanes = episode?.lanes ?? {}
  const lanedServices = services
    .filter(svc => Array.isArray(lanes[svc.id]) && lanes[svc.id].length > 0)
  if (lanedServices.length === 0 && beats.length === 0) {
    lines.push('(no timeline events)')
    lines.push('')
  } else if (lanedServices.length > 0) {
    lines.push('Service behavior:')
    lines.push('')
    for (let i = 0; i < lanedServices.length; i++) {
      const svc = lanedServices[i]
      const blocks = lanes[svc.id].slice().sort((a, b) => a.start - b.start)
      lines.push(`${nameById.get(svc.id)}:`)
      for (const b of blocks) {
        const end = b.start + b.duration
        const range = `tick ${b.start}..${end} (${formatTickClock(b.start, tickIntervalMs)}..${formatTickClock(end, tickIntervalMs)})`
        const effects = describeBlockEffects(b)
        lines.push(pad(`[${range}] ${b.state}${effects ? ` — ${effects}` : ''}`, 2))
        if (b.note?.trim()) lines.push(pad(`note: ${b.note.trim()}`, 6))
        if (b.customLog?.trim()) lines.push(pad(`custom_log: ${b.customLog.trim()}`, 6))
        if (b.configOverrides && Object.keys(b.configOverrides).length > 0) {
          const entries = Object.entries(b.configOverrides)
            .filter(([, v]) => v !== undefined && v !== null)
            .sort(([a], [b]) => a.localeCompare(b))
          if (entries.length > 0) {
            const formatted = entries.map(([k, v]) => `${k}=${typeof v === 'number' ? formatNumber(v) : JSON.stringify(v)}`).join(', ')
            lines.push(pad(`config_overrides: ${formatted}`, 6))
          }
        }
      }
      if (i < lanedServices.length - 1) lines.push('')
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n+$/, '') + '\n'
}
