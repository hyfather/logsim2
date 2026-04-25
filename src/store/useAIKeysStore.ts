'use client'
import { create } from 'zustand'
import type { AIProvider, AIProviderConfig } from '@/types/aiKeys'
import { AI_PROVIDER_META } from '@/types/aiKeys'

// IMPORTANT: Keys are persisted ONLY to the browser's localStorage.
// They never leave the user's machine, are never sent to the LogSim backend,
// and are never serialized into scenarios, episodes, or any other shared file.

const STORAGE_KEY = 'logsim-ai-keys'

function nowIso(): string {
  return new Date().toISOString()
}

function loadFromStorage(): AIProviderConfig[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(item => item && typeof item.provider === 'string' && typeof item.apiKey === 'string')
  } catch {
    return []
  }
}

function saveToStorage(keys: AIProviderConfig[]) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
}

export interface SaveKeyInput {
  provider: AIProvider
  apiKey: string
  model?: string
  isDefault?: boolean
  note?: string
}

interface AIKeysState {
  keys: AIProviderConfig[]
  /** True after the initial localStorage hydrate completes (hydration-safe SSR). */
  hydrated: boolean

  /** Insert or replace the key for a given provider. There is at most one entry per provider. */
  upsertKey: (input: SaveKeyInput) => AIProviderConfig
  removeKey: (provider: AIProvider) => void
  setDefault: (provider: AIProvider) => void
  /** Get the configured key for a provider (or undefined). */
  getKey: (provider: AIProvider) => AIProviderConfig | undefined
  /** Get the default provider, or the first configured one, or undefined. */
  getDefaultKey: () => AIProviderConfig | undefined
}

export const useAIKeysStore = create<AIKeysState>()((set, get) => ({
  keys: [],
  hydrated: false,

  upsertKey: (input) => {
    const provider = input.provider
    const meta = AI_PROVIDER_META[provider]
    const existing = get().keys.find(k => k.provider === provider)
    const next: AIProviderConfig = {
      provider,
      apiKey: input.apiKey.trim(),
      model: (input.model ?? existing?.model ?? meta.defaultModel).trim() || meta.defaultModel,
      isDefault: input.isDefault ?? existing?.isDefault ?? get().keys.length === 0,
      note: input.note ?? existing?.note,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    }

    set(state => {
      const others = state.keys
        .filter(k => k.provider !== provider)
        .map(k => (next.isDefault ? { ...k, isDefault: false } : k))
      const merged = [...others, next].sort((a, b) => a.provider.localeCompare(b.provider))
      // Guarantee exactly one default (or zero if list is empty).
      if (!merged.some(k => k.isDefault) && merged.length > 0) merged[0].isDefault = true
      saveToStorage(merged)
      return { keys: merged }
    })
    return next
  },

  removeKey: (provider) => {
    set(state => {
      const wasDefault = state.keys.find(k => k.provider === provider)?.isDefault ?? false
      const filtered = state.keys.filter(k => k.provider !== provider)
      if (wasDefault && filtered.length > 0) filtered[0].isDefault = true
      saveToStorage(filtered)
      return { keys: filtered }
    })
  },

  setDefault: (provider) => {
    set(state => {
      if (!state.keys.some(k => k.provider === provider)) return state
      const next = state.keys.map(k => ({ ...k, isDefault: k.provider === provider }))
      saveToStorage(next)
      return { keys: next }
    })
  },

  getKey: (provider) => get().keys.find(k => k.provider === provider),

  getDefaultKey: () => {
    const all = get().keys
    return all.find(k => k.isDefault) ?? all[0]
  },
}))

// Hydrate after mount so SSR and the first client paint match. Without this the
// first render returns [] (no localStorage on the server) and React hydration
// mismatches if the store is read in a server-rendered tree.
if (typeof window !== 'undefined') {
  const initial = loadFromStorage()
  useAIKeysStore.setState({ keys: initial, hydrated: true })
}
