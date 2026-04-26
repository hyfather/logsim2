'use client'
import { create } from 'zustand'
import type { BehaviorBlock, Episode, NarrativeBeat } from '@/types/episode'
import { generateId } from '@/lib/id'

export type EpisodeRunStatus = 'idle' | 'running' | 'stopped'

interface EpisodeState {
  episode: Episode
  tick: number
  selectedBlockId: string | null
  runStatus: EpisodeRunStatus
  // Actions
  setEpisode: (episode: Episode) => void
  setEpisodeMeta: (patch: Partial<Pick<Episode, 'name' | 'description' | 'duration'>>) => void
  setTick: (tick: number) => void
  setSelectedBlock: (id: string | null) => void
  addBlock: (serviceId: string, block: BehaviorBlock) => void
  updateBlock: (blockId: string, patch: Partial<BehaviorBlock>) => void
  deleteBlock: (blockId: string) => void
  appendBlocks: (serviceId: string, blocks: BehaviorBlock[]) => void
  upsertBeat: (beat: NarrativeBeat) => void
  deleteBeat: (id: string) => void
  setRunStatus: (s: EpisodeRunStatus) => void
  resetEpisode: () => void
}

function defaultEpisode(): Episode {
  const now = new Date().toISOString()
  return {
    id: generateId(),
    name: 'Untitled Episode',
    description: '',
    duration: 1200,
    lanes: {},
    narrative: [],
    createdAt: now,
    updatedAt: now,
  }
}

function touch<T extends Episode>(ep: T): T {
  return { ...ep, updatedAt: new Date().toISOString() }
}

export const useEpisodeStore = create<EpisodeState>()((set, get) => ({
  episode: defaultEpisode(),
  tick: 0,
  selectedBlockId: null,
  runStatus: 'idle',

  setEpisode: (episode) => set({
    episode,
    tick: 0,
    selectedBlockId: null,
    runStatus: 'idle',
  }),

  setEpisodeMeta: (patch) => set(state => ({ episode: touch({ ...state.episode, ...patch }) })),

  setTick: (tick) => {
    const max = get().episode.duration
    set({ tick: Math.max(0, Math.min(max, tick)) })
  },

  setSelectedBlock: (selectedBlockId) => set({ selectedBlockId }),

  addBlock: (serviceId, block) => set(state => {
    const lanes = { ...state.episode.lanes }
    lanes[serviceId] = [...(lanes[serviceId] ?? []), block]
    return { episode: touch({ ...state.episode, lanes }), selectedBlockId: block.id }
  }),

  updateBlock: (blockId, patch) => set(state => {
    const lanes: Record<string, BehaviorBlock[]> = {}
    for (const [sid, blocks] of Object.entries(state.episode.lanes)) {
      lanes[sid] = blocks.map(b => (b.id === blockId ? { ...b, ...patch } : b))
    }
    return { episode: touch({ ...state.episode, lanes }) }
  }),

  deleteBlock: (blockId) => set(state => {
    const lanes: Record<string, BehaviorBlock[]> = {}
    for (const [sid, blocks] of Object.entries(state.episode.lanes)) {
      lanes[sid] = blocks.filter(b => b.id !== blockId)
    }
    const next = { ...state, episode: touch({ ...state.episode, lanes }) }
    if (state.selectedBlockId === blockId) next.selectedBlockId = null
    return next
  }),

  appendBlocks: (serviceId, blocks) => set(state => {
    const lanes = { ...state.episode.lanes }
    lanes[serviceId] = [...(lanes[serviceId] ?? []), ...blocks]
    return { episode: touch({ ...state.episode, lanes }) }
  }),

  upsertBeat: (beat) => set(state => {
    const exists = state.episode.narrative.find(b => b.id === beat.id)
    const narrative = exists
      ? state.episode.narrative.map(b => (b.id === beat.id ? { ...b, ...beat } : b))
      : [...state.episode.narrative, beat]
    narrative.sort((a, b) => a.tick - b.tick)
    return { episode: touch({ ...state.episode, narrative }) }
  }),

  deleteBeat: (id) => set(state => ({
    episode: touch({ ...state.episode, narrative: state.episode.narrative.filter(b => b.id !== id) }),
  })),

  setRunStatus: (runStatus) => set({ runStatus }),

  resetEpisode: () => set({ episode: defaultEpisode(), tick: 0, selectedBlockId: null, runStatus: 'idle' }),
}))
