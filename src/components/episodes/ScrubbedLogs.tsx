'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { logsAt } from '@/lib/logsAt'
import { canvasToScenarioYaml } from '@/lib/canvasToScenarioYaml'
import { fmtTime } from '@/lib/episodeBehavior'
import type { LogEntry } from '@/types/logs'
import { cn } from '@/lib/utils'

const SCRUB_WINDOW_TICKS = 30
const DEBOUNCE_MS = 120
const MAX_DISPLAY = 200
const SPARK_BUCKETS = 30

type Level = 'ALL' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export function ScrubbedLogs() {
  const tick = useEpisodeStore(s => s.tick)
  const episode = useEpisodeStore(s => s.episode)
  const runStatus = useEpisodeStore(s => s.runStatus)
  const nodes = useScenarioStore(s => s.nodes)
  const edges = useScenarioStore(s => s.edges)
  const metadata = useScenarioStore(s => s.metadata)
  const liveLogs = useSimulationStore(s => s.logBuffer)

  const [scrubLogs, setScrubLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<Level>('ALL')
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [follow, setFollow] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sourceMenuRef = useRef<HTMLDivElement>(null)

  const isRunning = runStatus === 'running'

  useEffect(() => {
    if (isRunning) return
    const ctrl = new AbortController()
    const handle = setTimeout(async () => {
      try {
        const to = Math.max(1, Math.floor(tick))
        const from = Math.max(0, to - SCRUB_WINDOW_TICKS)
        if (to <= from) {
          setScrubLogs([])
          return
        }
        const scenarioYaml = canvasToScenarioYaml(nodes, edges, metadata, {
          episode,
          tickIntervalMs: 1000,
        })
        const logs = await logsAt({
          scenarioYaml,
          from,
          to,
          tickIntervalMs: 1000,
          seed: 0,
          signal: ctrl.signal,
        })
        setScrubLogs(logs)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        console.warn('scrub fetch failed:', err)
      }
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(handle)
      ctrl.abort()
    }
  }, [tick, episode, nodes, edges, metadata, isRunning])

  const logs = isRunning ? liveLogs.slice(-MAX_DISPLAY) : scrubLogs.slice(-MAX_DISPLAY)

  const allChannels = useMemo(() => {
    const set = new Set<string>()
    for (const l of logs) set.add(l.channel)
    return Array.from(set).sort()
  }, [logs])

  // Drop selections that no longer exist in the current log set so the badge count stays accurate.
  useEffect(() => {
    if (selectedChannels.size === 0) return
    const next = new Set<string>()
    for (const c of selectedChannels) if (allChannels.includes(c)) next.add(c)
    if (next.size !== selectedChannels.size) setSelectedChannels(next)
  }, [allChannels, selectedChannels])

  useEffect(() => {
    if (!sourceMenuOpen) return
    const onClick = (e: MouseEvent) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(e.target as Node)) {
        setSourceMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [sourceMenuOpen])

  const filtered = useMemo(() => logs.filter(l => {
    if (levelFilter !== 'ALL' && l.level !== levelFilter) return false
    if (selectedChannels.size > 0 && !selectedChannels.has(l.channel)) return false
    if (filter) {
      const q = filter.toLowerCase()
      if (!l.raw.toLowerCase().includes(q) && !l.channel.toLowerCase().includes(q)) return false
    }
    return true
  }), [logs, filter, levelFilter, selectedChannels])

  const counts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 }
    for (const l of logs) {
      if (l.level === 'INFO') c.INFO++
      else if (l.level === 'WARN') c.WARN++
      else if (l.level === 'ERROR' || l.level === 'FATAL') c.ERROR++
    }
    return c
  }, [logs])

  const sparklines = useMemo(() => buildSparklines(logs, allChannels), [logs, allChannels])

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [filtered, follow])

  const toggleChannel = (ch: string) => {
    setSelectedChannels(prev => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch)
      else next.add(ch)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className={cn(
            'inline-block size-1.5 rounded-full',
            isRunning ? 'animate-pulse bg-emerald-500' : 'bg-slate-300',
          )} />
          <span className="font-semibold text-slate-700">Logs at {fmtTime(Math.round(tick))}</span>
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px]">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{counts.INFO}</span>
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">{counts.WARN}</span>
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{counts.ERROR}</span>
        </div>
      </div>

      {sparklines.length > 0 && (
        <div className="border-b border-slate-200 bg-slate-50/60 px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-slate-500">
            <span>Volume by source</span>
            <span className="font-mono">{sparklines.length} {sparklines.length === 1 ? 'source' : 'sources'}</span>
          </div>
          <div className="space-y-0.5">
            {sparklines.map(s => {
              const active = selectedChannels.size === 0 || selectedChannels.has(s.channel)
              return (
                <button
                  key={s.channel}
                  onClick={() => toggleChannel(s.channel)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[10px] transition-colors hover:bg-slate-100',
                    !active && 'opacity-40',
                  )}
                  title={`${s.channel} — ${s.total} entries (click to filter)`}
                >
                  <span className="w-32 shrink-0 truncate font-mono text-slate-700">{s.channel}</span>
                  <Sparkline buckets={s.buckets} max={s.max} />
                  <span className="w-10 shrink-0 text-right font-mono tabular-nums text-slate-500">{s.total}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 border-b border-slate-200 px-3 py-1.5">
        <input
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-[11px] focus:border-slate-400 focus:outline-none"
        />

        <div ref={sourceMenuRef} className="relative">
          <button
            onClick={() => setSourceMenuOpen(o => !o)}
            disabled={allChannels.length === 0}
            className={cn(
              'flex h-7 items-center gap-1 rounded border px-2 text-[10px] font-medium',
              selectedChannels.size > 0
                ? 'border-sky-300 bg-sky-50 text-sky-700'
                : 'border-slate-200 bg-white text-slate-600 hover:text-slate-900',
              allChannels.length === 0 && 'cursor-not-allowed opacity-50',
            )}
          >
            <span>Sources</span>
            {selectedChannels.size > 0 && (
              <span className="rounded bg-sky-200 px-1 font-mono text-[9px] text-sky-800">{selectedChannels.size}</span>
            )}
            <svg width="8" height="8" viewBox="0 0 8 8" className="text-slate-400">
              <path d="M1 2 L4 6 L7 2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          {sourceMenuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 max-h-64 w-64 overflow-auto rounded border border-slate-200 bg-white shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-100 px-2 py-1.5 text-[10px]">
                <span className="font-medium text-slate-500">
                  {selectedChannels.size === 0 ? 'All sources' : `${selectedChannels.size} selected`}
                </span>
                <button
                  onClick={() => setSelectedChannels(new Set())}
                  className="text-sky-600 hover:underline disabled:opacity-40"
                  disabled={selectedChannels.size === 0}
                >
                  Clear
                </button>
              </div>
              {allChannels.map(ch => {
                const checked = selectedChannels.has(ch)
                return (
                  <label
                    key={ch}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px] hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleChannel(ch)}
                      className="size-3 accent-sky-600"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-slate-700">{ch}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex rounded border border-slate-200 bg-slate-50 text-[10px]">
          {(['ALL', 'INFO', 'WARN', 'ERROR'] as Level[]).map(l => (
            <button
              key={l}
              onClick={() => setLevelFilter(l)}
              className={cn(
                'px-1.5 py-1 font-medium',
                levelFilter === l ? 'bg-slate-700 text-white' : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {l}
            </button>
          ))}
        </div>
        <button
          onClick={() => setFollow(f => !f)}
          className={cn(
            'flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] font-medium',
            follow
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-white text-slate-500',
          )}
          title="Auto-scroll to latest"
        >
          Tail
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-auto bg-white px-2 py-1.5 font-mono text-[11px] text-slate-800">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] italic text-slate-400">
            {isRunning ? 'Waiting for logs…' : 'Scrub the timeline or add a behavior block to generate logs.'}
          </div>
        ) : (
          filtered.map(l => (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap border-b border-slate-100 py-0.5 leading-snug last:border-0">
              <span className="shrink-0 text-slate-400">{new Date(l.ts).toISOString().slice(11, 19)}</span>
              <span className="shrink-0 truncate text-cyan-700" style={{ maxWidth: 120 }}>{l.channel}</span>
              <span className={cn('w-12 shrink-0', levelClass(l.level))}>{l.level}</span>
              <span className="min-w-0 flex-1 break-all text-slate-800">{l.raw}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function levelClass(level: string): string {
  switch (level) {
    case 'ERROR':
    case 'FATAL':
      return 'text-red-600'
    case 'WARN':
      return 'text-amber-600'
    case 'INFO':
      return 'text-slate-600'
    case 'DEBUG':
      return 'text-slate-400'
    default:
      return 'text-slate-500'
  }
}

interface SparkSeries {
  channel: string
  buckets: number[]
  total: number
  max: number
}

function buildSparklines(logs: LogEntry[], channels: string[]): SparkSeries[] {
  if (logs.length === 0 || channels.length === 0) return []
  let minTs = Infinity
  let maxTs = -Infinity
  for (const l of logs) {
    const t = Date.parse(l.ts)
    if (!Number.isNaN(t)) {
      if (t < minTs) minTs = t
      if (t > maxTs) maxTs = t
    }
  }
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return []
  const span = Math.max(1, maxTs - minTs)
  const series: Record<string, number[]> = {}
  for (const c of channels) series[c] = new Array(SPARK_BUCKETS).fill(0)
  for (const l of logs) {
    const t = Date.parse(l.ts)
    if (Number.isNaN(t)) continue
    const idx = Math.min(SPARK_BUCKETS - 1, Math.floor(((t - minTs) / span) * SPARK_BUCKETS))
    const arr = series[l.channel]
    if (arr) arr[idx]++
  }
  return channels
    .map(channel => {
      const buckets = series[channel]
      let total = 0
      let max = 0
      for (const v of buckets) {
        total += v
        if (v > max) max = v
      }
      return { channel, buckets, total, max }
    })
    .filter(s => s.total > 0)
    .sort((a, b) => b.total - a.total)
}

function Sparkline({ buckets, max }: { buckets: number[]; max: number }) {
  const W = 160
  const H = 16
  const n = buckets.length
  const barW = W / n
  const safeMax = Math.max(1, max)
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden>
      {buckets.map((v, i) => {
        const h = v === 0 ? 0 : Math.max(1, (v / safeMax) * (H - 2))
        return (
          <rect
            key={i}
            x={i * barW}
            y={H - h}
            width={Math.max(1, barW - 1)}
            height={h}
            className="fill-sky-500"
          />
        )
      })}
    </svg>
  )
}
