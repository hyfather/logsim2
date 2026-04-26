import type { LogEntry } from '@/types/logs'
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
  const res = await fetch('/api/run', {
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
    }),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
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
      // NDJSON: split on \n, leave trailing partial line in buf.
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) handleLine(line, opts)
        nl = buf.indexOf('\n')
      }
    }
    if (buf.trim()) handleLine(buf.trim(), opts)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    opts.onError(err instanceof Error ? err : new Error(String(err)))
  }
}

function handleLine(line: string, opts: RunStreamOpts) {
  let frame: Frame
  try {
    frame = JSON.parse(line) as Frame
  } catch {
    // Drop malformed lines silently — better than aborting the stream over
    // a single bad chunk (which would lose every frame after it).
    return
  }
  if ('error' in frame) {
    opts.onError(new Error(frame.error))
    return
  }
  if ('done' in frame) {
    opts.onDone({ totalLogs: frame.total_logs ?? 0 })
    return
  }
  opts.onTick({
    tick: frame.tick,
    ts: frame.ts,
    logs: (frame.logs ?? []).map(mapLog),
  })
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
