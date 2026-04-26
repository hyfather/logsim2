export type BehaviorState =
  | 'healthy'
  | 'degraded'
  | 'down'
  | 'recovering'
  | 'under_attack'
  | 'throttled'
  | 'compromised'

export interface BehaviorBlock {
  id: string
  start: number
  duration: number
  state: BehaviorState
  errorRate: number
  latencyMul: number
  logVolMul: number
  customLog?: string
  note?: string
}

export interface NarrativeBeat {
  id: string
  tick: number
  text: string
}

export interface Episode {
  id: string
  name: string
  description: string
  duration: number
  lanes: Record<string, BehaviorBlock[]>
  narrative: NarrativeBeat[]
  createdAt: string
  updatedAt: string
}

export interface EpisodeFileV2 {
  version: 2
  episode: Episode
}

/** @deprecated v1 segment-based file format; no longer loaded. */
export interface EpisodeFileV1 {
  version: 1
  episode: unknown
}
