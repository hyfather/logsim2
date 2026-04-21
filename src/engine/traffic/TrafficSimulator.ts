import type { Connection } from '@/types/connections'
import type { ScenarioNode } from '@/types/nodes'
import { getTrafficMultiplier } from './patterns'
import { getNodeIp } from '@/lib/network'

export interface TrafficFlow {
  connectionId: string
  sourceId: string
  targetId: string
  sourceLabel: string
  targetLabel: string
  protocol: string
  port: number
  requestCount: number
  bytesSent: number
  bytesReceived: number
  errorCount: number
  timestamp: string
  srcIp: string
  dstIp: string
}

const BYTES_PER_REQUEST_MIN = 200
const BYTES_PER_REQUEST_MAX = 50000

function randomInt(min: number, max: number, rng: () => number): number {
  return Math.floor(min + rng() * (max - min))
}

export class TrafficSimulator {
  generateFlows(
    connections: Connection[],
    nodes: ScenarioNode[],
    tickIndex: number,
    timestamp: string,
    rng: () => number
  ): TrafficFlow[] {
    const flows: TrafficFlow[] = []

    for (const conn of connections) {
      const baseRate = conn.trafficRate ?? 10
      const pattern = conn.trafficPattern ?? 'steady'
      const multiplier = getTrafficMultiplier(pattern, tickIndex, rng)
      const requestCount = Math.max(0, Math.round(baseRate * multiplier))

      if (requestCount === 0) continue

      const errorRate = (conn.errorRate ?? 0.01)
      const errorCount = Math.round(requestCount * errorRate)

      const srcNode = nodes.find(n => n.id === conn.sourceId)
      const dstNode = nodes.find(n => n.id === conn.targetId)

      const srcIp = srcNode ? getNodeIp(srcNode, nodes) : `10.0.0.${randomInt(1, 254, rng)}`
      const dstIp = dstNode ? getNodeIp(dstNode, nodes) : `10.0.1.${randomInt(1, 254, rng)}`

      flows.push({
        connectionId: conn.id,
        sourceId: conn.sourceId,
        targetId: conn.targetId,
        sourceLabel: srcNode?.label || conn.sourceId,
        targetLabel: dstNode?.label || conn.targetId,
        protocol: conn.protocol,
        port: conn.port,
        requestCount,
        bytesSent: requestCount * randomInt(BYTES_PER_REQUEST_MIN, BYTES_PER_REQUEST_MAX, rng),
        bytesReceived: requestCount * randomInt(BYTES_PER_REQUEST_MIN / 2, BYTES_PER_REQUEST_MAX / 2, rng),
        errorCount,
        timestamp,
        srcIp,
        dstIp,
      })
    }

    return flows
  }
}
