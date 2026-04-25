import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry, LogLevel } from '@/types/logs'
import type { CustomNodeType, CustomLogTemplate, PlaceholderSpec } from '@/types/customNodeType'
import {
  BaseGenerator,
  type TickContext,
  USER_AGENTS,
  pickRandom,
  createRng,
} from './BaseGenerator'

const SUCCESS_STATUSES = [200, 200, 200, 200, 201, 202, 204, 301, 304]
const ERROR_STATUSES = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]
const HTTP_METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const FALLBACK_PATHS = ['/api/items', '/api/users', '/api/health', '/login', '/static/app.js']
const FALLBACK_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'gamma', 'sigma', 'epsilon', 'tango']

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

function randInt(rng: () => number, min: number, max: number): number {
  if (max < min) [min, max] = [max, min]
  return Math.floor(rng() * (max - min + 1)) + min
}

function randHex(rng: () => number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += Math.floor(rng() * 16).toString(16)
  return s
}

function randUuid(rng: () => number): string {
  const bytes: number[] = []
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(rng() * 256))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function randomIp(rng: () => number): string {
  return `${randInt(rng, 10, 240)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`
}

function randomIpv6(rng: () => number): string {
  const parts: string[] = []
  for (let i = 0; i < 8; i++) parts.push(randHex(rng, 4))
  return parts.join(':')
}

const MONTHS_3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatTimestamp(date: Date, format?: string): string {
  switch ((format || 'iso').toLowerCase()) {
    case 'epoch_s':
    case 'epoch_seconds':
    case 'epoch':
      return Math.floor(date.getTime() / 1000).toString()
    case 'epoch_ms':
    case 'epoch_millis':
      return date.getTime().toString()
    case 'rfc3164':
    case 'syslog': {
      const m = MONTHS_3[date.getUTCMonth()]
      const d = String(date.getUTCDate()).padStart(2, ' ')
      const t = date.toISOString().slice(11, 19)
      return `${m} ${d} ${t}`
    }
    case 'apache':
    case 'clf': {
      const m = MONTHS_3[date.getUTCMonth()]
      const d = String(date.getUTCDate()).padStart(2, '0')
      const yr = date.getUTCFullYear()
      const t = date.toISOString().slice(11, 19)
      return `${d}/${m}/${yr}:${t} +0000`
    }
    default:
      return date.toISOString()
  }
}

interface FillContext {
  rng: () => number
  ts: Date
  isError: boolean
  level: LogLevel
  node: ScenarioNode | null
}

function fillPlaceholder(
  name: string,
  spec: PlaceholderSpec | undefined,
  ctx: FillContext,
): string {
  const rng = ctx.rng
  const kind = spec?.kind ?? 'literal'

  // For some kinds an enum override is meaningful (level, method, path, word).
  // For others (`enum`, `free_text`) it's the only source of values.
  if (
    spec?.enumValues?.length &&
    (kind === 'enum' || kind === 'free_text' || kind === 'level' ||
      kind === 'method' || kind === 'path' || kind === 'word' || kind === 'host')
  ) {
    return pickRandom(spec.enumValues, rng)
  }

  switch (kind) {
    case 'timestamp':
    case 'iso_timestamp':
      return formatTimestamp(ctx.ts, kind === 'iso_timestamp' ? 'iso' : spec?.format)
    case 'epoch_seconds':
      return formatTimestamp(ctx.ts, 'epoch_s')
    case 'epoch_millis':
      return formatTimestamp(ctx.ts, 'epoch_ms')
    case 'level':
      return ctx.level
    case 'ip':
      return randomIp(rng)
    case 'ipv6':
      return randomIpv6(rng)
    case 'host':
      return `host-${randInt(rng, 1, 99)}.local`
    case 'port': {
      const cfg = (ctx.node?.config ?? {}) as Record<string, unknown>
      const fromCfg = typeof cfg.port === 'number' ? cfg.port : undefined
      return String(fromCfg ?? randInt(rng, 1024, 65535))
    }
    case 'method':
      return pickRandom([...HTTP_METHODS], rng)
    case 'path':
      return pickRandom(FALLBACK_PATHS, rng)
    case 'status':
      return String(pickRandom(ctx.isError ? ERROR_STATUSES : SUCCESS_STATUSES, rng))
    case 'latency_ms':
    case 'duration_ms': {
      const min = spec?.min ?? 1
      const max = spec?.max ?? (ctx.isError ? 3000 : 500)
      return String(randInt(rng, min, max))
    }
    case 'bytes': {
      const min = spec?.min ?? 50
      const max = spec?.max ?? 50000
      return String(randInt(rng, min, max))
    }
    case 'request_id':
      return randHex(rng, spec?.length ?? 16)
    case 'trace_id':
      return randHex(rng, spec?.length ?? 32)
    case 'uuid':
      return randUuid(rng)
    case 'user_id':
      return String(randInt(rng, spec?.min ?? 1, spec?.max ?? 999999))
    case 'session_id':
      return randHex(rng, spec?.length ?? 24)
    case 'email':
      return `user${randInt(rng, 1, 99999)}@example.com`
    case 'pid':
      return String(randInt(rng, spec?.min ?? 100, spec?.max ?? 65535))
    case 'thread':
      return `t-${randInt(rng, 1, 64)}`
    case 'integer':
      return String(randInt(rng, spec?.min ?? 0, spec?.max ?? 100))
    case 'float': {
      const min = spec?.min ?? 0
      const max = spec?.max ?? 1
      return (min + rng() * (max - min)).toFixed(3)
    }
    case 'hex':
      return randHex(rng, spec?.length ?? 8)
    case 'word':
      return pickRandom(FALLBACK_WORDS, rng)
    case 'user_agent':
      return pickRandom(USER_AGENTS, rng)
    case 'enum':
    case 'free_text':
      return spec?.enumValues?.length ? pickRandom(spec.enumValues, rng) : `<${name}>`
    case 'literal':
      return spec?.literal ?? ''
    default:
      return spec?.literal ?? ''
  }
}

