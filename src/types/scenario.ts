import type { ScenarioNode } from './nodes'
import type { Connection } from './connections'

export interface ScenarioMetadata {
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface Scenario {
  /** v2: bendX/bendY are stored as offsets from the source→target midpoint
   *  (v1 stored them as absolute world coords; loaders auto-migrate). */
  version: 1 | 2
  metadata: ScenarioMetadata
  nodes: ScenarioNode[]
  connections: Connection[]
}
