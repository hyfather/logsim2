import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry, LogLevel } from '@/types/logs'
import type { GolangConfig } from '@/types/nodes'
import {
  BaseGenerator, type TickContext,
  USER_AGENTS, COMMON_PATHS, LOG_METHODS,
  pickRandom, randomLatency
} from './BaseGenerator'
import { pickError } from './errorTemplates'

function statusToLevel(status: number): LogLevel {
  if (status >= 500) return 'ERROR'
  if (status >= 400) return 'WARN'
  return 'INFO'
}

const GO_STATUS_CODES = [200, 200, 200, 200, 201, 204, 400, 401, 404, 500, 503]
const GO_SUCCESS_STATUS_CODES = GO_STATUS_CODES.filter(code => code < 400)
const GO_ERROR_STATUS_CODES = GO_STATUS_CODES.filter(code => code >= 400)

export class GolangLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as unknown as GolangConfig
    const cfg = node.config as Record<string, unknown>
    const errorScenario = (cfg.errorScenario as string) || 'none'
    const entries: LogEntry[] = []
    const inboundFlows = ctx.inboundFlows.filter(flow => flow.requestCount > 0)
    const outboundFlows = ctx.outboundFlows.filter(flow => flow.requestCount > 0)
    const requestFlows = inboundFlows.length > 0 ? inboundFlows : outboundFlows
    if (requestFlows.length === 0) return []

    const requestEvents = this.expandRequestEvents(requestFlows, ctx)

    for (const event of requestEvents) {
      const ts = event.timestamp.toISOString()
      const method = pickRandom([...LOG_METHODS], ctx.rng)
      const path = pickRandom(COMMON_PATHS, ctx.rng)
      const flow = event.flow
      const ua = pickRandom(USER_AGENTS, ctx.rng)
      const clientIp = inboundFlows.length > 0 ? flow.srcIp : flow.dstIp

      if (event.isError) {
        const err = pickError('golang', errorScenario, ctx.rng)
        const status = pickRandom(GO_ERROR_STATUS_CODES, ctx.rng)
        const latency = randomLatency(100, ctx.rng)

        if (err) {
          const level = err.level === 'FATAL' ? 'ERROR' : err.level
          let raw: string
          if (config.logFormat === 'json') {
            raw = JSON.stringify({
              time: ts,
              level: level.toLowerCase(),
              msg: err.message,
              method,
              path,
              status,
              latency_ms: latency,
              client_ip: clientIp,
              framework: config.framework || 'gin',
              ...(err.level === 'FATAL' ? { stack: 'goroutine 1 [running]' } : {}),
            })
          } else {
            const dateStr = event.timestamp.toISOString().replace('T', ' - ').replace(/\.\d+Z$/, '')
            raw = `[${(config.framework || 'GIN').toUpperCase()}] ${dateStr} | ${status} | ${latency}ms | ${clientIp} | ${method} "${path}" | ${err.message}`
          }
          entries.push(this.createEntry(node, level, raw, 'golang', event.timestamp))
        } else {
          const level = statusToLevel(status)
          let raw: string
          if (config.logFormat === 'json') {
            raw = JSON.stringify({ time: ts, level: level.toLowerCase(), msg: 'request', method, path, status, latency_ms: latency, client_ip: clientIp, framework: config.framework || 'gin' })
          } else {
            const dateStr = event.timestamp.toISOString().replace('T', ' - ').replace(/\.\d+Z$/, '')
            raw = `[${(config.framework || 'GIN').toUpperCase()}] ${dateStr} | ${status} | ${latency}ms | ${clientIp} | ${method} "${path}"`
          }
          entries.push(this.createEntry(node, level, raw, 'golang', event.timestamp))
        }
      } else {
        const status = pickRandom(GO_SUCCESS_STATUS_CODES, ctx.rng)
        const latency = randomLatency(30, ctx.rng)
        const level = statusToLevel(status)

        let raw: string
        if (config.logFormat === 'json') {
          raw = JSON.stringify({
            time: ts,
            level: level.toLowerCase(),
            msg: inboundFlows.length > 0 ? 'request' : 'dependency_call',
            method,
            path,
            status,
            latency_ms: latency,
            client_ip: clientIp,
            user_agent: ua,
            framework: config.framework || 'gin',
          })
        } else {
          const dateStr = event.timestamp.toISOString().replace('T', ' - ').replace(/\.\d+Z$/, '')
          raw = `[${(config.framework || 'GIN').toUpperCase()}] ${dateStr} | ${status} | ${latency}ms | ${clientIp} | ${method} "${path}" | ${ua.slice(0, 80)}${inboundFlows.length > 0 ? '' : ` | upstream=${flow.targetLabel}`}`
        }
        entries.push(this.createEntry(node, level, raw, 'golang', event.timestamp))
      }
    }

    return entries
  }
}
