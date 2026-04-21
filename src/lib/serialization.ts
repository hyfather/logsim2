import type { Scenario } from '@/types/scenario'
import type { ScenarioNode } from '@/types/nodes'
import type { Connection } from '@/types/connections'
import { computeChannel } from '@/engine/channels/ChannelManager'

export function serializeScenario(
  nodes: ScenarioNode[],
  connections: Connection[],
  metadata: Scenario['metadata']
): Scenario {
  return {
    version: 1,
    metadata: {
      ...metadata,
      updatedAt: new Date().toISOString(),
    },
    nodes,
    connections,
  }
}

export function deserializeScenario(data: unknown): Scenario {
  const scenario = data as Scenario
  if (!scenario.version || !scenario.nodes || !scenario.connections) {
    throw new Error('Invalid scenario file')
  }

  // Recompute channels from hierarchy
  const nodesWithChannels = recomputeChannels(scenario.nodes)

  return {
    ...scenario,
    nodes: nodesWithChannels,
  }
}

export function recomputeChannels(nodes: ScenarioNode[]): ScenarioNode[] {
  return nodes.map(node => ({
    ...node,
    channel: computeChannel(node, nodes),
  }))
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
