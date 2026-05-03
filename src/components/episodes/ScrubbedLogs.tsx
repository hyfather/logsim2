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
const LEVELS: readonly Level[] = ['ALL', 'INFO', 'WARN', 'ERROR'] as const
const FORMATS: readonly LogFormat[] = ['native', 'ocsf', 'otel'] as const

type Level = 'ALL' | LogLevel

interface LogCounts { INFO: number; WARN: number; ERROR: number }

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

  const counts: LogCounts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 }
    for (const l of logs) {
      if (l.level === 'INFO') c.INFO++
      else if (l.level === 'WARN') c.WARN++
      else if (l.level === 'ERROR' || l.level === 'FATAL') c.ERROR++
    }
    return c
  }, [logs])

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [filtered, follow])

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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn(
            'size-1.5 rounded-full',
            isRunning ? 'animate-pulse bg-emerald-500' : 'bg-slate-300',
          )} />
          <h2 className="text-[13px] font-semibold tracking-tight text-slate-900">Logs</h2>
          <span className="font-mono text-[11px] tabular-nums text-slate-400">
            {fmtTime(Math.round(tick))}
          </span>
        </div>
        <FormatToggle value={outputFormat} onChange={setOutputFormat} />
        <Counts counts={counts} className="ml-auto" />
      </header>

      <div className="flex flex-col gap-1.5 border-b border-slate-100 px-4 py-2">
        <input
          placeholder="Filter logs…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="h-7 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <MultiSelectMenu
            label="Sources"
            options={sourceOptions}
            selected={selectedChannels}
            onChange={setSelectedChannels}
            renderTriggerText={sel =>
              sel.length === 0
                ? 'Sources'
                : <>Sources <span className="ml-1 rounded bg-sky-100 px-1 font-mono text-[10px] tabular-nums text-sky-700">{sel.length}</span></>
            }
            triggerClassName={cn(
              'h-7 px-2.5 text-[11px] font-medium',
              selectedChannels.length > 0
                ? 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'
                : 'text-slate-600 hover:bg-slate-50',
            )}
          />
          <LevelFilter value={levelFilter} onChange={setLevelFilter} />
          <button
            type="button"
            onClick={() => setFollow(f => !f)}
            className={cn(
              'ml-auto flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors',
              follow
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-slate-200 bg-white text-slate-500 hover:text-slate-900',
            )}
            title="Auto-scroll to latest"
          >
            <span className={cn('size-1.5 rounded-full', follow ? 'bg-emerald-500' : 'bg-slate-300')} />
            Tail
          </button>
        </div>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 py-12 text-center text-[12px] text-slate-400">
            {isRunning ? 'Waiting for logs…' : 'Scrub the timeline or add a behavior block to generate logs.'}
          </div>
        ) : (
          filtered.map(l => (
            <LogRow
              key={l.id}
              log={l}
              expanded={expandedId === l.id}
              onToggle={handleToggleRow}
            />
          ))
        )}
      </div>
    </div>
  )
}

function FormatToggle({ value, onChange }: { value: LogFormat; onChange: (f: LogFormat) => void }) {
  return (
    <div
      className="flex h-6 items-center rounded-md bg-slate-100 p-0.5"
      title="Output schema (switching clears the buffer)"
    >
      {FORMATS.map(f => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={cn(
            'rounded-[4px] px-2 py-[1px] font-mono text-[10px] font-semibold uppercase tracking-wider transition-all',
            value === f
              ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
              : 'text-slate-500 hover:text-slate-700',
          )}
        >
          {f}
        </button>
      ))}
    </div>
  )
}

function LevelFilter({ value, onChange }: { value: Level; onChange: (l: Level) => void }) {
  return (
    <div className="flex h-7 items-center rounded-md bg-slate-100 p-0.5">
      {LEVELS.map(l => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          className={cn(
            'rounded-[4px] px-2 py-[2px] text-[11px] font-medium transition-all',
            value === l
              ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
              : 'text-slate-500 hover:text-slate-700',
          )}
        >
          {l === 'ALL' ? 'All' : l.charAt(0) + l.slice(1).toLowerCase()}
        </button>
      ))}
    </div>
  )
}

function Counts({ counts, className }: { counts: LogCounts; className?: string }) {
  const total = counts.INFO + counts.WARN + counts.ERROR
  return (
    <div className={cn('flex items-center gap-2.5 text-[11px] tabular-nums', className)}>
      <span className="text-slate-500">{total}</span>
      {counts.WARN > 0 && (
        <span className="flex items-center gap-1 font-medium text-amber-600">
          <span className="size-1 rounded-full bg-amber-500" />
          {counts.WARN}
        </span>
      )}
      {counts.ERROR > 0 && (
        <span className="flex items-center gap-1 font-medium text-red-600">
          <span className="size-1 rounded-full bg-red-500" />
          {counts.ERROR}
        </span>
      )}
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
  const tone = LEVEL_TONE[log.level] ?? LEVEL_TONE.INFO

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
        'group min-w-0 overflow-hidden transition-colors',
        expanded ? 'bg-slate-50' : tone.hover,
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(log.id)}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-3 px-4 py-1.5 text-left"
      >
        <span className="w-[60px] shrink-0 font-mono text-[10.5px] tabular-nums text-slate-400">
          {time}
        </span>
        <span className={cn('flex w-12 shrink-0 items-center gap-1.5', tone.text)}>
          <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} />
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider">
            {log.level}
          </span>
        </span>
        <span className={cn(
          'min-w-0 flex-1 font-mono text-[12px] leading-relaxed text-slate-700',
          expanded ? 'whitespace-pre-wrap break-all' : 'truncate',
        )}>
          {log.raw}
        </span>
      </button>

      {expanded && (
        <div className="min-w-0 space-y-2.5 px-4 pb-3 pt-1">
          {/* minmax(0, 1fr) lets the value column shrink past its min-content
              size — without it, a long unbroken channel/timestamp forces the
              grid wider than the panel and the row clips off-screen. */}
          <dl className="grid grid-cols-[60px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <Field label="Source" value={log.channel} mono />
            <Field label="Type" value={log.source.toLowerCase()} mono />
            <Field label="Time" value={log.ts} mono />
          </dl>
          {pretty && (
            <pre
              className="min-w-0 overflow-hidden rounded-md border border-slate-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-700"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {pretty}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{label}</dt>
      <dd
        className={cn('min-w-0 text-slate-700', mono && 'font-mono')}
        style={{ overflowWrap: 'anywhere' }}
      >
        {value}
      </dd>
    </>
  )
}

function safeIsoTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts.slice(11, 19) || ts
  return d.toISOString().slice(11, 19)
}

interface LevelTone {
  text: string
  dot: string
  hover: string
}

const LEVEL_TONE: Record<LogLevel, LevelTone> = {
  FATAL: { text: 'text-red-700', dot: 'bg-red-500', hover: 'hover:bg-red-50/60' },
  ERROR: { text: 'text-red-700', dot: 'bg-red-500', hover: 'hover:bg-red-50/60' },
  WARN: { text: 'text-amber-700', dot: 'bg-amber-500', hover: 'hover:bg-amber-50/60' },
  INFO: { text: 'text-slate-500', dot: 'bg-sky-400', hover: 'hover:bg-slate-50' },
  DEBUG: { text: 'text-slate-400', dot: 'bg-slate-300', hover: 'hover:bg-slate-50' },
}
