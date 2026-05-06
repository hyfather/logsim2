import type { LogEntry, LogFormat } from '@/types/logs'
import type { CriblPayload } from '@/lib/backendClient'

export interface RunStreamOpts {
  scenarioYaml: string
  duration?: number
  tickIntervalMs?: number
  startTimeMs?: number
  seed?: number
  sourceFilter?: string
  cribl?: CriblPayload
  /** Wire schema applied per log entry. Defaults to "native" on the backend. */
  format?: LogFormat
  /** Resume playback at this tick index instead of starting at 0. */
  startTick?: number
  /** When > 0, delay each onTick by this many ms so the client paces playback
   *  even if the server returned all frames at once. The engine itself runs
   *  unpaced (one short request) on platforms that buffer responses
   *  (e.g. Vercel Functions) while still showing a moving scrubber. */
  paceMs?: number
  /** When set, the server tees every event to /api/search/dbs/<code> as the
   *  engine produces it, so the editor can query the daemon for historical
   *  events without the browser doing per-tick ingest. */
  searchDBCode?: string | null
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

interface PartialFrame {
  partial: true
  /** Tick index the next chunk should start from (the server bailed before
   *  emitting this tick). */
  next_tick: number
  total_logs?: number
}

interface ErrorFrame {
  error: string
}

type Frame = TickFrame | DoneFrame | PartialFrame | ErrorFrame

// Tick window per /api/run request. Vercel's Lambda runtime buffers the full
// response and rejects bodies above ~4.5 MB with HTTP 413. The server now
// short-circuits at 3 MB and emits a `partial` frame so any one chunk is
// guaranteed to fit; this client cap is a secondary defense and just keeps
// per-request work small even on dense scenarios (cache-failure-cascade
// peaks at ~54 logs/tick — 15 ticks ≈ 800 entries per request, well under
// the budget). Smaller windows mean more requests, all still cheap.
const CHUNK_TICKS = 15
// Pause fetching new chunks once the dispatch queue gets this far ahead of the
// scrubber, so we don't pile up megabytes of buffered frames at slow paces.
const QUEUE_HIGH_WATERMARK = CHUNK_TICKS * 4

/**
 * Plays an episode by fetching small `[start_tick, end)` windows from
 * /api/run and dispatching the frames on a client-paced timer. Chunking
 * keeps each response well below Vercel's 6 MB Lambda payload cap, which a
 * single full-episode response can exceed for log-heavy scenarios.
 *
 * The backend already applies all timeline overrides server-side based on the
 * scenario YAML's `timeline:` blocks — the client just needs to forward the
 * scenario once per chunk, then render the frames it gets back.
 */
export async function runStream(opts: RunStreamOpts): Promise<void> {
  type DispatchFrame = { tick: number; ts: number; logs: LogEntry[] }
  const queue: DispatchFrame[] = []
  let totalLogs = 0
  let cancelled = false
  let timer: ReturnType<typeof setInterval> | null = null
  let fetchDone = false
  let finished = false

  const stopTimer = () => {
    if (timer !== null) { clearInterval(timer); timer = null }
  }
  const finish = () => {
    if (finished || cancelled) return
    finished = true
    stopTimer()
    opts.onDone({ totalLogs })
  }
  const fail = (err: Error) => {
    if (finished || cancelled) return
    finished = true
    stopTimer()
    opts.onError(err)
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
        opts.onTick(next)
      } else if (fetchDone) {
        finish()
      }
    }, paceMs)
  }

  // resumeFrom is set by a partial frame from the server when it bails
  // before reaching the requested chunkEnd (Vercel response-size guard).
  // The main loop reads it after each fetchChunk to advance the cursor.
  let resumeFrom: number | null = null

  const handleFrame = (frame: Frame) => {
    if ('error' in frame) {
      fail(new Error(frame.error))
      return
    }
    if ('partial' in frame) {
      resumeFrom = frame.next_tick
      totalLogs += frame.total_logs ?? 0
      return
    }
    if ('done' in frame) {
      totalLogs += frame.total_logs ?? 0
      return
    }
    const out: DispatchFrame = {
      tick: frame.tick,
      ts: frame.ts,
      logs: (frame.logs ?? []).map(mapLog),
    }
    if (paceMs > 0) queue.push(out)
    else opts.onTick(out)
  }

  const totalDuration = Math.max(0, opts.duration ?? 0)
  let cursor = Math.max(0, opts.startTick ?? 0)
  const startTimeMs = opts.startTimeMs ?? Date.now()
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9)

  // Cribl forwarding (when enabled) ships every chunk's events as it lands
  // — the user picked "forward during run", and dropping all-but-the-last
  // chunk would silently lose 95% of the episode. Each chunk owns its own
  // collected slice on the server, so per-chunk forwarding is safe (no
  // double-sends).
  const fetchChunk = async (chunkStart: number, chunkEnd: number, _isLast: boolean) => {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario_yaml: opts.scenarioYaml,
        duration: chunkEnd,
        tick_interval_ms: opts.tickIntervalMs,
        start_time_ms: startTimeMs,
        seed,
        source_filter: opts.sourceFilter ?? '*',
        cribl: opts.cribl,
        format: opts.format ?? 'native',
        start_tick: chunkStart,
        search_db_code: opts.searchDBCode ?? undefined,
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
  }

  try {
    while (!cancelled && cursor < totalDuration) {
      // Backpressure: wait for the dispatch queue to drain before queuing more.
      // Without this, slow pacing causes the queue (and memory) to grow without
      // bound while fetches finish back-to-back.
      while (!cancelled && paceMs > 0 && queue.length >= QUEUE_HIGH_WATERMARK) {
        await sleep(Math.max(50, paceMs))
      }
      if (cancelled) break

      const chunkEnd = Math.min(cursor + CHUNK_TICKS, totalDuration)
      const isLast = chunkEnd >= totalDuration
      resumeFrom = null
      await fetchChunk(cursor, chunkEnd, isLast)
      // If the server bailed early to stay under the response cap, resume
      // from the tick it pointed at; otherwise advance to the chunk's end.
      // Guard against a no-progress loop (server returns next_tick <= cursor).
      if (resumeFrom !== null && resumeFrom > cursor) {
        cursor = resumeFrom
      } else {
        cursor = chunkEnd
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    fail(err instanceof Error ? err : new Error(String(err)))
    return
  }

  fetchDone = true
  // If pacing isn't enabled or the queue's already drained, finish immediately.
  // Otherwise the timer drains the queue and finishes itself.
  if (paceMs === 0 || queue.length === 0) finish()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Server errors come back as `{"error":"..."}` JSON; surface just the message
// so the UI doesn't show a `run 400: {"error":"..."}` wrapper. Falls back to
// the raw body when parsing fails (e.g. proxy/HTML error pages).
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
