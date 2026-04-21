'use client'
import React, { useMemo } from 'react'
import type { LogEntry, LogLevel } from '@/types/logs'
import { cn } from '@/lib/utils'

const BUCKET_COUNT = 40

// Ordered so error-ish levels stack on top (rendered last → visually on top of the bar).
const LEVELS_IN_ORDER: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']

const LEVEL_BAR_COLOR: Record<LogLevel, string> = {
  DEBUG: 'bg-gray-300',
  INFO: 'bg-blue-400',
  WARN: 'bg-yellow-400',
  ERROR: 'bg-red-500',
  FATAL: 'bg-red-700',
}

interface Bucket {
  startMs: number
  endMs: number
  total: number
  counts: Record<LogLevel, number>
}

function buildBuckets(logs: LogEntry[]): { buckets: Bucket[]; minMs: number; maxMs: number } | null {
  if (logs.length === 0) return null

  // Logs are appended in order so first/last are usually the extrema, but tolerate out-of-order.
  let minMs = Infinity
  let maxMs = -Infinity
  for (let i = 0; i < logs.length; i++) {
    const t = Date.parse(logs[i].ts)
    if (Number.isNaN(t)) continue
    if (t < minMs) minMs = t
    if (t > maxMs) maxMs = t
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null
  if (maxMs === minMs) maxMs = minMs + 1

  const span = maxMs - minMs
  const bucketWidth = span / BUCKET_COUNT
  const buckets: Bucket[] = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
    startMs: minMs + i * bucketWidth,
    endMs: minMs + (i + 1) * bucketWidth,
    total: 0,
    counts: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
  }))

  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i]
    const t = Date.parse(entry.ts)
    if (Number.isNaN(t)) continue
    let idx = Math.floor((t - minMs) / bucketWidth)
    if (idx < 0) idx = 0
    else if (idx >= BUCKET_COUNT) idx = BUCKET_COUNT - 1
    const bucket = buckets[idx]
    bucket.total++
    bucket.counts[entry.level]++
  }

  return { buckets, minMs, maxMs }
}

function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = s / 60
  if (m < 60) return `${m.toFixed(1)}m`
  return `${(m / 60).toFixed(1)}h`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toISOString().slice(11, 19)
}

export function LogHistogram({
  logs,
  selectedRange,
  onSelectRange,
}: {
  logs: LogEntry[]
  selectedRange: [number, number] | null
  onSelectRange: (range: [number, number] | null) => void
}) {
  const data = useMemo(() => buildBuckets(logs), [logs])

  if (!data) {
    return (
      <div className="flex h-16 items-center justify-center border-b border-gray-200 bg-gray-50 text-[10px] text-gray-400">
        no events
      </div>
    )
  }

  const { buckets, minMs, maxMs } = data
  const maxBucket = buckets.reduce((m, b) => Math.max(m, b.total), 1)
  const span = maxMs - minMs
  const perBucket = span / BUCKET_COUNT

  return (
    <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-2 pb-1 pt-2">
      <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-gray-400">
        <span>{formatTime(minMs)}</span>
        <span className="font-medium text-gray-500">
          {buckets.length} buckets · {formatSpan(perBucket)}/bar · {logs.length} events
        </span>
        <span>{formatTime(maxMs)}</span>
      </div>
      <div
        className="flex h-12 items-end gap-px"
        role="img"
        aria-label="Log distribution over time"
      >
        {buckets.map((bucket, i) => {
          const heightPct = bucket.total === 0 ? 2 : Math.max(4, (bucket.total / maxBucket) * 100)
          const inSelection =
            selectedRange &&
            bucket.startMs < selectedRange[1] &&
            bucket.endMs > selectedRange[0]
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelectRange([bucket.startMs, bucket.endMs])}
              title={`${formatTime(bucket.startMs)} – ${formatTime(bucket.endMs)}\n${bucket.total} events\n` +
                LEVELS_IN_ORDER.filter(l => bucket.counts[l] > 0).map(l => `${l}: ${bucket.counts[l]}`).join('\n')}
              className={cn(
                'group relative flex h-full flex-1 flex-col-reverse overflow-hidden rounded-sm transition-all',
                inSelection ? 'ring-1 ring-blue-400' : 'opacity-90 hover:opacity-100',
                !selectedRange ? '' : inSelection ? '' : 'opacity-40',
              )}
              style={{ height: `${heightPct}%` }}
            >
              {LEVELS_IN_ORDER.map(level => {
                const count = bucket.counts[level]
                if (count === 0) return null
                const levelPct = (count / bucket.total) * 100
                return (
                  <div
                    key={level}
                    className={LEVEL_BAR_COLOR[level]}
                    style={{ height: `${levelPct}%` }}
                  />
                )
              })}
            </button>
          )
        })}
      </div>
      {selectedRange && (
        <button
          type="button"
          onClick={() => onSelectRange(null)}
          className="mt-1 text-[10px] text-blue-600 hover:underline"
        >
          clear time filter ({formatTime(selectedRange[0])} – {formatTime(selectedRange[1])})
        </button>
      )}
    </div>
  )
}
