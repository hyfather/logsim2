import type { LogEntry, LogFormat } from '@/types/logs'
import { getRaw, searchEventToLogEntry } from '@/lib/searchClient'

export interface LogsAtOpts {
  scenarioYaml: string
  from: number
  to: number
  tickIntervalMs?: number
  startTimeMs?: number
  seed?: number
  sourceFilter?: string
  /** Wire schema applied per log entry. Defaults to "native" on the backend. */
  format?: LogFormat
  signal?: AbortSignal
  /** When set, logsAt queries the search daemon (/api/search/dbs/<dbCode>)
   *  instead of re-running the engine via /api/logs_at. The daemon returns
   *  the events recorded during the most recent play, which is what the
   *  user expects when scrubbing a timeline they just generated. */
  dbCode?: string | null
  /** When dbCode is set, this is the wall-clock start of the original run,
   *  so we can convert tick indices back into the timestamps stored in the
   *  daemon. Defaults to startTimeMs. */
  dbStartTimeMs?: number
  /** When set on the engine-rerun path (dbCode unset), tells /api/logs_at
   *  to tee the events it produces into /api/search/dbs/<searchDBCode>.
   *  Used by Step so the daemon accumulates events without a separate
   *  client-side ingest. */
  searchDBCode?: string | null
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
 * scenario+seed.
 *
 * When `dbCode` is set, logsAt queries the in-process search daemon at
 * /api/search — the same db the editor populates when you click Play. Tick
 * indices are converted to absolute timestamps using `dbStartTimeMs` (or
 * `startTimeMs`) and `tickIntervalMs`, then fetched via /get_raw. This is
 * the path used during normal editor scrubbing.
 *
 * When `dbCode` is null/undefined, logsAt falls back to /api/logs_at, which
 * re-runs the engine deterministically from tick 0 to `to`. That's used
 * before any play has happened (or when the daemon is unreachable). Cost
 * is O(to) since the engine's RNG is global — keep `to` modest.
 */
export async function logsAt(opts: LogsAtOpts): Promise<LogEntry[]> {
  if (opts.dbCode) {
    return logsFromDaemon(opts, opts.dbCode)
  }
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
      format: opts.format ?? 'native',
      search_db_code: opts.searchDBCode ?? undefined,
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

async function logsFromDaemon(opts: LogsAtOpts, dbCode: string): Promise<LogEntry[]> {
  const intervalMs = opts.tickIntervalMs ?? 1000
  const baseMs = opts.dbStartTimeMs ?? opts.startTimeMs ?? 0
  // The daemon stores events at their wall-clock timestamps, not tick
  // indices. Convert [from, to) ticks → [fromMs, toMs).
  const fromMs = baseMs + opts.from * intervalMs
  const toMs = baseMs + opts.to * intervalMs
  const res = await getRaw(
    dbCode,
    {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      // get_raw caps at 100 by default; for a single-tick scrub on a busy
      // scenario (cache-failure-cascade peaks ~54 logs/tick), 1000 is the
      // safe ceiling that still keeps responses small.
      limit: 1000,
    },
    opts.signal,
  )
  return (res.events ?? []).map(searchEventToLogEntry)
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
