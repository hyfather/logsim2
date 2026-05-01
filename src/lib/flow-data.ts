import type { ScenarioNode } from '@/types/nodes'
import type { Connection } from '@/types/connections'
import type { Scenario } from '@/types/scenario'
import type { ScenarioFlowNode, ConnectionFlowEdge } from '@/types/flow'

/** Satisfies React Flow's `node.data: Record<string, unknown>` without losing ScenarioNode typing. */
export function asFlowNodeData(data: ScenarioNode): ScenarioNode & Record<string, unknown> {
  return data as ScenarioNode & Record<string, unknown>
}

/** Satisfies React Flow's `edge.data: Record<string, unknown>`. */
export function asFlowEdgeData(data: Connection): Connection & Record<string, unknown> {
  return data as Connection & Record<string, unknown>
}

/** Convert a serialized scenario back into React Flow node/edge arrays. */
export function scenarioToFlow(scenario: Scenario): {
  flowNodes: ScenarioFlowNode[]
  flowEdges: ConnectionFlowEdge[]
} {
  const flowNodes = scenario.nodes.map<ScenarioFlowNode>(n => ({
    id: n.id,
    type: n.type,
    position: n.position,
    parentId: n.parentId || undefined,
    data: asFlowNodeData(n),
    style: n.size ? { width: n.size.width, height: n.size.height } : {},
    ...(n.parentId ? { extent: 'parent' as const } : {}),
  }))
  const flowEdges = scenario.connections.map<ConnectionFlowEdge>(c => ({
    id: c.id,
    source: c.sourceId,
    target: c.targetId,
    sourceHandle: c.sourceHandle,
    targetHandle: c.targetHandle,
    type: 'connectionEdge' as const,
    data: asFlowEdgeData(c),
    label: c.protocol.toUpperCase(),
  }))
  return { flowNodes, flowEdges }
}
