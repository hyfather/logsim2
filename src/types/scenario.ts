import type { ScenarioNode } from './nodes'
import type { Connection } from './connections'

export interface ScenarioMetadata {
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface Scenario {
  version: 1
  metadata: ScenarioMetadata
  nodes: ScenarioNode[]
  connections: Connection[]
}
