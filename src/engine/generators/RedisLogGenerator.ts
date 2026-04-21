import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry } from '@/types/logs'
import type { RedisConfig } from '@/types/nodes'
import { BaseGenerator, type TickContext, pickRandom } from './BaseGenerator'
import { pickError } from './errorTemplates'

const REDIS_COMMANDS = ['GET', 'SET', 'HGET', 'HSET', 'LPUSH', 'RPOP', 'ZADD', 'ZRANGE', 'EXPIRE', 'DEL', 'EXISTS', 'INCR']
const REDIS_KEYS = ['session:*', 'cache:user:*', 'rate:ip:*', 'lock:*', 'queue:jobs', 'metrics:*']

export class RedisLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as unknown as RedisConfig
    const cfg = node.config as Record<string, unknown>
    const errorScenario = (cfg.errorScenario as string) || 'none'
    const entries: LogEntry[] = []
    const ts = String(Math.floor(ctx.timestamp.getTime() / 1000))
    const pid = 1

    const inboundFlows = ctx.inboundFlows.filter(flow => flow.requestCount > 0)
    const allFlows = [...inboundFlows, ...ctx.outboundFlows.filter(flow => flow.requestCount > 0)]
    const requestEvents = this.expandRequestEvents(allFlows, ctx)

    for (const flow of inboundFlows) {
      entries.push(this.createEntry(
        node,
        'INFO',
        `${ts}:${pid}:M * Accepted ${flow.protocol.toUpperCase()} connection from ${flow.sourceLabel} ${flow.srcIp}:${flow.port} requests=${flow.requestCount}`,
        'redis',
        ctx.timestamp
      ))
    }

    // Error logs based on error scenario
    for (const event of requestEvents) {
      if (event.isError) {
        const err = pickError('redis', errorScenario, ctx.rng)
        if (err) {
          const level = err.level === 'FATAL' ? 'ERROR' : err.level
          entries.push(this.createEntry(node, level,
            `${ts}:${pid}:M # ${err.message}`,
            'redis',
            event.timestamp
          ))
        }
      }
    }

    // Slow log entries (Redis logs commands exceeding slowlog-log-slower-than)
    if (ctx.rng() < 0.1 && allFlows.length > 0) {
      const cmd = pickRandom(REDIS_COMMANDS, ctx.rng)
      const key = pickRandom(REDIS_KEYS, ctx.rng).replace('*', String(Math.floor(ctx.rng() * 1000)))
      const microSecs = Math.floor(ctx.rng() * 100000)
      entries.push(this.createEntry(node, 'WARN',
        `${ts}:${pid}:S ${microSecs} ${cmd} ${key}`,
        'redis',
        ctx.timestamp
      ))
    }

    // Key expired events
    for (let i = 0; i < Math.min(requestEvents.length / 10, 3); i++) {
      if (ctx.rng() < 0.05) {
        entries.push(this.createEntry(node, 'INFO',
          `${ts}:${pid}:M * Expired key cache:user:${Math.floor(ctx.rng() * 10000)}`,
          'redis',
          ctx.timestamp
        ))
      }
    }

    // Memory pressure
    const maxMemBytes = parseInt((config.maxmemory || '256mb').replace(/[^0-9]/g, '')) * (config.maxmemory?.includes('gb') ? 1073741824 : 1048576)
    const usedMemFraction = 0.7 + ctx.rng() * 0.3
    if (usedMemFraction > 0.9) {
      entries.push(this.createEntry(node, 'WARN',
        `${ts}:${pid}:M # WARNING: 90% of memory used (${Math.floor(maxMemBytes * usedMemFraction / 1048576)}mb / ${Math.floor(maxMemBytes / 1048576)}mb). Consider increasing maxmemory.`,
        'redis',
        ctx.timestamp
      ))
    }

    // Startup log
    if (ctx.tickIndex === 0 || (entries.length === 0 && ctx.rng() < 0.02)) {
      entries.push(this.createEntry(node, 'INFO',
        `${ts}:${pid}:M * Ready to accept connections on port ${config.port || 6379}`,
        'redis',
        ctx.timestamp
      ))
    }

    return entries
  }
}
