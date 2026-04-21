import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry } from '@/types/logs'
import type { PostgresConfig } from '@/types/nodes'
import { BaseGenerator, type TickContext, SQL_QUERIES, pickRandom } from './BaseGenerator'
import { pickError } from './errorTemplates'

function formatPgTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC')
}

export class PostgresLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as unknown as PostgresConfig
    const cfg = node.config as Record<string, unknown>
    const errorScenario = (cfg.errorScenario as string) || 'none'
    const entries: LogEntry[] = []
    const ts = formatPgTimestamp(ctx.timestamp)
    const inboundFlows = ctx.inboundFlows.filter(flow => flow.requestCount > 0)

    for (const flow of inboundFlows) {
      const pid = 10000 + Math.floor(ctx.rng() * 9000)
      entries.push(this.createEntry(
        node,
        'INFO',
        `${ts} [${pid}] LOG:  connection received: host=${flow.srcIp} port=${flow.port} application_name=${flow.sourceLabel} requests=${flow.requestCount}`,
        'postgres',
        ctx.timestamp
      ))
    }

    // Generate based on incoming queries (flows from app nodes)
    const requestEvents = this.expandRequestEvents(inboundFlows, ctx)

    for (const event of requestEvents) {
      const eventTs = formatPgTimestamp(event.timestamp)
      const query = pickRandom(SQL_QUERIES, ctx.rng)
      const pid = 10000 + Math.floor(ctx.rng() * 9000)
      const durationMs = Math.round(ctx.rng() * 500 + 0.5)
      const db = (config.databases || ['app_db'])[0]

      if (event.isError) {
        const err = pickError('postgres', errorScenario, ctx.rng)
        if (err) {
          const level = err.level === 'FATAL' ? 'ERROR' : err.level
          entries.push(this.createEntry(node, level,
            `${eventTs} [${pid}] ${err.message}`,
            'postgres',
            event.timestamp
          ))
        }
        continue
      }

      // Execute log
      if (config.logStatement !== 'none') {
        entries.push(this.createEntry(node, 'INFO',
          `${eventTs} [${pid}] LOG:  execute <unnamed>: ${query}`,
          'postgres',
          event.timestamp
        ))
      }

      // Duration log
      if (durationMs > (config.slowQueryThresholdMs || 1000)) {
        entries.push(this.createEntry(node, 'WARN',
          `${eventTs} [${pid}] LOG:  duration: ${durationMs}.${Math.floor(ctx.rng() * 999)
            .toString().padStart(3, '0')} ms  statement: ${query}`,
          'postgres',
          event.timestamp
        ))
      } else if (ctx.rng() < 0.1) {
        entries.push(this.createEntry(node, 'DEBUG',
          `${eventTs} [${pid}] LOG:  duration: ${durationMs}.${Math.floor(ctx.rng() * 999)
            .toString().padStart(3, '0')} ms`,
          'postgres',
          event.timestamp
        ))
      }

      // Checkpoint logs
      if (ctx.tickIndex % 300 === 0 && event.sequence === 0) {
        entries.push(this.createEntry(node, 'INFO',
          `${ts} [1] LOG:  checkpoint starting: time`,
          'postgres',
          ctx.timestamp
        ))
        entries.push(this.createEntry(node, 'INFO',
          `${ts} [1] LOG:  checkpoint complete: wrote 42 buffers (0.3%); 0 WAL file(s) added, 0 removed, 0 recycled`,
          'postgres',
          ctx.timestamp
        ))
      }
      void db
    }

    return entries
  }
}
