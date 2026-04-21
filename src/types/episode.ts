import type { ScenarioFlowNode, ConnectionFlowEdge } from './flow'
import type { ScenarioMetadata } from './scenario'

export interface SegmentCanvasSnapshot {
  nodes: ScenarioFlowNode[]
  edges: ConnectionFlowEdge[]
  metadata: ScenarioMetadata
}

export interface EpisodeSegment {
  id: string
  name: string
  ticks: number
  scenarioYaml: string
  parentId?: string
  canvas?: SegmentCanvasSnapshot
}

export interface Episode {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  segments: EpisodeSegment[]
}

export interface EpisodeFileV1 {
  version: 1
  episode: Episode
}