function pickWeightedTemplate(
  templates: CustomLogTemplate[],
  rng: () => number,
  mustError: boolean,
): CustomLogTemplate | null {
  if (templates.length === 0) return null
  const wantError = mustError
  const primary = templates.filter(t => t.isError === wantError)
  const pool = primary.length > 0 ? primary : templates
  const total = pool.reduce((s, t) => s + (t.weight > 0 ? t.weight : 1), 0)
  let r = rng() * total
  for (const t of pool) {
    r -= t.weight > 0 ? t.weight : 1
    if (r <= 0) return t
  }
  return pool[pool.length - 1]
}

function renderTemplate(
  tpl: CustomLogTemplate,
  customType: CustomNodeType,
  node: ScenarioNode | null,
  ts: Date,
  rng: () => number,
): string {
  return tpl.template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const spec = customType.placeholders[name]
    return fillPlaceholder(name, spec, { rng, ts, isError: tpl.isError, level: tpl.level, node })
  })
}

/**
 * Render N preview log lines for a given custom type, without needing a real
 * scenario node. Used by the create-custom-type dialog.
 */
export function previewCustomLogs(customType: CustomNodeType, count = 6, seed = 1): string[] {
  const rng = createRng(seed)
  const out: string[] = []
  const errorChance = customType.defaultErrorRate ?? 0.1
  for (let i = 0; i < count; i++) {
    const isError = rng() < Math.max(0.15, errorChance)
    const tpl = pickWeightedTemplate(customType.templates, rng, isError)
    if (!tpl) continue
    const ts = new Date(Date.now() + i * 137)
    out.push(renderTemplate(tpl, customType, null, ts, rng))
  }
  return out
}

export class CustomLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const cfg = node.config as Record<string, unknown>
    const customType = cfg.customType as CustomNodeType | undefined
    if (!customType || !customType.templates?.length) return []

    const inboundFlows = ctx.inboundFlows.filter(f => f.requestCount > 0)
    const outboundFlows = ctx.outboundFlows.filter(f => f.requestCount > 0)
    const requestFlows = inboundFlows.length > 0 ? inboundFlows : outboundFlows
    if (requestFlows.length === 0) return []

    const events = this.expandRequestEvents(requestFlows, ctx)
    const entries: LogEntry[] = []
    for (const ev of events) {
      const tpl = pickWeightedTemplate(customType.templates, ctx.rng, ev.isError)
      if (!tpl) continue
      const raw = renderTemplate(tpl, customType, node, ev.timestamp, ctx.rng)
      entries.push(this.createEntry(node, tpl.level, raw, 'custom', ev.timestamp))
    }
    return entries
  }
}
