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

/**
 * Runs the scenario in forward mode: backend produces every event, ships it
 * to the configured Cribl HEC destination, and streams progress NDJSON
 * (no log frames). Mirrors `logsim run --to <dest>` in the CLI.
 */
export async function runForward(opts: RunForwardOpts): Promise<void> {
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
  const startTimeMs = opts.startTimeMs ?? Date.now()

  let res: Response
  try {
    res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario_yaml: opts.scenarioYaml,
        duration: opts.duration ?? 0,
        tick_interval_ms: opts.tickIntervalMs ?? 0,
        start_time_ms: startTimeMs,
        seed,
        source_filter: opts.sourceFilter ?? '*',
        cribl: opts.cribl,
        format: opts.format ?? 'native',
        mode: 'forward',
      }),
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    opts.onError(err instanceof Error ? err : new Error(String(err)))
    return
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    opts.onError(new Error(extractServerError(res.status, body)))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done = false
  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buf += decoder.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) {
          done = handleLine(line, opts) || done
        }
        nl = buf.indexOf('\n')
      }
    }
    if (buf.trim()) handleLine(buf.trim(), opts)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    opts.onError(err instanceof Error ? err : new Error(String(err)))
    return
  }
  // If the server hung up without a done frame, treat it as an error so
  // the UI doesn't get stuck.
  if (!done) {
    opts.onError(new Error('forward run ended without a done frame'))
  }
}

// handleLine returns true once a terminal frame (done/error) has been
// dispatched, so the outer loop can verify the stream closed cleanly.
function handleLine(line: string, opts: RunForwardOpts): boolean {
  let frame: BackendFrame | null = null
  try {
    frame = JSON.parse(line) as BackendFrame
  } catch {
    return false
  }
  if (!frame) return false
  switch (frame.type) {
    case 'start':
      opts.onStart({
        duration: frame.duration,
        destination: frame.destination,
        tickIntervalMs: frame.tick_interval_ms,
      })
      return false
    case 'post':
      opts.onPost({
        status: frame.status,
        size: frame.size,
        durationMs: frame.duration_ms,
        attempt: frame.attempt,
        final: frame.final,
        err: frame.err,
      })
      return false
    case 'progress':
      opts.onProgress({
        tick: frame.tick,
        eventsProduced: frame.events_produced,
        eventsSent: frame.events_sent,
      })
      return false
    case 'done':
      opts.onDone({
        eventsProduced: frame.events_produced,
        eventsSent: frame.events_sent,
        batchesSent: frame.batches_sent,
        batchesFailed: frame.batches_failed,
        bySource: frame.by_source ?? {},
      })
      return true
    case 'error':
      opts.onError(new Error(frame.error))
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
