import type { LogEntry, LogFormat } from '@/types/logs'
import type { CriblPayload } from '@/lib/backendClient'

export interface RunStreamOpts {
  scenarioYaml: string
  duration?: number
  tickIntervalMs?: number
  startTimeMs?: number
  seed?: number
  sourceFilter?: string
  /** 1.0 = simulated wall-clock speed; 8.0 = 8× faster; 0 = as fast as possible. */
  rate?: number
  cribl?: CriblPayload
  /** Wire schema applied per log entry. Defaults to "native" on the backend. */
  format?: LogFormat
  /** Resume playback at this tick index instead of starting at 0. */
  startTick?: number
  /** When > 0, delay each onTick by this many ms so the client paces playback
   *  even if the server returned all frames at once. Lets us run the engine
   *  at rate=0 (one short request) on platforms that buffer responses
   *  (e.g. Vercel Functions) while still showing a moving scrubber. */
  paceMs?: number
  signal?: AbortSignal
  onTick: (frame: { tick: number; ts: number; logs: LogEntry[] }) => void
  onDone: (summary: { totalLogs: number }) => void
  onError: (err: Error) => void
}

interface BackendLogEntry {
  id: string
  ts: string
  source: string
  level: string
  sourcetype: string
  raw: string
}

interface TickFrame {
  tick: number
  ts: number
  logs: BackendLogEntry[]
}

interface DoneFrame {
  done: true
  total_logs: number
}

interface ErrorFrame {
  error: string
}

type Frame = TickFrame | DoneFrame | ErrorFrame

/**
 * Streams an entire episode from POST /api/run as NDJSON. One frame per tick
 * arrives, plus a final {done:true,total_logs:N} or {error:"..."}.
 *
 * The backend already applies all timeline overrides server-side based on the
 * scenario YAML's `timeline:` blocks — the client just needs to forward the
 * scenario once, then render frames as they arrive.
 */
export async function runStream(opts: RunStreamOpts): Promise<void> {
  // Client-side pacing queue. We always run the backend at rate=0 (or whatever
  // opts.rate says) and optionally space onTick callbacks here so playback
  // looks smooth on platforms that buffer the streaming response.
  type DispatchFrame = { tick: number; ts: number; logs: LogEntry[] }
  const queue: DispatchFrame[] = []
  let totalLogs = 0
  let serverDone = false
  let cancelled = false
  let timer: ReturnType<typeof setInterval> | null = null

  const stopTimer = () => {
    if (timer !== null) { clearInterval(timer); timer = null }
  }
  const finish = () => {
    stopTimer()
    if (!cancelled) opts.onDone({ totalLogs })
  }
  const dispatch = (frame: DispatchFrame) => {
    if (cancelled) return
    opts.onTick(frame)
  }

  if (opts.signal) {
    if (opts.signal.aborted) return
    opts.signal.addEventListener('abort', () => { cancelled = true; stopTimer() }, { once: true })
  }

  const paceMs = Math.max(0, opts.paceMs ?? 0)
  if (paceMs > 0) {
    timer = setInterval(() => {
      if (cancelled) { stopTimer(); return }
      const next = queue.shift()
      if (next) {
        dispatch(next)
      } else if (serverDone) {
        finish()
      }
    }, paceMs)
  }

  const handleFrame = (frame: Frame) => {
    if ('error' in frame) {
      stopTimer()
      if (!cancelled) opts.onError(new Error(frame.error))
      return
    }
    if ('done' in frame) {
      totalLogs = frame.total_logs ?? totalLogs
      serverDone = true
      if (paceMs === 0 || queue.length === 0) finish()
      return
    }
    const out: DispatchFrame = {
      tick: frame.tick,
      ts: frame.ts,
      logs: (frame.logs ?? []).map(mapLog),
    }
    if (paceMs > 0) queue.push(out)
    else dispatch(out)
  }

  let res: Response
  try {
    res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario_yaml: opts.scenarioYaml,
        duration: opts.duration,
        tick_interval_ms: opts.tickIntervalMs,
        start_time_ms: opts.startTimeMs ?? Date.now(),
        seed: opts.seed ?? Math.floor(Math.random() * 1e9),
        source_filter: opts.sourceFilter ?? '*',
        rate: opts.rate,
        cribl: opts.cribl,
        format: opts.format ?? 'native',
        start_tick: opts.startTick ?? 0,
      }),
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    stopTimer()
    opts.onError(err instanceof Error ? err : new Error(String(err)))
    return
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    stopTimer()
    opts.onError(new Error(`run ${res.status}: ${body.slice(0, 300)}`))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) {
          const frame = parseLine(line)
          if (frame) handleFrame(frame)
        }
        nl = buf.indexOf('\n')
      }
    }
    if (buf.trim()) {
      const frame = parseLine(buf.trim())
      if (frame) handleFrame(frame)
    }
    if (!serverDone) {
      // Connection ended without a {"done":...} frame — treat as done so the
      // client doesn't stall waiting forever.
      serverDone = true
      if (paceMs === 0 || queue.length === 0) finish()
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    stopTimer()
    opts.onError(err instanceof Error ? err : new Error(String(err)))
  }
}

function parseLine(line: string): Frame | null {
  try {
    return JSON.parse(line) as Frame
  } catch {
    return null
  }
}

function mapLog(e: BackendLogEntry): LogEntry {
  return {
    id: e.id,
    ts: e.ts,
    channel: e.source,
    level: e.level as LogEntry['level'],
    source: (e.sourcetype || 'custom') as LogEntry['source'],
    raw: e.raw,
  }
}
