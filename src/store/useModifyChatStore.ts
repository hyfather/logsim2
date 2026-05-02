'use client'
import { create } from 'zustand'
import type { ModifyChatTurn } from '@/lib/scenarioPrompt'

/**
 * In-memory chat state for the "Modify with AI" sidebar. Lives outside the
 * panel component so closing the panel (e.g. when Run swaps the rail to logs)
 * doesn't lose the conversation. Cleared whenever the active scenario id
 * changes — history was tied to a specific canvas. Not persisted to storage.
 */
interface ModifyChatState {
  history: ModifyChatTurn[]
  draft: string
  scenarioId: string | null
  appendTurn: (turn: ModifyChatTurn) => void
  popTurn: () => void
  setDraft: (draft: string) => void
  /** Reset the conversation when switching scenarios. */
  resetForScenario: (scenarioId: string | null) => void
}

export const useModifyChatStore = create<ModifyChatState>()((set) => ({
  history: [],
  draft: '',
  scenarioId: null,
  appendTurn: (turn) => set(s => ({ history: [...s.history, turn] })),
  popTurn: () => set(s => ({ history: s.history.slice(0, -1) })),
  setDraft: (draft) => set({ draft }),
  resetForScenario: (scenarioId) => set(s =>
    s.scenarioId === scenarioId ? s : { scenarioId, history: [], draft: '' },
  ),
}))
