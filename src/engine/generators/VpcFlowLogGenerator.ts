import type { ScenarioNode } from '@/types/nodes'
import type { LogEntry } from '@/types/logs'
import { BaseGenerator, type TickContext, pickRandom } from './BaseGenerator'

const ACCOUNT_ID = '123456789012'

function randomEni(rng: () => number): string {
  const chars = '0123456789abcdef'
  let eni = 'eni-'
  for (let i = 0; i < 8; i++) {
    eni += chars[Math.floor(rng() * chars.length)]
  }
  return eni
}

const VPC_ACTIONS = ['ACCEPT', 'ACCEPT', 'ACCEPT', 'ACCEPT', 'REJECT'] as const
const LOG_STATUSES = ['OK', 'OK', 'OK', 'NODATA', 'SKIPDATA'] as const

export class VpcFlowLogGenerator extends BaseGenerator {
  generate(node: ScenarioNode, ctx: TickContext): LogEntry[] {
    const config = node.config as Record<string, unknown>
    if (!config.enableFlowLogs) return []

    const entries: LogEntry[] = []
    const flows = [...ctx.inboundFlows, ...ctx.outboundFlows]

    for (const flow of flows) {
      const action = pickRandom(VPC_ACTIONS, ctx.rng)
      const status = pickRandom(LOG_STATUSES, ctx.rng)
      const startTs = Math.floor(ctx.timestamp.getTime() / 1000)
      const endTs = startTs + Math.floor(ctx.rng() * 60) + 1
      const eni = randomEni(ctx.rng)
      const packets = Math.max(1, Math.floor(flow.requestCount * (1 + ctx.rng() * 5)))
      const bytes = flow.bytesSent

      // AWS VPC Flow Log format v2
      // version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status
      const raw = `2 ${ACCOUNT_ID} ${eni} ${flow.srcIp} ${flow.dstIp} ${Math.floor(ctx.rng() * 60000) + 1024} ${flow.port} 6 ${packets} ${bytes} ${startTs} ${endTs} ${action} ${status}`

      entries.push(this.createEntry(node, action === 'REJECT' ? 'WARN' : 'INFO', raw, 'vpc-flow', ctx.timestamp))
    }

    return entries
  }
}
