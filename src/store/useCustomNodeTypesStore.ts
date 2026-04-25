'use client'
import { create } from 'zustand'
import type { CustomNodeType } from '@/types/customNodeType'

// Persist user-created custom node types in the browser. Keys are local-only;
// they never travel to the LogSim backend or get serialized into shared scenarios.

const STORAGE_KEY = 'logsim-custom-node-types'

function loadFromStorage(): CustomNodeType[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is CustomNodeType =>
      t && typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.templates),
    )
  } catch {
    return []
  }
}

function saveToStorage(types: CustomNodeType[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(types))
}

interface CustomNodeTypesState {
  types: CustomNodeType[]
  hydrated: boolean
  upsert: (type: CustomNodeType) => void
  remove: (id: string) => void
  getById: (id: string) => CustomNodeType | undefined
}

export const useCustomNodeTypesStore = create<CustomNodeTypesState>()((set, get) => ({
  types: [],
  hydrated: false,
  upsert: (type) => {
    set(state => {
      const others = state.types.filter(t => t.id !== type.id)
      const next = [...others, type].sort((a, b) => a.name.localeCompare(b.name))
      saveToStorage(next)
      return { types: next }
    })
  },
  remove: (id) => {
    set(state => {
      const next = state.types.filter(t => t.id !== id)
      saveToStorage(next)
      return { types: next }
    })
  },
  getById: (id) => get().types.find(t => t.id === id),
}))

if (typeof window !== 'undefined') {
  useCustomNodeTypesStore.setState({ types: loadFromStorage(), hydrated: true })
}
