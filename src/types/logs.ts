export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export type LogSource = 'vpc-flow' | 'nodejs' | 'golang' | 'postgres' | 'mysql' | 'redis' | 'nginx' | 'custom'

// LogFormat selects the wire schema applied before logs reach the UI.
// "native" preserves the generator's own log line; "ocsf" replaces it with an
// OCSF v1.x JSON event. udm/asim are reserved and currently fall back to
// native on the backend.
export type LogFormat = 'native' | 'ocsf' | 'udm' | 'asim'

export interface LogEntry {
  id: string
  ts: string       // ISO timestamp
  channel: string  // e.g., "prod.vpc-1.private-a.api-host.user-svc"
  level: LogLevel
  source: LogSource
  raw: string      // the rendered log line the model sees
}

export interface LogFilter {
  channelGlob: string          // legacy / custom pattern
  sources: string[]            // selected channel names (empty = all)
  levels: LogLevel[]
  keyword: string
  timeRange: [number, number] | null  // [startMs, endMs] inclusive; null = unfiltered
}
