import type { ScenarioNode } from '@/types/nodes'
import type { Connection } from '@/types/connections'

/** Satisfies React Flow's `node.data: Record<string, unknown>` without losing ScenarioNode typing. */
export function asFlowNodeData(data: ScenarioNode): ScenarioNode & Record<string, unknown> {
  return data as ScenarioNode & Record<string, unknown>
}

/** Satisfies React Flow's `edge.data: Record<string, unknown>`. */
export function asFlowEdgeData(data: Connection): Connection & Record<string, unknown> {
  return data as Connection & Record<string, unknown>
}
