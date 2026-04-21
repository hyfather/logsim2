import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry, LogLevel } from '@/types/logs'
import type { TrafficFlow } from '../traffic/TrafficSimulator'
import { generateId } from '@/lib/id'

export interface TickContext {
  tickIndex: number
  timestamp: Date
  tickIntervalMs: number
  inboundFlows: TrafficFlow[]
  outboundFlows: TrafficFlow[]
  rng: () => number
}

export interface FlowRequestEvent {
  flow: TrafficFlow
  timestamp: Date
  sequence: number
  isError: boolean
}

export abstract class BaseGenerator {
  abstract generate(node: ScenarioNode, ctx: TickContext): LogEntry[]

  protected createEntry(
    node: ScenarioNode,
    level: LogLevel,
    raw: string,
    source: LogEntry['source'],
    timestamp: Date | string = new Date()
  ): LogEntry {
    return {
      id: generateId(),
      ts: typeof timestamp === 'string' ? timestamp : timestamp.toISOString(),
      channel: node.channel,
      level,
      source,
      raw,
    }
  }

  protected expandRequestEvents(flows: TrafficFlow[], ctx: TickContext): FlowRequestEvent[] {
    const events: FlowRequestEvent[] = []

    for (const flow of flows) {
      const requestCount = Math.max(0, flow.requestCount)
      if (requestCount === 0) continue

      let remainingErrors = Math.max(0, Math.min(flow.errorCount, requestCount))

      for (let i = 0; i < requestCount; i++) {
        const remainingSlots = requestCount - i
        const mustUseError = remainingErrors > 0 && remainingSlots === remainingErrors
        const isError = mustUseError || (remainingErrors > 0 && ctx.rng() < remainingErrors / remainingSlots)
        if (isError) remainingErrors--

        const offset = Math.min(
          Math.max(ctx.tickIntervalMs - 1, 0),
          Math.floor(((i + ctx.rng()) / requestCount) * ctx.tickIntervalMs)
        )

        events.push({
          flow,
          timestamp: new Date(ctx.timestamp.getTime() + offset),
          sequence: i,
          isError,
        })
      }
    }

    return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  }
}

// Simple seeded RNG (mulberry32)
export function createRng(seed: number): () => number {
  let s = seed
  return function() {
    s |= 0
    s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  'PostmanRuntime/7.36.0',
  'python-httpx/0.26.0',
  'Go-http-client/1.1',
]

export const COMMON_PATHS = [
  '/api/users', '/api/users/:id', '/api/products', '/api/orders',
  '/api/health', '/api/metrics', '/api/auth/login', '/api/auth/logout',
  '/api/search', '/api/upload', '/api/download', '/api/config',
]

export const SQL_QUERIES = [
  'SELECT * FROM users WHERE id = $1',
  'SELECT id, email, created_at FROM users LIMIT 100',
  'INSERT INTO events (user_id, action, ts) VALUES ($1, $2, $3)',
  'UPDATE users SET last_login = NOW() WHERE id = $1',
  'DELETE FROM sessions WHERE expires_at < NOW()',
  'SELECT count(*) FROM orders WHERE status = $1',
  'SELECT u.*, o.total FROM users u JOIN orders o ON u.id = o.user_id WHERE u.id = $1',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
]

export const LOG_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

export function pickRandom<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!
}

export function randomLatency(avg: number, rng: () => number): number {
  // Log-normal-ish distribution
  return Math.max(1, Math.round(avg * (0.5 + rng() * 1.5)))
}
