// Typed client for the in-process logsim search daemon mounted at
// /api/search/* (see api/search/index.go). The same surface backs the
// `logsim search` CLI; on Vercel the storage is the pure-Go MemoryBackend
// living in a single warm function instance.
//
// Keep the API small and parallel to pkg/search so the eventual agent /
// conversational tool layer can call these functions through one stable
// wire shape.
import type { LogEntry, LogFormat } from '@/types/logs'

const SEARCH_BASE = '/api/search'

// --- shared types ----------------------------------------------------

export interface SearchEvent {
  id: string
  time: string                 // RFC3339Nano
  host?: string
  source?: string
  sourcetype?: string
  index?: string
  raw: string
  fields?: Record<string, unknown>
}

export interface SearchDbInfo {
  code: string
  created_at: string
  event_count: number
  oldest_event?: string
  newest_event?: string
}

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct_count'

export interface SummaryRow {
  group?: string
  value: number
}
export interface DistributionBucket {
  start: string
  group?: string
  count: number
}
export interface TopValue {
  value: string
  count: number
}

// --- low-level fetch wrapper ----------------------------------------

class SearchHTTPError extends Error {
  constructor(public status: number, public bodyText: string) {
    super(extractMessage(status, bodyText))
    this.name = 'SearchHTTPError'
  }
}

function extractMessage(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: string; text?: string }
      if (parsed.error) return parsed.error
      if (parsed.text) return parsed.text
    } catch {
      /* fall through */
    }
  }
  return trimmed ? `HTTP ${status}: ${trimmed.slice(0, 300)}` : `HTTP ${status}`
}

async function postJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${SEARCH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new SearchHTTPError(res.status, await res.text().catch(() => ''))
  }
  return (await res.json()) as T
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${SEARCH_BASE}${path}`, { signal })
  if (!res.ok) {
    throw new SearchHTTPError(res.status, await res.text().catch(() => ''))
  }
  return (await res.json()) as T
}

// --- db lifecycle ----------------------------------------------------

/** Create a new db. When code is omitted the server picks one. */
export async function createDb(code?: string, signal?: AbortSignal): Promise<{ code: string; created_at: string }> {
  return postJSON('/dbs', code ? { code } : undefined, signal)
}

export async function deleteDb(code: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${SEARCH_BASE}/dbs/${code}`, { method: 'DELETE', signal })
  if (!res.ok && res.status !== 404) {
    throw new SearchHTTPError(res.status, await res.text().catch(() => ''))
  }
}

export async function listDbs(signal?: AbortSignal): Promise<SearchDbInfo[]> {
  const res = await getJSON<{ dbs: SearchDbInfo[] }>('/dbs', signal)
  return res.dbs ?? []
}

export async function getDb(code: string, signal?: AbortSignal): Promise<SearchDbInfo> {
  return getJSON(`/dbs/${code}`, signal)
}

// --- ingest ---------------------------------------------------------

/** Splunk/Cribl HEC envelope wire shape. */
export interface HECEnvelope {
  time?: number | string
  host?: string
  source?: string
  sourcetype?: string
  index?: string
  event: string | Record<string, unknown>
  fields?: Record<string, unknown>
}

/** Build a HEC envelope from a frontend LogEntry. The envelope places the
 *  rendered raw line in `event` and copies the level + id into `fields` so
 *  IR queries can filter / aggregate on them later. */
export function logEntryToHEC(e: LogEntry): HECEnvelope {
  const tsSec = Date.parse(e.ts) / 1000
  return {
    time: Number.isFinite(tsSec) ? tsSec : undefined,
    host: e.channel,
    source: e.channel,
    sourcetype: e.source,
    index: 'main',
    event: e.raw,
    fields: { id: e.id, level: e.level, channel: e.channel },
  }
}

/** Send a batch of HEC envelopes to /dbs/<code>/services/collector/event.
 *  The body is newline-delimited JSON, matching Splunk HEC. */
export async function ingestHEC(code: string, envelopes: HECEnvelope[], signal?: AbortSignal): Promise<void> {
  if (envelopes.length === 0) return
  const ndjson = envelopes.map(env => JSON.stringify(env)).join('\n') + '\n'
  const res = await fetch(`${SEARCH_BASE}/dbs/${code}/services/collector/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: ndjson,
    signal,
  })
  if (!res.ok) {
    throw new SearchHTTPError(res.status, await res.text().catch(() => ''))
  }
}

/** Convenience: ingest a slice of LogEntries directly. */
export async function ingestLogs(code: string, logs: LogEntry[], _format?: LogFormat, signal?: AbortSignal): Promise<void> {
  if (logs.length === 0) return
  await ingestHEC(code, logs.map(logEntryToHEC), signal)
}

// --- IR queries -----------------------------------------------------

export interface RawQuery {
  from?: string | Date
  to?: string | Date
  limit?: number
  offset?: number
}

export interface RawResult {
  events: SearchEvent[]
  total: number
}

function normRange(q: RawQuery): { from?: string; to?: string } {
  return {
    from: q.from instanceof Date ? q.from.toISOString() : q.from,
    to: q.to instanceof Date ? q.to.toISOString() : q.to,
  }
}

export async function getRaw(code: string, q: RawQuery = {}, signal?: AbortSignal): Promise<RawResult> {
  return postJSON(`/dbs/${code}/get_raw`, {
    ...normRange(q),
    limit: q.limit,
    offset: q.offset,
  }, signal)
}

export interface SummaryQuery {
  from?: string | Date
  to?: string | Date
  agg_fn: AggFn
  agg_field?: string
  group_by?: string
}

export async function getSummary(code: string, q: SummaryQuery, signal?: AbortSignal): Promise<{ rows: SummaryRow[] }> {
  return postJSON(`/dbs/${code}/get_summary`, {
    ...normRange(q),
    agg_fn: q.agg_fn,
    agg_field: q.agg_field,
    group_by: q.group_by,
  }, signal)
}

export interface DistributionQuery {
  from?: string | Date
  to?: string | Date
  bucket_seconds: number
  group_by?: string
}

export async function getDistribution(code: string, q: DistributionQuery, signal?: AbortSignal): Promise<{ buckets: DistributionBucket[] }> {
  return postJSON(`/dbs/${code}/get_distribution`, {
    ...normRange(q),
    bucket_seconds: q.bucket_seconds,
    group_by: q.group_by,
  }, signal)
}

export interface TopValuesQuery {
  from?: string | Date
  to?: string | Date
  field: string
  limit?: number
}

export async function getTopValues(code: string, q: TopValuesQuery, signal?: AbortSignal): Promise<{ values: TopValue[] }> {
  return postJSON(`/dbs/${code}/get_top_values`, {
    ...normRange(q),
    field: q.field,
    limit: q.limit,
  }, signal)
}

// --- conversion back to frontend types ------------------------------

/** Map a daemon-side SearchEvent back to the frontend LogEntry shape so
 *  components that already render LogEntry don't need another mapper. */
export function searchEventToLogEntry(e: SearchEvent): LogEntry {
  return {
    id: e.id || '',
    ts: e.time,
    channel: e.source || e.host || '',
    level: ((e.fields?.level as string) || 'INFO') as LogEntry['level'],
    source: ((e.sourcetype || 'custom') as unknown) as LogEntry['source'],
    raw: e.raw,
  }
}

export { SearchHTTPError }
