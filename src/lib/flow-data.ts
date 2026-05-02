import type { ScenarioNode } from '@/types/nodes'
import type { Connection } from '@/types/connections'
import type { Scenario } from '@/types/scenario'
import type { ScenarioFlowNode, ConnectionFlowEdge } from '@/types/flow'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'

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
  const connections = migrateBends(scenario.nodes, scenario.connections, scenario.version)

  const flowNodes = scenario.nodes.map<ScenarioFlowNode>(n => ({
    id: n.id,
    type: n.type,
    position: n.position,
    parentId: n.parentId || undefined,
    data: asFlowNodeData(n),
    style: n.size ? { width: n.size.width, height: n.size.height } : {},
    ...(n.parentId ? { extent: 'parent' as const } : {}),
  }))
  const flowEdges = connections.map<ConnectionFlowEdge>(c => ({
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

/**
 * Pre-v2 scenarios stored bendX/bendY as absolute world coordinates, which
 * means a bent edge would tear away from its endpoints whenever a parent
 * container moved. v2+ stores bend as an offset from the natural source→target
 * midpoint. Convert any legacy values on load so old saved scenarios continue
 * to render with the correct elbow position.
 */
function migrateBends(
  nodes: ScenarioNode[],
  connections: Connection[],
  version: number | undefined,
): Connection[] {
  if ((version ?? 1) >= 2) return connections
  if (!connections.some(c => c.bendX != null || c.bendY != null)) return connections

  const world = computeWorldRects(nodes)
  return connections.map(c => {
    if (c.bendX == null && c.bendY == null) return c
    const s = world.get(c.sourceId)
    const t = world.get(c.targetId)
    if (!s || !t) return c
    const midX = (s.x + s.width / 2 + t.x + t.width / 2) / 2
    const midY = (s.y + s.height / 2 + t.y + t.height / 2) / 2
    return {
      ...c,
      bendX: c.bendX != null ? c.bendX - midX : undefined,
      bendY: c.bendY != null ? c.bendY - midY : undefined,
    }
  })
}

interface WorldRect { x: number; y: number; width: number; height: number }

function computeWorldRects(nodes: ScenarioNode[]): Map<string, WorldRect> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const cache = new Map<string, WorldRect>()
  function world(id: string): WorldRect {
    const cached = cache.get(id)
    if (cached) return cached
    const n = byId.get(id)
    if (!n) {
      const empty = { x: 0, y: 0, width: 0, height: 0 }
      cache.set(id, empty)
      return empty
    }
    const w = n.size?.width ?? DEFAULT_NODE_SIZES[n.type]?.width ?? 200
    const h = n.size?.height ?? DEFAULT_NODE_SIZES[n.type]?.height ?? 100
    if (!n.parentId) {
      const r = { x: n.position.x, y: n.position.y, width: w, height: h }
      cache.set(id, r)
      return r
    }
    const parent = world(n.parentId)
    const r = { x: parent.x + n.position.x, y: parent.y + n.position.y, width: w, height: h }
    cache.set(id, r)
    return r
  }
  for (const n of nodes) world(n.id)
  return cache
}
