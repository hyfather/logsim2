'use client'
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { logsAt } from '@/lib/logsAt'
import { canvasToScenarioYaml } from '@/lib/canvasToScenarioYaml'
import { fmtTime } from '@/lib/episodeBehavior'
import type { LogEntry, LogFormat, LogLevel } from '@/types/logs'
import { cn } from '@/lib/utils'
import { MultiSelectMenu } from '@/components/panels/MultiSelectMenu'

const DEBOUNCE_MS = 120
const MAX_DISPLAY = 200
const SPARK_BUCKETS = 30

type Level = 'ALL' | LogLevel

export function ScrubbedLogs() {
  const tick = useEpisodeStore(s => s.tick)
  const episode = useEpisodeStore(s => s.episode)
  const runStatus = useEpisodeStore(s => s.runStatus)
  const nodes = useScenarioStore(s => s.nodes)
  const edges = useScenarioStore(s => s.edges)
  const metadata = useScenarioStore(s => s.metadata)
  const liveLogs = useSimulationStore(s => s.logBuffer)
  const outputFormat = useSimulationStore(s => s.outputFormat)
  const setOutputFormat = useSimulationStore(s => s.setOutputFormat)

  const [scrubLogs, setScrubLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<Level>('ALL')
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])
  const [follow, setFollow] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const isRunning = runStatus === 'running'
  const episodeDuration = episode.duration

  useEffect(() => {
    if (isRunning) return
    const ctrl = new AbortController()
    const handle = setTimeout(async () => {
      try {
        const to = Math.max(0, Math.floor(tick))
        if (to <= 0) {
          setScrubLogs([])
          return
        }
        // Fetch the cumulative log prefix [0, to) so the panel shows
        // everything that would have been emitted up to the scrubber's
        // current position — not just the trailing 30 ticks.
        const scenarioYaml = canvasToScenarioYaml(nodes, edges, metadata, {
          episode,
          tickIntervalMs: 1000,
        })
        const logs = await logsAt({
          scenarioYaml,
          from: 0,
          to,
          tickIntervalMs: 1000,
          seed: 0,
          format: outputFormat,
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
  }, [tick, episode, nodes, edges, metadata, isRunning, outputFormat])

  const logs = isRunning ? liveLogs.slice(-MAX_DISPLAY) : scrubLogs.slice(-MAX_DISPLAY)

  const allChannels = useMemo(() => {
    const set = new Set<string>()
    for (const l of logs) set.add(l.channel)
    return Array.from(set).sort()
  }, [logs])

  // Drop selections that no longer exist in the current log set so the badge count stays accurate.
  useEffect(() => {
    if (selectedChannels.length === 0) return
    const next = selectedChannels.filter(c => allChannels.includes(c))
    if (next.length !== selectedChannels.length) setSelectedChannels(next)
  }, [allChannels, selectedChannels])

  const selectedSet = useMemo(() => new Set(selectedChannels), [selectedChannels])

  const filtered = useMemo(() => logs.filter(l => {
    if (levelFilter !== 'ALL' && l.level !== levelFilter) return false
    if (selectedSet.size > 0 && !selectedSet.has(l.channel)) return false
    if (filter) {
      const q = filter.toLowerCase()
      if (!l.raw.toLowerCase().includes(q) && !l.channel.toLowerCase().includes(q)) return false
    }
    return true
  }), [logs, filter, levelFilter, selectedSet])

  const counts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 }
    for (const l of logs) {
      if (l.level === 'INFO') c.INFO++
      else if (l.level === 'WARN') c.WARN++
      else if (l.level === 'ERROR' || l.level === 'FATAL') c.ERROR++
    }
    return c
  }, [logs])

  const sparkData = useMemo(
    () => buildSparklines(logs, allChannels, episodeDuration, tick),
    [logs, allChannels, episodeDuration, tick],
  )

  const commonAffixes = useMemo(
    () => computeCommonAffixes(sparkData.series.map(s => s.channel)),
    [sparkData.series],
  )

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [filtered, follow])

  // Collapse any expanded row that's no longer visible after a filter change.
  useEffect(() => {
    if (!expandedId) return
    if (!filtered.some(l => l.id === expandedId)) setExpandedId(null)
  }, [filtered, expandedId])

  const handleToggleRow = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  const sourceOptions = useMemo(
    () => allChannels.map(ch => ({ value: ch, label: ch, title: ch })),
    [allChannels],
  )

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className={cn(
            'inline-block size-1.5 rounded-full',
            isRunning ? 'animate-pulse bg-emerald-500' : 'bg-slate-300',
          )} />
          <span className="font-semibold text-slate-700">Logs at {fmtTime(Math.round(tick))}</span>
        </div>
        <div className="flex items-center gap-2">
          <FormatToggle value={outputFormat} onChange={setOutputFormat} />
          <div className="flex items-center gap-1 font-mono text-[10px]">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{counts.INFO}</span>
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">{counts.WARN}</span>
            <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{counts.ERROR}</span>
          </div>
        </div>
      </div>

      {sparkData.series.length > 0 && (
        <div className="border-b border-slate-200 bg-slate-50/60 px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-slate-500">
            <span>Volume by source</span>
            <span className="font-mono">{sparkData.series.length} {sparkData.series.length === 1 ? 'source' : 'sources'}</span>
          </div>
          {(commonAffixes.prefix || commonAffixes.suffix) && (
            <div
              className="mb-1 truncate font-mono text-[9px] text-slate-400"
              title={`Shared by all sources: ${commonAffixes.prefix}…${commonAffixes.suffix}`}
            >
              {commonAffixes.prefix && <span>{commonAffixes.prefix}</span>}
              <span className="text-slate-300">…</span>
              {commonAffixes.suffix && <span>{commonAffixes.suffix}</span>}
            </div>
          )}
          <div className="space-y-0.5">
            {sparkData.series.map(s => {
              const active = selectedSet.size === 0 || selectedSet.has(s.channel)
              const distinct = s.channel.slice(
                commonAffixes.prefix.length,
                s.channel.length - commonAffixes.suffix.length,
              ) || s.channel
              return (
                <button
                  key={s.channel}
                  onClick={() => setSelectedChannels(prev =>
                    prev.includes(s.channel) ? prev.filter(c => c !== s.channel) : [...prev, s.channel],
                  )}
                  className={cn(
                    'group relative flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[10px] transition-colors hover:bg-slate-100',
                    !active && 'opacity-40',
                  )}
                >
                  <span className="w-24 shrink-0 truncate font-mono text-slate-700 sm:w-32">{distinct}</span>
                  <Sparkline buckets={s.buckets} max={s.max} progress={sparkData.progress} />
                  <span className="w-10 shrink-0 text-right font-mono tabular-nums text-slate-500">{s.total}</span>
                  {distinct !== s.channel && (
                    <span className="pointer-events-none absolute left-1 top-full z-10 hidden whitespace-nowrap rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-700 shadow-sm group-hover:block">
                      {s.channel}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-1.5">
        <input
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-[11px] focus:border-slate-400 focus:outline-none"
        />

        <MultiSelectMenu
          label="Sources"
          options={sourceOptions}
          selected={selectedChannels}
          onChange={setSelectedChannels}
          renderTriggerText={sel =>
            sel.length === 0
              ? 'Sources'
              : <>Sources <span className="ml-1 rounded bg-sky-200 px-1 font-mono text-[9px] text-sky-800">{sel.length}</span></>
          }
          triggerClassName={cn(
            'h-7 px-2 text-[10px] font-medium',
            selectedChannels.length > 0
              ? 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'
              : 'text-slate-600',
          )}
        />

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

      <div ref={bodyRef} className="flex-1 overflow-auto bg-white">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] italic text-slate-400">
            {isRunning ? 'Waiting for logs…' : 'Scrub the timeline or add a behavior block to generate logs.'}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map(l => (
              <LogRow
                key={l.id}
                log={l}
                expanded={expandedId === l.id}
                onToggle={handleToggleRow}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FormatToggle({ value, onChange }: { value: LogFormat; onChange: (f: LogFormat) => void }) {
  const FORMATS: readonly LogFormat[] = ['native', 'ocsf', 'otel'] as const
  return (
    <div
      className="flex h-6 items-center gap-0 rounded-md border border-slate-200 bg-slate-50 p-[2px]"
      title="Output schema (switching clears the buffer)"
    >
      {FORMATS.map(f => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={cn(
            'rounded-[3px] px-1.5 py-[1px] font-mono text-[9.5px] font-semibold uppercase tracking-wide transition-colors',
            value === f
              ? 'bg-white text-slate-900 shadow-[0_1px_1px_rgba(15,23,42,0.05)]'
              : 'text-slate-500 hover:text-slate-900',
          )}
        >
          {f}
        </button>
      ))}
    </div>
  )
}

const LogRow = memo(function LogRow({
  log, expanded, onToggle,
}: {
  log: LogEntry
  expanded: boolean
  onToggle: (id: string) => void
}) {
  const time = safeIsoTime(log.ts)
  const stripe = STRIPE_CLASS[log.level] ?? STRIPE_CLASS.INFO
  const pill = PILL_CLASS[log.level] ?? PILL_CLASS.INFO

  // JSON is only re-parsed when expanded flips true, since pretty-printing
  // megabytes of stringified OCSF for collapsed rows would be wasted work.
  const pretty = useMemo(() => {
    if (!expanded) return null
    const trimmed = log.raw.trimStart()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return null
    }
  }, [log.raw, expanded])

  return (
    <div
      className={cn(
        'group border-l-2 transition-colors',
        stripe,
        expanded ? 'bg-sky-50/40' : 'hover:bg-slate-50',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(log.id)}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left"
      >
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400">
          {time}
        </span>
        <span className={cn(
          'shrink-0 rounded px-1 font-mono text-[9.5px] font-semibold uppercase tracking-wide',
          pill,
        )}>
          {log.level}
        </span>
        <span className={cn(
          'min-w-0 flex-1 font-mono text-[11px] leading-snug text-slate-800',
          expanded ? 'whitespace-pre-wrap break-all' : 'truncate',
        )}>
          {log.raw}
        </span>
      </button>

      {expanded && (
        <div className="space-y-1.5 px-2 pb-2 pt-0">
          <div className="flex flex-wrap items-center gap-1 text-[10px]">
            <span className="rounded bg-white px-1.5 py-0.5 font-mono text-cyan-700 ring-1 ring-slate-200">
              {log.channel}
            </span>
            <span className="rounded bg-white px-1.5 py-0.5 font-mono uppercase tracking-wide text-slate-500 ring-1 ring-slate-200">
              {log.source}
            </span>
            <span className="font-mono text-slate-400">{log.ts}</span>
          </div>
          {pretty && (
            <pre className="overflow-auto rounded border border-slate-200 bg-slate-900 p-2 font-mono text-[10.5px] leading-snug text-slate-100">
              {pretty}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

function safeIsoTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts.slice(11, 19) || ts
  return d.toISOString().slice(11, 19)
}

const STRIPE_CLASS: Record<LogLevel, string> = {
  FATAL: 'border-l-red-400',
  ERROR: 'border-l-red-400',
  WARN: 'border-l-amber-400',
  INFO: 'border-l-slate-200',
  DEBUG: 'border-l-slate-100',
}

const PILL_CLASS: Record<LogLevel, string> = {
  FATAL: 'bg-red-100 text-red-700',
  ERROR: 'bg-red-100 text-red-700',
  WARN: 'bg-amber-100 text-amber-700',
  INFO: 'bg-slate-100 text-slate-600',
  DEBUG: 'bg-slate-50 text-slate-400',
}

interface SparkSeries {
  channel: string
  buckets: number[]
  total: number
  max: number
}

interface SparkData {
  series: SparkSeries[]
  /** Fraction of the episode timeline that's been played (0..1). */
  progress: number
}

const AFFIX_DELIMS = '.-_:/'

function computeCommonAffixes(channels: string[]): { prefix: string; suffix: string } {
  if (channels.length < 2) return { prefix: '', suffix: '' }
  let prefix = channels[0]
  let suffix = channels[0]
  for (let i = 1; i < channels.length; i++) {
    const c = channels[i]
    while (prefix && !c.startsWith(prefix)) prefix = prefix.slice(0, -1)
    while (suffix && !c.endsWith(suffix)) suffix = suffix.slice(1)
    if (!prefix && !suffix) break
  }
  // Snap to delimiter boundaries so we don't cut mid-segment.
  let pi = prefix.length
  while (pi > 0 && !AFFIX_DELIMS.includes(prefix[pi - 1])) pi--
  prefix = prefix.slice(0, pi)
  let si = 0
  while (si < suffix.length && !AFFIX_DELIMS.includes(suffix[si])) si++
  suffix = suffix.slice(si)
  // Bail out if stripping would empty any label or the saving is trivial.
  if (prefix.length + suffix.length < 4) return { prefix: '', suffix: '' }
  for (const c of channels) {
    if (c.length - prefix.length - suffix.length <= 0) return { prefix: '', suffix: '' }
  }
  return { prefix, suffix }
}

// Spread log volume across the full episode timeline so a sparkline at
// tick 60 of a 300s scenario fills only ~20% of its width — the empty
// trailing portion is the part of the episode that hasn't played yet.
function buildSparklines(
  logs: LogEntry[],
  channels: string[],
  episodeDurationSec: number,
  currentTickSec: number,
): SparkData {
  if (logs.length === 0 || channels.length === 0) return { series: [], progress: 0 }
  const totalMs = Math.max(1, episodeDurationSec * 1000)
  let maxTs = -Infinity
  for (const l of logs) {
    const t = Date.parse(l.ts)
    if (!Number.isNaN(t) && t > maxTs) maxTs = t
  }
  if (!Number.isFinite(maxTs)) return { series: [], progress: 0 }

  // Anchor: the latest log we have was emitted near `currentTickSec`. Back-
  // solve for the episode's wall-clock start so each log can be placed at
  // its true tick position rather than relative to the displayed window.
  const tickAnchor = Math.max(0, currentTickSec)
  const baseTime = tickAnchor > 0 ? maxTs - tickAnchor * 1000 : maxTs

  const series: Record<string, number[]> = {}
  for (const c of channels) series[c] = new Array(SPARK_BUCKETS).fill(0)
  for (const l of logs) {
    const t = Date.parse(l.ts)
    if (Number.isNaN(t)) continue
    const offset = t - baseTime
    if (offset < 0 || offset > totalMs) continue
    const idx = Math.min(SPARK_BUCKETS - 1, Math.floor((offset / totalMs) * SPARK_BUCKETS))
    const arr = series[l.channel]
    if (arr) arr[idx]++
  }

  const out = channels
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

  const progress = Math.min(1, Math.max(0, tickAnchor / Math.max(1, episodeDurationSec)))
  return { series: out, progress }
}

function Sparkline({
  buckets, max, progress,
}: {
  buckets: number[]
  max: number
  progress: number
}) {
  const W = 160
  const H = 18
  const PAD = 1.5
  const n = buckets.length
  if (n === 0) return <svg width={W} height={H} aria-hidden />
  const safeMax = Math.max(1, max)
  const xs = buckets.map((_, i) => (n === 1 ? W / 2 : (i / (n - 1)) * W))
  const ys = buckets.map(v => H - PAD - (v / safeMax) * (H - PAD * 2))
  const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${ys[i].toFixed(2)}`).join(' ')
  const areaPath = `${linePath} L ${xs[n - 1].toFixed(2)} ${H} L ${xs[0].toFixed(2)} ${H} Z`
  const playheadX = Math.max(0, Math.min(W, progress * W))
  return (
    <svg width={W} height={H} className="shrink-0 overflow-visible" aria-hidden>
      {/* Baseline track spans the full episode duration so the empty
          right-hand portion reads as "not played yet" rather than "no data". */}
      <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} className="stroke-slate-200" strokeWidth={1} />
      <path d={areaPath} className="fill-sky-500/15" />
      <path
        d={linePath}
        className="stroke-sky-500"
        strokeWidth={1.25}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {progress > 0 && progress < 1 && (
        <line
          x1={playheadX}
          y1={0}
          x2={playheadX}
          y2={H}
          className="stroke-slate-300"
          strokeWidth={0.75}
          strokeDasharray="1.5 2"
        />
      )}
    </svg>
  )
}
