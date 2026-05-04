'use client'
import { create } from 'zustand'
import type { LogEntry, LogFilter, LogFormat } from '@/types/logs'
import type { ConnectionActivity } from '@/types/connections'

export type SimulationStatus = 'idle' | 'running'
/** 'realtime' paces the scrubber 1 tick/sec wall-clock so an N-tick scenario
 *  takes N seconds — an 18-min episode plays out over 18 wall-clock minutes.
 *  'fast' streams every frame as quickly as the engine can produce it; useful
 *  when forwarding to a destination, since the run finishes in a few seconds
 *  and the cribl batch ships at the end. */
export type PlaybackMode = 'realtime' | 'fast'

/** Snapshot of the current (or just-finished) forward run.
 *  The store keeps this around after `state` flips to 'done' so the user
 *  can still see the summary — it only resets when a new run starts. */
export interface ForwardStatus {
  state: 'running' | 'done' | 'error'
  destination: string
  duration: number       // total ticks in the episode
  tick: number           // last reported absolute tick index
  eventsProduced: number
  eventsSent: number
  batchesSent: number
  batchesFailed: number
  bySource: Record<string, number>
  /** Sticky error trace — failed POSTs accumulate here so the user sees
   *  them after the run completes. Capped to keep the panel readable. */
  errors: string[]
  startedAt: number
  finishedAt?: number
  errorMessage?: string  // set when state === 'error'
}

const MAX_LOG_BUFFER = 50000
const MAX_FORWARD_ERRORS = 50

interface SimulationState {
  status: SimulationStatus
  tickCount: number
  speed: number // ticks per second
  /** How `Run` paces the scrubber — see PlaybackMode. */
  playbackMode: PlaybackMode
  simulatedTime: Date
  logBuffer: LogEntry[]
  activeConnections: Record<string, ConnectionActivity>
  filter: LogFilter
  autoScroll: boolean
  worker: Worker | null
  /** When true, the editor-level auto-forward loop is paused.
   *  User is accumulating logs to forward on demand. */
  accumulateMode: boolean
  /** Wire schema applied to log lines before they reach the UI. */
  outputFormat: LogFormat
  /** Last fatal error from the run pipeline (validation, network, server).
   *  null while the run is healthy or no run has been attempted. */
  runError: string | null
  /** Latest forward-mode run snapshot — null when no forward run has been
   *  started yet (or after a clearForwardStatus call). Persists past the
   *  end of the run so the closing summary stays on screen. */
  forwardStatus: ForwardStatus | null
  // Actions
  setStatus: (status: SimulationStatus) => void
  setSpeed: (speed: number) => void
  setPlaybackMode: (mode: PlaybackMode) => void
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
  setOutputFormat: (format: LogFormat) => void
  setRunError: (msg: string | null) => void
  // Forward-mode actions. Each takes a partial slice of state — the store
  // does the merging so callers stay terse.
  forwardStarted: (info: { destination: string; duration: number }) => void
  forwardProgress: (info: { tick: number; eventsProduced: number; eventsSent: number }) => void
  forwardErrorLine: (line: string) => void
  forwardFinished: (summary: { eventsProduced: number; eventsSent: number; batchesSent: number; batchesFailed: number; bySource: Record<string, number> }) => void
  forwardFailed: (msg: string) => void
  clearForwardStatus: () => void
  reset: () => void
}

export const useSimulationStore = create<SimulationState>()((set) => ({
  status: 'idle',
  tickCount: 0,
  speed: 1,
  playbackMode: 'realtime',
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
  outputFormat: 'native',
  runError: null,
  forwardStatus: null,

  setStatus: (status) => set({ status }),
  setSpeed: (speed) => set({ speed }),
  setPlaybackMode: (playbackMode) => set({ playbackMode }),
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

  setOutputFormat: (outputFormat) => set({ outputFormat, logBuffer: [] }),

  setRunError: (runError) => set({ runError }),

  forwardStarted: ({ destination, duration }) => set({
    forwardStatus: {
      state: 'running',
      destination,
      duration,
      tick: 0,
      eventsProduced: 0,
      eventsSent: 0,
      batchesSent: 0,
      batchesFailed: 0,
      bySource: {},
      errors: [],
      startedAt: Date.now(),
    },
  }),

  forwardProgress: ({ tick, eventsProduced, eventsSent }) => set(state => {
    if (!state.forwardStatus) return state
    return {
      forwardStatus: { ...state.forwardStatus, tick, eventsProduced, eventsSent },
    }
  }),

  forwardErrorLine: (line) => set(state => {
    if (!state.forwardStatus) return state
    const next = state.forwardStatus.errors.concat(line)
    if (next.length > MAX_FORWARD_ERRORS) next.splice(0, next.length - MAX_FORWARD_ERRORS)
    return { forwardStatus: { ...state.forwardStatus, errors: next } }
  }),

  forwardFinished: (summary) => set(state => {
    if (!state.forwardStatus) return state
    return {
      forwardStatus: {
        ...state.forwardStatus,
        state: 'done',
        eventsProduced: summary.eventsProduced,
        eventsSent: summary.eventsSent,
        batchesSent: summary.batchesSent,
        batchesFailed: summary.batchesFailed,
        bySource: summary.bySource,
        finishedAt: Date.now(),
      },
    }
  }),

  forwardFailed: (msg) => set(state => {
    if (!state.forwardStatus) {
      // Failure before the start frame — synthesize a minimal status so
      // the panel can still surface the error.
      return {
        forwardStatus: {
          state: 'error',
          destination: '',
          duration: 0,
          tick: 0,
          eventsProduced: 0,
          eventsSent: 0,
          batchesSent: 0,
          batchesFailed: 0,
          bySource: {},
          errors: [msg],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          errorMessage: msg,
        },
      }
    }
    return {
      forwardStatus: {
        ...state.forwardStatus,
        state: 'error',
        errorMessage: msg,
        finishedAt: Date.now(),
      },
    }
  }),

  clearForwardStatus: () => set({ forwardStatus: null }),

  reset: () => set({
    status: 'idle',
    tickCount: 0,
    simulatedTime: new Date(),
    logBuffer: [],
    activeConnections: {},
    runError: null,
    forwardStatus: null,
  }),
}))
