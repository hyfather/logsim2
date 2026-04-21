import type { Node, Edge } from '@xyflow/react'
import type { ScenarioNode } from './nodes'
import type { Connection } from './connections'

/** React Flow node carrying a `ScenarioNode` in `data`. */
export type ScenarioFlowNode = Node<ScenarioNode & Record<string, unknown>>

/** Custom edge type `connectionEdge` with `Connection` in `data`. */
export type ConnectionFlowEdge = Edge<Connection & Record<string, unknown>, 'connectionEdge'>
