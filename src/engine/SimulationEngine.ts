import type { ScenarioNode } from '@/types/nodes'
import type { Connection } from '@/types/connections'
import type { LogEntry } from '@/types/logs'
import { TrafficSimulator } from './traffic/TrafficSimulator'
import type { TrafficFlow } from './traffic/TrafficSimulator'
import { getGeneratorForNode } from './generators'
import { createRng, type TickContext } from './generators/BaseGenerator'
import { matchesChannel } from './channels/ChannelMatcher'
import { getNodeIp } from '@/lib/network'
import { getTrafficMultiplier } from './traffic/patterns'

export interface SimulationConfig {
  tickIntervalMs?: number // simulated ms per tick (default: 1000)
  seed?: number
  startTime?: number // unix ms
  channelFilter?: string
}

export class SimulationEngine {
  private trafficSimulator = new TrafficSimulator()
  private tickIndex = 0
  private startTime: number
  private rng: () => number
  private config: SimulationConfig

  constructor(config: SimulationConfig = {}) {
    this.config = config
    this.startTime = config.startTime ?? Date.now()
    this.rng = createRng(config.seed ?? Math.floor(Math.random() * 1000000))
  }

  private generateTick(
    nodes: ScenarioNode[],
    connections: Connection[],
  ): { logs: LogEntry[]; flows: TrafficFlow[] } {
    const tickInterval = this.config.tickIntervalMs ?? 1000
    const timestamp = new Date(this.startTime + this.tickIndex * tickInterval)

    // Generate traffic flows for this tick
    const flows = this.trafficSimulator.generateFlows(
      connections,
      nodes,
      this.tickIndex,
      timestamp.toISOString(),
      this.rng
    )

    const allLogs: LogEntry[] = []

    // Track which nodes have connections
    const nodesWithConnections = new Set<string>()
    for (const conn of connections) {
      nodesWithConnections.add(conn.sourceId)
      nodesWithConnections.add(conn.targetId)
    }

    for (const node of nodes) {
      const generator = getGeneratorForNode(node)
      if (!generator) continue

      // Determine inbound/outbound flows for this node
      let inboundFlows = flows.filter(f => f.targetId === node.id)
      const outboundFlows = flows.filter(f => f.sourceId === node.id)

      // Synthesize self-traffic for standalone service nodes
      if (node.type === 'service' && !nodesWithConnections.has(node.id) && inboundFlows.length === 0 && outboundFlows.length === 0) {
        const cfg = node.config as Record<string, unknown>
        const trafficRate = (cfg.trafficRate ?? cfg.qps ?? cfg.opsRate ?? 10) as number
        if (trafficRate > 0) {
          const multiplier = getTrafficMultiplier('steady', this.tickIndex, this.rng)
          const requestCount = Math.max(0, Math.round(trafficRate * multiplier))
          const errorRate = (cfg.errorRate ?? 0.02) as number
          const errorCount = Math.round(requestCount * errorRate)
          const nodeIp = getNodeIp(node, nodes)
          const clientIp = `10.${Math.floor(this.rng() * 255)}.${Math.floor(this.rng() * 255)}.${Math.floor(this.rng() * 254) + 1}`

          inboundFlows = [{
            connectionId: `self-${node.id}`,
            sourceId: node.id,
            targetId: node.id,
            sourceLabel: 'client',
            targetLabel: node.label,
            protocol: 'http',
            port: (cfg.port ?? 80) as number,
            requestCount,
            bytesSent: requestCount * (200 + Math.floor(this.rng() * 5000)),
            bytesReceived: requestCount * (100 + Math.floor(this.rng() * 2500)),
            errorCount,
            timestamp: timestamp.toISOString(),
            srcIp: clientIp,
            dstIp: nodeIp,
          }]
        }
      }

      const ctx: TickContext = {
        tickIndex: this.tickIndex,
        timestamp,
        tickIntervalMs: tickInterval,
        inboundFlows,
        outboundFlows,
        rng: this.rng,
      }

      const logs = generator.generate(node, ctx)

      // Apply channel filter
      const channelFilter = this.config.channelFilter
      const filtered = channelFilter
        ? logs.filter(l => matchesChannel(l.channel, channelFilter))
        : logs

      allLogs.push(...filtered)
    }

    this.tickIndex++

    return {
      logs: allLogs.sort((a, b) => a.ts.localeCompare(b.ts)),
      flows,
    }
  }

  tick(
    nodes: ScenarioNode[],
    connections: Connection[],
  ): LogEntry[] {
    return this.generateTick(nodes, connections).logs
  }

  tickWithFlows(
    nodes: ScenarioNode[],
    connections: Connection[],
  ): { logs: LogEntry[]; flows: TrafficFlow[] } {
    return this.generateTick(nodes, connections)
  }

  bulkGenerate(
    nodes: ScenarioNode[],
    connections: Connection[],
    durationMs: number,
    channelFilter?: string,
    onProgress?: (progress: number) => void
  ): LogEntry[] {
    const tickInterval = this.config.tickIntervalMs ?? 1000
    const totalTicks = Math.ceil(durationMs / tickInterval)
    const allLogs: LogEntry[] = []

    this.config.channelFilter = channelFilter

    for (let i = 0; i < totalTicks; i++) {
      const logs = this.tick(nodes, connections)
      allLogs.push(...logs)

      if (onProgress && i % Math.max(1, Math.floor(totalTicks / 100)) === 0) {
        onProgress(i / totalTicks)
      }
    }

    return allLogs
  }

  reset(config?: SimulationConfig) {
    this.config = config || this.config
    this.tickIndex = 0
    this.startTime = this.config.startTime ?? Date.now()
    this.rng = createRng(this.config.seed ?? Math.floor(Math.random() * 1000000))
  }

  getTickIndex(): number {
    return this.tickIndex
  }

  getCurrentTime(): Date {
    const tickInterval = this.config.tickIntervalMs ?? 1000
    return new Date(this.startTime + this.tickIndex * tickInterval)
  }
}
