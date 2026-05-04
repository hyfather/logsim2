import type { CriblPayload } from '@/lib/backendClient'
import type { LogFormat } from '@/types/logs'

export interface RunForwardOpts {
  scenarioYaml: string
  duration?: number
  tickIntervalMs?: number
  startTimeMs?: number
  seed?: number
  sourceFilter?: string
  /** Required — forward mode 400s without a configured destination. */
  cribl: CriblPayload
  format?: LogFormat
  signal?: AbortSignal
  onStart: (info: { duration: number; destination: string; tickIntervalMs: number }) => void
  onPost: (post: PostFrame) => void
  onProgress: (info: { tick: number; eventsProduced: number; eventsSent: number }) => void
  onDone: (summary: ForwardSummary) => void
  onError: (err: Error) => void
}

/** One HTTP attempt against the HEC endpoint. Mirrors sinks.SendResult. */
export interface PostFrame {
  status: number
  size: number
  durationMs: number
  attempt: number
  final: boolean
  err?: string
}

export interface ForwardSummary {
  eventsProduced: number
  eventsSent: number
  batchesSent: number
  batchesFailed: number
  bySource: Record<string, number>
}

interface StartFrame {
  type: 'start'
  duration: number
  tick_interval_ms: number
  destination: string
}
interface BackendPostFrame {
  type: 'post'
  status: number
  size: number
  duration_ms: number
  attempt: number
  final: boolean
  err?: string
}
interface BackendProgressFrame {
  type: 'progress'
  tick: number
  events_produced: number
  events_sent: number
}
interface BackendDoneFrame {
  type: 'done'
  events_produced: number
  events_sent: number
  batches_sent: number
  batches_failed: number
  by_source: Record<string, number>
}
interface BackendErrorFrame {
  type: 'error'
  error: string
}

type BackendFrame =
  | StartFrame
  | BackendPostFrame
  | BackendProgressFrame
  | BackendDoneFrame
  | BackendErrorFrame

// Tick window per /api/run forward request. The Vercel function timeout
// (60s in vercel.json) is the binding constraint — at typical Cribl Cloud
// HEC latency, batch=500, ~50 logs/tick, 300 ticks ≈ 12s of POST work, so
// each chunk fits with comfortable margin and a long episode trickles
// through 4 sequential requests rather than one timeout-prone marathon.
const CHUNK_TICKS_FORWARD = 300

/**
 * Runs the scenario in forward mode: backend produces every event, ships it
 * to the configured Cribl HEC destination, and streams progress NDJSON
 * (no log frames). Mirrors `logsim run --to <dest>` in the CLI.
 *
 * The episode is split into CHUNK_TICKS_FORWARD-tick windows so each /api/run
 * call lives well within the function timeout. Per-chunk summaries are
 * aggregated client-side; the consumer sees one onStart, repeated onPost /
 * onProgress, and a single final onDone.
 */
