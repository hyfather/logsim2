'use client'
import { create } from 'zustand'
import type { DestinationConfig, DestinationStatus } from '@/types/destinations'

const STORAGE_KEY = 'logsim-destinations'

// ── Persistence helpers ──────────────────────────────────────────────────────

function loadFromStorage(): DestinationConfig[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToStorage(destinations: DestinationConfig[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(destinations))
}

function generateId(): string {
  return `dest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Store types ──────────────────────────────────────────────────────────────

interface DestinationsState {
  destinations: DestinationConfig[]

  // Per-destination runtime state (not persisted)
  statuses: Record<string, DestinationStatus>
  errors: Record<string, string>
  sentCounts: Record<string, number>
  lastSentAt: Record<string, string>

  // Modal state
  showManagerModal: boolean
  editingId: string | null   // id of destination being edited; null = adding new

  // Destination CRUD
  addDestination: (config: Omit<DestinationConfig, 'id'>) => string
  updateDestination: (id: string, patch: Partial<Omit<DestinationConfig, 'id' | 'type'>>) => void
  removeDestination: (id: string) => void
  toggleDestination: (id: string) => void

  // Runtime status tracking
  setStatus: (id: string, status: DestinationStatus, error?: string) => void
  recordSent: (id: string, count: number) => void

  // Modal controls
  setShowManagerModal: (show: boolean) => void
  setEditingId: (id: string | null) => void
}

// ── Store ────────────────────────────────────────────────────────────────────

const initialDestinations = loadFromStorage()

export const useDestinationsStore = create<DestinationsState>()((set) => ({
  destinations: initialDestinations,
  statuses: {},
  errors: {},
  sentCounts: {},
  lastSentAt: {},
  showManagerModal: false,
  editingId: null,

  addDestination: (config) => {
    const id = generateId()
    const dest = { ...config, id } as DestinationConfig
    set(state => {
      const next = [...state.destinations, dest]
      saveToStorage(next)
      return { destinations: next }
    })
    return id
  },

  updateDestination: (id, patch) => {
    set(state => {
      const next = state.destinations.map(d =>
        d.id === id ? { ...d, ...patch } as DestinationConfig : d
      )
      saveToStorage(next)
      return { destinations: next }
    })
  },

  removeDestination: (id) => {
    set(state => {
      const next = state.destinations.filter(d => d.id !== id)
      saveToStorage(next)
      const { [id]: _s, ...statuses } = state.statuses
      const { [id]: _e, ...errors } = state.errors
      const { [id]: _c, ...sentCounts } = state.sentCounts
      const { [id]: _l, ...lastSentAt } = state.lastSentAt
      return { destinations: next, statuses, errors, sentCounts, lastSentAt }
    })
  },

  toggleDestination: (id) => {
    set(state => {
      const next = state.destinations.map(d =>
        d.id === id ? { ...d, enabled: !d.enabled } as DestinationConfig : d
      )
      saveToStorage(next)
      return { destinations: next }
    })
  },

  setStatus: (id, status, error) => {
    set(state => ({
      statuses: { ...state.statuses, [id]: status },
      errors: error !== undefined
        ? { ...state.errors, [id]: error }
        : state.errors,
    }))
  },

  recordSent: (id, count) => {
    set(state => ({
      statuses: { ...state.statuses, [id]: 'idle' },
      errors: { ...state.errors, [id]: '' },
      sentCounts: { ...state.sentCounts, [id]: (state.sentCounts[id] ?? 0) + count },
      lastSentAt: { ...state.lastSentAt, [id]: new Date().toISOString() },
    }))
  },

  setShowManagerModal: (show) => set({ showManagerModal: show }),
  setEditingId: (id) => set({ editingId: id }),
}))
