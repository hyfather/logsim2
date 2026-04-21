import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry, LogLevel } from '@/types/logs'
import type { NginxConfig } from '@/types/nodes'
import {
  BaseGenerator, type TickContext,
  USER_AGENTS, COMMON_PATHS, LOG_METHODS,
  pickRandom, randomLatency
} from './BaseGenerator'
import { pickError } from './errorTemplates'

const HTTP_STATUS_CODES = [200, 200, 200, 200, 200, 200, 200, 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 429, 500, 502, 503]
const HTTP_SUCCESS_STATUS_CODES = HTTP_STATUS_CODES.filter(code => code < 400)
const HTTP_ERROR_STATUS_CODES = HTTP_STATUS_CODES.filter(code => code >= 400)

function statusToLevel(status: number): LogLevel {
  if (status >= 500) return 'ERROR'
  if (status >= 400) return 'WARN'
  return 'INFO'
}

function formatNginxDate(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const day = String(d.getDate()).padStart(2, '0')
  const mon = months[d.getMonth()]
  const year = d.getFullYear()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${day}/${mon}/${year}:${h}:${m}:${s} +0000`
}

export class NginxLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as unknown as NginxConfig
    const cfg = node.config as Record<string, unknown>
    const errorScenario = (cfg.errorScenario as string) || 'none'
    const entries: LogEntry[] = []
    const inboundFlows = ctx.inboundFlows.filter(flow => flow.requestCount > 0)
    const outboundFlows = ctx.outboundFlows.filter(flow => flow.requestCount > 0)
    const requestFlows = inboundFlows.length > 0 ? inboundFlows : outboundFlows

    const requestEvents = this.expandRequestEvents(requestFlows, ctx)

    for (const event of requestEvents) {
      const ts = event.timestamp.toISOString()
      const nginxDate = formatNginxDate(event.timestamp)
      const method = pickRandom([...LOG_METHODS], ctx.rng)
      const path = pickRandom(COMMON_PATHS, ctx.rng)
      const flow = event.flow
      const ua = pickRandom(USER_AGENTS, ctx.rng)
      const referer = ctx.rng() > 0.7 ? 'https://example.com' : '-'

      if (event.isError) {
        const err = pickError('nginx', errorScenario, ctx.rng)
        const status = pickRandom(HTTP_ERROR_STATUS_CODES, ctx.rng)
        const connId = Math.floor(ctx.rng() * 100000)

        if (err) {
          const level = err.level === 'FATAL' ? 'ERROR' : err.level
          // Access log with error status
          if (config.accessLogFormat === 'json') {
            entries.push(this.createEntry(node, level, JSON.stringify({
              time: ts,
              remote_addr: flow.srcIp,
              method,
              uri: path,
              status,
              bytes_sent: 0,
              request_time: '30.000',
              error: err.message,
            }), 'nginx', event.timestamp))
          } else {
            entries.push(this.createEntry(node, level,
              `${flow.srcIp} - - [${nginxDate}] "${method} ${path} HTTP/1.1" ${status} 0 "${referer}" "${ua.substring(0, 80)}"`,
              'nginx', event.timestamp))
          }
          // Error log line
          entries.push(this.createEntry(node, level,
            `${ts} [${level.toLowerCase()}] 12345#0: *${connId} ${err.message}, client: ${flow.srcIp}, server: _, request: "${method} ${path} HTTP/1.1"`,
            'nginx', event.timestamp))
        } else {
          // Generic error
          const level = statusToLevel(status)
          if (config.accessLogFormat === 'json') {
            entries.push(this.createEntry(node, level, JSON.stringify({
              time: ts, remote_addr: flow.srcIp, method, uri: path, status, bytes_sent: 0, request_time: '0.001',
            }), 'nginx', event.timestamp))
          } else {
            entries.push(this.createEntry(node, level,
              `${flow.srcIp} - - [${nginxDate}] "${method} ${path} HTTP/1.1" ${status} 0 "${referer}" "${ua.substring(0, 80)}"`,
              'nginx', event.timestamp))
          }
        }
      } else {
        const status = pickRandom(HTTP_SUCCESS_STATUS_CODES, ctx.rng)
        const bytes = Math.floor(ctx.rng() * 50000) + 100
        const latency = randomLatency(20, ctx.rng)
        const level = statusToLevel(status)

        let raw: string
        if (config.accessLogFormat === 'json') {
          raw = JSON.stringify({
            time: ts,
            remote_addr: flow.srcIp,
            method,
            uri: path,
            status,
            bytes_sent: bytes,
            request_time: (latency / 1000).toFixed(3),
            http_referer: referer,
            http_user_agent: ua.substring(0, 80),
          })
        } else {
          raw = `${flow.srcIp} - - [${nginxDate}] "${method} ${path} HTTP/1.1" ${status} ${bytes} "${referer}" "${ua.substring(0, 80)}"`
        }
        entries.push(this.createEntry(node, level, raw, 'nginx', event.timestamp))
      }
    }

    return entries
  }
}
