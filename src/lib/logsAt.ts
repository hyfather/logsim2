import type { LogEntry } from '@/types/logs'

export interface LogsAtOpts {
  scenarioYaml: string
  from: number
  to: number
  tickIntervalMs?: number
  startTimeMs?: number
  seed?: number
  sourceFilter?: string
  signal?: AbortSignal
}

interface BackendLogEntry {
  id: string
  ts: string
  source: string
  level: string
  sourcetype: string
  raw: string
}

interface LogsAtResponse {
  from: number
  to: number
  logs: BackendLogEntry[]
  count: number
}

/**
 * Fetches logs that would be emitted in a [from, to) tick window for a given
 * scenario+seed. The backend re-runs deterministically from tick 0, so the
 * same seed always returns the same logs — perfect for a scrub preview.
 *
 * Note: cost is O(to) since the engine's RNG is global. Keep `to` modest.
 */
export async function logsAt(opts: LogsAtOpts): Promise<LogEntry[]> {
  const res = await fetch('/api/logs_at', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenario_yaml: opts.scenarioYaml,
      from: opts.from,
      to: opts.to,
      tick_interval_ms: opts.tickIntervalMs,
      start_time_ms: opts.startTimeMs,
      seed: opts.seed ?? 0,
      source_filter: opts.sourceFilter ?? '*',
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`logs_at ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as LogsAtResponse
  return (json.logs ?? []).map(mapLog)
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
