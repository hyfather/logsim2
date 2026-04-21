import type { LogEntry } from '@/types/logs'
import type { CriblHecDestination, DestinationConfig } from '@/types/destinations'

export interface GenerateOpts {
  scenarioYaml: string
  ticks: number
  tickIntervalMs: number
  startTimeMs: number
  seed: number
  sourceFilter?: string
  cribl?: CriblPayload
}

export interface CriblPayload {
  enabled: boolean
  url: string
  token: string
  sourcetype: string
}

export interface GenerateResponse {
  logs: BackendLogEntry[]
  ticks: number
  forwarded: number
  forward_error?: string
}

// Backend uses `source` for the hierarchical channel path and `sourcetype` for
// the generator kind. The frontend's LogEntry uses `channel` + `source`. Map.
interface BackendLogEntry {
  id: string
  ts: string
  source: string
  level: string
  sourcetype: string
  raw: string
}

export async function generate(opts: GenerateOpts): Promise<{ logs: LogEntry[]; forwarded: number; forwardError?: string }> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenario_yaml: opts.scenarioYaml,
      ticks: opts.ticks,
      tick_interval_ms: opts.tickIntervalMs,
      start_time_ms: opts.startTimeMs,
      seed: opts.seed,
      source_filter: opts.sourceFilter ?? '*',
      cribl: opts.cribl,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`generate ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as GenerateResponse
  return {
    logs: (json.logs ?? []).map(mapLogEntry),
    forwarded: json.forwarded ?? 0,
    forwardError: json.forward_error,
  }
}

function mapLogEntry(e: BackendLogEntry): LogEntry {
  return {
    id: e.id,
    ts: e.ts,
    channel: e.source,
    level: e.level as LogEntry['level'],
    source: (e.sourcetype || 'custom') as LogEntry['source'],
    raw: e.raw,
  }
}

export function pickCriblPayload(destinations: DestinationConfig[]): CriblPayload | undefined {
  const enabled = destinations.find((d): d is CriblHecDestination => d.enabled && d.type === 'cribl-hec')
  if (!enabled) return undefined
  return {
    enabled: true,
    url: enabled.url,
    token: enabled.token,
    // Empty = let the backend sink auto-map per generator.
    sourcetype: enabled.sourcetype,
  }
}
