'use client'
import { create } from 'zustand'
import type { Scenario } from '@/types/scenario'
import type { Episode } from '@/types/episode'
import { generateId } from '@/lib/id'

// Persists user-created scenarios (canvas + timeline) in the browser. Each
// entry is a complete snapshot, so reloading the editor restores both the
// canvas and the timeline together — fixing the asymmetry where the canvas
// would come back populated but the timeline was empty.
//
// Layout in localStorage:
//   logsim-scenarios          : SavedScenario[] (newest first, capped)
//   logsim-current-scenario-id: id of the entry currently being edited

const SCENARIOS_KEY = 'logsim-scenarios'
const CURRENT_ID_KEY = 'logsim-current-scenario-id'
const MAX_RECENT = 20

export interface SavedScenario {
  id: string
  name: string
  scenario: Scenario
  episode: Episode
  savedAt: string
  createdAt: string
}

interface LibraryState {
  scenarios: SavedScenario[]
  currentId: string | null
  hydrated: boolean

  upsert: (entry: SavedScenario) => void
  remove: (id: string) => void
  setCurrentId: (id: string | null) => void
  getById: (id: string) => SavedScenario | undefined
  renameById: (id: string, name: string) => void
  /** Allocate a new id and mark it current; the next autosave creates the entry. */
  startNew: () => string
}

function loadFromStorage(): { scenarios: SavedScenario[]; currentId: string | null } {
  if (typeof window === 'undefined') return { scenarios: [], currentId: null }
  try {
    const rawScenarios = localStorage.getItem(SCENARIOS_KEY)
    const parsed = rawScenarios ? JSON.parse(rawScenarios) : []
    const scenarios: SavedScenario[] = Array.isArray(parsed)
      ? parsed.filter((e: unknown): e is SavedScenario => {
          if (!e || typeof e !== 'object') return false
          const r = e as Record<string, unknown>
          return (
            typeof r.id === 'string' &&
            typeof r.name === 'string' &&
            typeof r.savedAt === 'string' &&
            !!r.scenario &&
            !!r.episode
          )
        })
      : []
    const rawCurrent = localStorage.getItem(CURRENT_ID_KEY)
    const currentId = rawCurrent && scenarios.some(s => s.id === rawCurrent) ? rawCurrent : null
    return { scenarios, currentId }
  } catch {
    return { scenarios: [], currentId: null }
  }
}

function persistScenarios(scenarios: SavedScenario[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SCENARIOS_KEY, JSON.stringify(scenarios))
  } catch {
    // Quota exceeded or storage unavailable — drop oldest entries and retry once.
    if (scenarios.length > 1) {
      const trimmed = scenarios.slice(0, Math.floor(scenarios.length / 2))
      try { localStorage.setItem(SCENARIOS_KEY, JSON.stringify(trimmed)) } catch { /* give up */ }
    }
  }
}

function persistCurrentId(id: string | null) {
  if (typeof window === 'undefined') return
  if (id) localStorage.setItem(CURRENT_ID_KEY, id)
  else localStorage.removeItem(CURRENT_ID_KEY)
}

export const useScenarioLibraryStore = create<LibraryState>()((set, get) => ({
  scenarios: [],
  currentId: null,
  hydrated: false,

  upsert: (entry) => {
    set(state => {
      const existing = state.scenarios.find(s => s.id === entry.id)
      const merged: SavedScenario = {
        ...entry,
        createdAt: entry.createdAt ?? existing?.createdAt ?? entry.savedAt,
      }
      const others = state.scenarios.filter(s => s.id !== entry.id)
      const next = [merged, ...others]
        .sort((a, b) => (a.savedAt > b.savedAt ? -1 : 1))
        .slice(0, MAX_RECENT)
      persistScenarios(next)
      return { scenarios: next }
    })
  },

  remove: (id) => {
    set(state => {
      const next = state.scenarios.filter(s => s.id !== id)
      persistScenarios(next)
      let nextCurrent = state.currentId
      if (state.currentId === id) {
        nextCurrent = null
        persistCurrentId(null)
      }
      return { scenarios: next, currentId: nextCurrent }
    })
  },

  setCurrentId: (id) => {
    persistCurrentId(id)
    set({ currentId: id })
  },

  getById: (id) => get().scenarios.find(s => s.id === id),

  renameById: (id, name) => {
    set(state => {
      let changed = false
      const next = state.scenarios.map(s => {
        if (s.id !== id || s.name === name) return s
        changed = true
        return { ...s, name }
      })
      if (!changed) return {}
      persistScenarios(next)
      return { scenarios: next }
    })
  },

  startNew: () => {
    const id = generateId()
    persistCurrentId(id)
    set({ currentId: id })
    return id
  },
}))

if (typeof window !== 'undefined') {
  const { scenarios, currentId } = loadFromStorage()
  useScenarioLibraryStore.setState({ scenarios, currentId, hydrated: true })
}
