'use client'
import { create } from 'zustand'
import type { LogEntry, LogFilter } from '@/types/logs'
import type { ConnectionActivity } from '@/types/connections'

export type SimulationStatus = 'idle' | 'running'

const MAX_LOG_BUFFER = 10000

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
    levels: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
    keyword: '',
  },
  autoScroll: true,
  worker: null,

  setStatus: (status) => set({ status }),
  setSpeed: (speed) => set({ speed }),
  setTickCount: (tickCount) => set({ tickCount }),
  setSimulatedTime: (simulatedTime) => set({ simulatedTime }),

  addLogs: (logs) => {
    set(state => {
      const combined = [...state.logBuffer, ...logs]
      // Ring buffer: keep last MAX_LOG_BUFFER entries
      const trimmed = combined.length > MAX_LOG_BUFFER
        ? combined.slice(combined.length - MAX_LOG_BUFFER)
        : combined
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

  setWorker: (worker) => set({ worker }),

  reset: () => set({
    status: 'idle',
    tickCount: 0,
    simulatedTime: new Date(),
    logBuffer: [],
    activeConnections: {},
  }),
}))
