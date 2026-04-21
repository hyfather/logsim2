import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry, LogLevel } from '@/types/logs'
import type { NodejsConfig, Endpoint } from '@/types/nodes'
import {
  BaseGenerator, type TickContext,
  USER_AGENTS, COMMON_PATHS, LOG_METHODS,
  pickRandom, randomLatency
} from './BaseGenerator'
import { pickError } from './errorTemplates'

const SUCCESS_STATUS_CODES = [200, 200, 200, 200, 201, 202, 204, 301, 304]
const ERROR_STATUS_CODES = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]

function statusToLevel(status: number): LogLevel {
  if (status >= 500) return 'ERROR'
  if (status >= 400) return 'WARN'
  return 'INFO'
}

export class NodejsLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as unknown as NodejsConfig
    const cfg = node.config as Record<string, unknown>
    const errorScenario = (cfg.errorScenario as string) || 'none'
    const entries: LogEntry[] = []
    const inboundFlows = ctx.inboundFlows.filter(flow => flow.requestCount > 0)
    const outboundFlows = ctx.outboundFlows.filter(flow => flow.requestCount > 0)
    const requestFlows = inboundFlows.length > 0 ? inboundFlows : outboundFlows

    if (requestFlows.length === 0) return []

    const endpoints: Endpoint[] = config.endpoints || []
    const defaultEndpoints = COMMON_PATHS.map(p => ({
      method: pickRandom([...LOG_METHODS], ctx.rng),
      path: p,
      avgLatencyMs: 50,
      errorRate: 0.02,
    }))
    const availableEndpoints = endpoints.length > 0 ? endpoints : defaultEndpoints

    const requestEvents = this.expandRequestEvents(requestFlows, ctx)

    for (const event of requestEvents) {
      const endpoint = pickRandom(availableEndpoints, ctx.rng)
      const flow = event.flow
      const ts = event.timestamp.toISOString()
      const ua = pickRandom(USER_AGENTS, ctx.rng)
      const remoteAddr = inboundFlows.length > 0 ? flow.srcIp : flow.dstIp

      if (event.isError) {
        const err = pickError('nodejs', errorScenario, ctx.rng)
        const status = pickRandom(ERROR_STATUS_CODES, ctx.rng)
        const latency = randomLatency((endpoint.avgLatencyMs || 50) * 3, ctx.rng)

        if (err) {
          const level = err.level === 'FATAL' ? 'ERROR' : err.level
          let raw: string
          if (config.logFormat === 'json') {
            raw = JSON.stringify({
              level: level.toLowerCase(),
              timestamp: ts,
              method: endpoint.method,
              path: endpoint.path,
              statusCode: status,
              responseTime: latency,
              error: err.message,
              remoteAddr,
              framework: config.framework || 'express',
            })
          } else {
            raw = `${ts} ${level} [${config.framework || 'express'}] ${endpoint.method} ${endpoint.path} ${status} ${latency}ms - ${err.message}`
          }
          entries.push(this.createEntry(node, level, raw, 'nodejs', event.timestamp))
        } else {
          // Generic error (no scenario selected)
          const level = statusToLevel(status)
          let raw: string
          if (config.logFormat === 'json') {
            raw = JSON.stringify({
              level: level.toLowerCase(),
              timestamp: ts,
              method: endpoint.method,
              path: endpoint.path,
              statusCode: status,
              responseTime: latency,
              remoteAddr,
              framework: config.framework || 'express',
            })
          } else {
            raw = `${ts} ${level} [${config.framework || 'express'}] ${endpoint.method} ${endpoint.path} ${status} ${latency}ms - "${ua.substring(0, 60)}"`
          }
          entries.push(this.createEntry(node, level, raw, 'nodejs', event.timestamp))
        }
      } else {
        const status = pickRandom(SUCCESS_STATUS_CODES, ctx.rng)
        const latency = randomLatency(endpoint.avgLatencyMs || 50, ctx.rng)
        const level = statusToLevel(status)

        let raw: string
        if (config.logFormat === 'json') {
          raw = JSON.stringify({
            level: level.toLowerCase(),
            timestamp: ts,
            method: endpoint.method,
            path: endpoint.path,
            statusCode: status,
            responseTime: latency,
            remoteAddr,
            userAgent: ua.substring(0, 80),
            framework: config.framework || 'express',
            direction: inboundFlows.length > 0 ? 'inbound' : 'outbound',
          })
        } else {
          raw = `${ts} ${level} [${config.framework || 'express'}] ${endpoint.method} ${endpoint.path} ${status} ${latency}ms - "${ua.substring(0, 60)}"${inboundFlows.length > 0 ? '' : ` upstream=${flow.targetLabel}`}`
        }
        entries.push(this.createEntry(node, level, raw, 'nodejs', event.timestamp))
      }
    }

    // Startup/lifecycle logs occasionally
    if (requestEvents.length === 0 && (ctx.tickIndex === 0 || ctx.rng() < 0.001)) {
      const ts = ctx.timestamp.toISOString()
      const startMsg = config.logFormat === 'json'
        ? JSON.stringify({ level: 'info', timestamp: ts, message: `Server listening on port ${config.port || 3000}`, framework: config.framework })
        : `${ts} INFO [${config.framework}] Server listening on port ${config.port || 3000}`
      entries.push(this.createEntry(node, 'INFO', startMsg, 'nodejs', ctx.timestamp))
    }

    return entries
  }
}
