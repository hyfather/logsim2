'use client'
import { create } from 'zustand'
import type { Episode, EpisodeSegment } from '@/types/episode'
import { generateId } from '@/lib/id'

export type EpisodeRunStatus = 'idle' | 'running' | 'stopped'

interface EpisodeState {
  episode: Episode
  selectedSegmentId: string | null
  editingSegmentId: string | null
  runStatus: EpisodeRunStatus
  runningSegmentId: string | null
  runProgressTicks: number // ticks within the currently running segment
  // Actions
  setEpisode: (episode: Episode) => void
  setEpisodeMeta: (patch: Partial<Pick<Episode, 'name' | 'description'>>) => void
  addSegment: (seed?: Partial<EpisodeSegment>) => string
  forkSegment: (segmentId: string) => string | null
  removeSegment: (segmentId: string) => void
  updateSegment: (segmentId: string, patch: Partial<EpisodeSegment>) => void
  moveSegment: (segmentId: string, delta: -1 | 1) => void
  selectSegment: (id: string | null) => void
  setEditingSegment: (id: string | null) => void
  setRunStatus: (s: EpisodeRunStatus) => void
  setRunningSegment: (id: string | null) => void
  setRunProgress: (ticks: number) => void
  resetRun: () => void
}

const DEFAULT_BASELINE_YAML = `- name: Baseline
- description: |
    Default baseline segment. Replace this with your scenario YAML.
- nodes: []
- services: []
- connections: []
`

function defaultEpisode(): Episode {
  const now = new Date().toISOString()
  return {
    id: generateId(),
    name: 'Untitled Episode',
    description: '',
    createdAt: now,
    updatedAt: now,
    segments: [
      {
        id: generateId(),
        name: 'Baseline',
        ticks: 300,
        scenarioYaml: DEFAULT_BASELINE_YAML,
      },
    ],
  }
}

export const useEpisodeStore = create<EpisodeState>()((set, get) => ({
  episode: defaultEpisode(),
  selectedSegmentId: null,
  editingSegmentId: null,
  runStatus: 'idle',
  runningSegmentId: null,
  runProgressTicks: 0,

  setEpisode: (episode) => set({
    episode,
    selectedSegmentId: episode.segments[0]?.id ?? null,
    editingSegmentId: null,
    runStatus: 'idle',
    runningSegmentId: null,
    runProgressTicks: 0,
  }),

  setEpisodeMeta: (patch) => set(state => ({
    episode: { ...state.episode, ...patch, updatedAt: new Date().toISOString() },
  })),

  addSegment: (seed) => {
    const id = generateId()
    const { episode } = get()
    const newSegment: EpisodeSegment = {
      id,
      name: seed?.name ?? `Segment ${episode.segments.length + 1}`,
      ticks: seed?.ticks ?? 300,
      scenarioYaml: seed?.scenarioYaml ?? DEFAULT_BASELINE_YAML,
      parentId: seed?.parentId,
    }
    set({
      episode: {
        ...episode,
        segments: [...episode.segments, newSegment],
        updatedAt: new Date().toISOString(),
      },
      selectedSegmentId: id,
    })
    return id
  },

  forkSegment: (segmentId) => {
    const { episode } = get()
    const parent = episode.segments.find(s => s.id === segmentId)
    if (!parent) return null
    const id = generateId()
    const forked: EpisodeSegment = {
      id,
      name: `${parent.name} (fork)`,
      ticks: parent.ticks,
      scenarioYaml: parent.scenarioYaml,
      parentId: parent.id,
    }
    const idx = episode.segments.findIndex(s => s.id === segmentId)
    const nextSegments = [
      ...episode.segments.slice(0, idx + 1),
      forked,
      ...episode.segments.slice(idx + 1),
    ]
    set({
      episode: { ...episode, segments: nextSegments, updatedAt: new Date().toISOString() },
      selectedSegmentId: id,
      editingSegmentId: id,
    })
    return id
  },

  removeSegment: (segmentId) => {
    const { episode, selectedSegmentId } = get()
    if (episode.segments.length <= 1) return
    const nextSegments = episode.segments.filter(s => s.id !== segmentId)
    set({
      episode: { ...episode, segments: nextSegments, updatedAt: new Date().toISOString() },
      selectedSegmentId: selectedSegmentId === segmentId ? (nextSegments[0]?.id ?? null) : selectedSegmentId,
    })
  },

  updateSegment: (segmentId, patch) => set(state => ({
    episode: {
      ...state.episode,
      segments: state.episode.segments.map(s =>
        s.id === segmentId ? { ...s, ...patch } : s
      ),
      updatedAt: new Date().toISOString(),
    },
  })),

  moveSegment: (segmentId, delta) => {
    const { episode } = get()
    const idx = episode.segments.findIndex(s => s.id === segmentId)
    if (idx === -1) return
    const target = idx + delta
    if (target < 0 || target >= episode.segments.length) return
    const next = [...episode.segments]
    const [moved] = next.splice(idx, 1)
    next.splice(target, 0, moved)
    set({ episode: { ...episode, segments: next, updatedAt: new Date().toISOString() } })
  },

  selectSegment: (id) => set({ selectedSegmentId: id }),
  setEditingSegment: (id) => set({ editingSegmentId: id }),
  setRunStatus: (runStatus) => set({ runStatus }),
  setRunningSegment: (id) => set({ runningSegmentId: id }),
  setRunProgress: (runProgressTicks) => set({ runProgressTicks }),
  resetRun: () => set({ runStatus: 'idle', runningSegmentId: null, runProgressTicks: 0 }),
}))
