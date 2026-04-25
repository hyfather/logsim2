import type { LogLevel } from '@/types/logs'

/**
 * The semantic role of a `{{placeholder}}` in a custom-node template. The
 * generator uses this to fill the placeholder with a realistic value at tick
 * time. Each kind has slightly different inputs (enumValues, min/max, format).
 */
export type PlaceholderKind =
  | 'timestamp'
  | 'iso_timestamp'
  | 'epoch_seconds'
  | 'epoch_millis'
  | 'level'
  | 'ip'
  | 'ipv6'
  | 'host'
  | 'port'
  | 'method'
  | 'path'
  | 'status'
  | 'latency_ms'
  | 'duration_ms'
  | 'bytes'
  | 'request_id'
  | 'trace_id'
  | 'uuid'
  | 'user_id'
  | 'session_id'
  | 'email'
  | 'pid'
  | 'thread'
  | 'integer'
  | 'float'
  | 'hex'
  | 'word'
  | 'enum'
  | 'free_text'
  | 'literal'
  | 'user_agent'

export interface PlaceholderSpec {
  kind: PlaceholderKind
  /** For enum / free_text / occasionally level/method/path: candidate pool. */
  enumValues?: string[]
  /** For literal: fixed value emitted verbatim. */
  literal?: string
  /** Numeric ranges (latency_ms, bytes, integer, float, user_id, pid). */
  min?: number
  max?: number
  /** Timestamp format: 'iso' | 'rfc3164' | 'apache' | 'epoch_s' | 'epoch_ms'. */
  format?: string
  /** hex / word length. */
  length?: number
  description?: string
}

export interface CustomLogTemplate {
  /** Template string with `{{placeholder}}` markers. Spacing and quoting are preserved verbatim. */
  template: string
  /** Relative weight when picking among same-class (error vs non-error) templates. */
  weight: number
  level: LogLevel
  /** When true, the engine fires this template on error events only. */
  isError: boolean
}

export interface CustomNodeType {
  id: string
  name: string
  icon: string
  description: string
  /** Coarse format hint surfaced in the UI. */
  detectedFormat: 'json' | 'logfmt' | 'apache' | 'syslog' | 'plain' | 'mixed' | 'custom'
  templates: CustomLogTemplate[]
  placeholders: Record<string, PlaceholderSpec>
  /** Canonical port if obvious from samples (e.g. 80 for Apache). */
  defaultPort?: number
  /** Events/sec a typical instance produces. */
  defaultRate: number
  /** Fraction (0..1) of error/warn events to mix in. */
  defaultErrorRate: number
  /** Original samples the user pasted, kept for reference / re-inference. */
  sampleLogs: string
  inferredKind?: string
  createdAt: string
  updatedAt: string
}
