import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry } from '@/types/logs'
import type { MysqlConfig } from '@/types/nodes'
import { BaseGenerator, type TickContext, SQL_QUERIES, pickRandom } from './BaseGenerator'
import { pickError } from './errorTemplates'

export class MysqlLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as unknown as MysqlConfig
    const cfg = node.config as Record<string, unknown>
    const errorScenario = (cfg.errorScenario as string) || 'none'
    const entries: LogEntry[] = []
    const inboundFlows = ctx.inboundFlows.filter(flow => flow.requestCount > 0)
    const ts = ctx.timestamp.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

    for (const flow of inboundFlows) {
      const threadId = Math.floor(ctx.rng() * 1000) + 1
      entries.push(this.createEntry(
        node,
        'INFO',
        `${ts} ${threadId} Connect\t${flow.sourceLabel}@${flow.srcIp} on ${(config.databases || ['app_db'])[0]} via ${flow.protocol.toUpperCase()} requests=${flow.requestCount}`,
        'mysql',
        ctx.timestamp
      ))
    }

    const requestEvents = this.expandRequestEvents(inboundFlows, ctx)

    for (const event of requestEvents) {
      const eventTs = event.timestamp.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
      const query = pickRandom(SQL_QUERIES, ctx.rng)
      const flow = event.flow
      const threadId = Math.floor(ctx.rng() * 1000) + 1
      const durationMs = ctx.rng() * 600

      if (event.isError) {
        const err = pickError('mysql', errorScenario, ctx.rng)
        if (err) {
          const level = err.level === 'FATAL' ? 'ERROR' : err.level
          entries.push(this.createEntry(node, level,
            `${eventTs} ${threadId} ${err.message}`,
            'mysql',
            event.timestamp
          ))
        }
        continue
      }

      if (config.slowQueryLog && durationMs > (config.slowQueryThresholdMs || 2000)) {
        entries.push(this.createEntry(node, 'WARN',
          `# Time: ${eventTs}\n# User@Host: app[app] @ server [${flow.srcIp}]  Id: ${threadId}\n# Query_time: ${(durationMs).toFixed(6)}  Lock_time: 0.000100 Rows_sent: 1  Rows_examined: 1000\nSET timestamp=${Math.floor(event.timestamp.getTime() / 1000)};\n${query};`,
          'mysql',
          event.timestamp
        ))
      }

      // General log
      entries.push(this.createEntry(node, 'INFO',
        `${eventTs} ${threadId} Query\t${query}`,
        'mysql',
        event.timestamp
      ))
    }

    return entries
  }
}
