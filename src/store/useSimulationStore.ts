'use client'
import { create } from 'zustand'
import type { LogEntry, LogFilter } from '@/types/logs'
import type { ConnectionActivity } from '@/types/connections'

export type SimulationStatus = 'idle' | 'running'

const MAX_LOG_BUFFER = 50000

interface SimulationState {
  status: SimulationStatus
  tickCount: number
  speed: number // ticks per second
  simulatedTime: Date
  logBuffer: LogEntry[]
  activeConnections: Record<string, ConnectionActivity>
  filter: LogFilter
  autoScroll: boolean
  worker: Worker | null
  /** When true, the editor-level auto-forward loop is paused.
   *  User is accumulating logs to forward on demand. */
  accumulateMode: boolean
  // Actions
  setStatus: (status: SimulationStatus) => void
  setSpeed: (speed: number) => void
  setTickCount: (count: number) => void
  setSimulatedTime: (time: Date) => void
  addLogs: (logs: LogEntry[]) => void
  setActiveConnections: (connections: ConnectionActivity[]) => void
  clearActiveConnections: () => void
  clearLogs: () => void
  setFilter: (filter: Partial<LogFilter>) => void
  setAutoScroll: (autoScroll: boolean) => void
  setAccumulateMode: (accumulate: boolean) => void
  setWorker: (worker: Worker | null) => void
  reset: () => void
}

export const useSimulationStore = create<SimulationState>()((set) => ({
  status: 'idle',
  tickCount: 0,
  speed: 1,
  simulatedTime: new Date(),
  logBuffer: [],
  activeConnections: {},
  filter: {
    channelGlob: '*',
    sources: [],
    levels: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
    keyword: '',
    timeRange: null,
  },
  autoScroll: true,
  worker: null,
  accumulateMode: false,

  setStatus: (status) => set({ status }),
  setSpeed: (speed) => set({ speed }),
  setTickCount: (tickCount) => set({ tickCount }),
  setSimulatedTime: (simulatedTime) => set({ simulatedTime }),

  addLogs: (logs) => {
    if (logs.length === 0) return
    set(state => {
      const incomingLen = logs.length
      const currentLen = state.logBuffer.length
      if (currentLen + incomingLen <= MAX_LOG_BUFFER) {
        return { logBuffer: state.logBuffer.concat(logs) }
      }
      // Drop from head without re-copying the whole array twice.
      const overflow = currentLen + incomingLen - MAX_LOG_BUFFER
      const trimmed = state.logBuffer.slice(overflow).concat(logs)
      return { logBuffer: trimmed }
    })
  },

  setActiveConnections: (connections) => set({
    activeConnections: Object.fromEntries(connections.map(connection => [connection.connectionId, connection])),
  }),

  clearActiveConnections: () => set({ activeConnections: {} }),

  clearLogs: () => set({ logBuffer: [] }),

  setFilter: (filter) => {
    set(state => ({ filter: { ...state.filter, ...filter } }))
  },

  setAutoScroll: (autoScroll) => set({ autoScroll }),

  setAccumulateMode: (accumulateMode) => set({ accumulateMode }),

  setWorker: (worker) => set({ worker }),

  reset: () => set({
    status: 'idle',
    tickCount: 0,
    simulatedTime: new Date(),
    logBuffer: [],
    activeConnections: {},
  }),
}))