export async function runForward(opts: RunForwardOpts): Promise<void> {
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
  const startTimeMs = opts.startTimeMs ?? Date.now()
  const totalDuration = Math.max(0, opts.duration ?? 0)

  let cursor = 0
  const totals: ForwardSummary = {
    eventsProduced: 0,
    eventsSent: 0,
    batchesSent: 0,
    batchesFailed: 0,
    bySource: {},
  }
  let startEmitted = false
  let aborted = false
  let failed = false

  // Chunk callbacks: surface posts/progress live, but suppress per-chunk
  // start/done — we want one start and one done across the whole run.
  const chunkCallbacks: ChunkCallbacks = {
    onStart: (info) => {
      if (!startEmitted) {
        opts.onStart({ ...info, duration: totalDuration })
        startEmitted = true
      }
    },
    onPost: (post) => opts.onPost(post),
    onProgress: ({ tick, eventsProduced, eventsSent }) => {
      // tick is absolute already; events_* are per-chunk, fold into totals
      // before reporting so the UI sees a monotonic counter.
      const cumulativeProduced = totals.eventsProduced + eventsProduced
      const cumulativeSent = totals.eventsSent + eventsSent
      opts.onProgress({ tick, eventsProduced: cumulativeProduced, eventsSent: cumulativeSent })
    },
    onChunkDone: (summary) => {
      totals.eventsProduced += summary.eventsProduced
      totals.eventsSent += summary.eventsSent
      totals.batchesSent += summary.batchesSent
      totals.batchesFailed += summary.batchesFailed
      for (const [src, n] of Object.entries(summary.bySource)) {
        totals.bySource[src] = (totals.bySource[src] ?? 0) + n
      }
    },
    onError: (err) => {
      failed = true
      opts.onError(err)
    },
  }

  while (!aborted && !failed && cursor < totalDuration) {
    if (opts.signal?.aborted) {
      aborted = true
      break
    }
    const chunkEnd = Math.min(cursor + CHUNK_TICKS_FORWARD, totalDuration)
    try {
      await fetchForwardChunk(
        {
          ...opts,
          duration: chunkEnd, // backend uses this as the absolute end
          startTimeMs,
          seed,
        },
        cursor,
        chunkCallbacks,
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        aborted = true
        break
      }
      failed = true
      opts.onError(err instanceof Error ? err : new Error(String(err)))
      return
    }
    cursor = chunkEnd
  }

  if (failed || aborted) return
  opts.onDone(totals)
}

interface ChunkCallbacks {
  onStart: (info: { duration: number; destination: string; tickIntervalMs: number }) => void
  onPost: (post: PostFrame) => void
  onProgress: (info: { tick: number; eventsProduced: number; eventsSent: number }) => void
  onChunkDone: (summary: ForwardSummary) => void
  onError: (err: Error) => void
}

async function fetchForwardChunk(
  opts: RunForwardOpts & { duration: number; startTimeMs: number; seed: number },
  startTick: number,
  cb: ChunkCallbacks,
): Promise<void> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenario_yaml: opts.scenarioYaml,
      duration: opts.duration,
      tick_interval_ms: opts.tickIntervalMs ?? 0,
      start_time_ms: opts.startTimeMs,
      seed: opts.seed,
      source_filter: opts.sourceFilter ?? '*',
      cribl: opts.cribl,
      format: opts.format ?? 'native',
      mode: 'forward',
      start_tick: startTick,
    }),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(extractServerError(res.status, body))
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let chunkSawDone = false
  for (;;) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        chunkSawDone = handleChunkLine(line, cb) || chunkSawDone
      }
      nl = buf.indexOf('\n')
    }
  }
  if (buf.trim()) chunkSawDone = handleChunkLine(buf.trim(), cb) || chunkSawDone
  if (!chunkSawDone) throw new Error('forward chunk ended without a done frame')
}

function handleChunkLine(line: string, cb: ChunkCallbacks): boolean {
  let frame: BackendFrame | null = null
  try {
    frame = JSON.parse(line) as BackendFrame
  } catch {
    return false
  }
  if (!frame) return false
  switch (frame.type) {
    case 'start':
      cb.onStart({
        duration: frame.duration,
        destination: frame.destination,
        tickIntervalMs: frame.tick_interval_ms,
      })
      return false
    case 'post':
      cb.onPost({
        status: frame.status,
        size: frame.size,
        durationMs: frame.duration_ms,
        attempt: frame.attempt,
        final: frame.final,
        err: frame.err,
      })
      return false
    case 'progress':
      cb.onProgress({
        tick: frame.tick,
        eventsProduced: frame.events_produced,
        eventsSent: frame.events_sent,
      })
      return false
    case 'done':
      cb.onChunkDone({
        eventsProduced: frame.events_produced,
        eventsSent: frame.events_sent,
        batchesSent: frame.batches_sent,
        batchesFailed: frame.batches_failed,
        bySource: frame.by_source ?? {},
      })
      return true
    case 'error':
      cb.onError(new Error(frame.error))
      return true
  }
  return false
}

function extractServerError(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error
    } catch {
      // fall through
    }
  }
  return trimmed ? `HTTP ${status}: ${trimmed.slice(0, 300)}` : `HTTP ${status}`
}
