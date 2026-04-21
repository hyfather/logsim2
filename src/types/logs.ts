export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export type LogSource = 'vpc-flow' | 'nodejs' | 'golang' | 'postgres' | 'mysql' | 'redis' | 'nginx' | 'custom'

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
