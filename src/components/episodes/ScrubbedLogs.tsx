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
  const [follow, setFollow] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  const isRunning = runStatus === 'running'

  // Debounced fetch when scrubbing (idle). Re-runs the scenario from tick 0
  // server-side to deterministically reproduce the [from, to) window —
  // matches what the live run would emit at this position.
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
        // Soft-fail: leave previous logs in place rather than blanking the panel.
        console.warn('scrub fetch failed:', err)
      }
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(handle)
      ctrl.abort()
    }
  }, [tick, episode, nodes, edges, metadata, isRunning])

  const logs = isRunning ? liveLogs.slice(-MAX_DISPLAY) : scrubLogs.slice(-MAX_DISPLAY)

  const filtered = useMemo(() => logs.filter(l => {
    if (levelFilter !== 'ALL' && l.level !== levelFilter) return false
    if (filter) {
      const q = filter.toLowerCase()
      if (!l.raw.toLowerCase().includes(q) && !l.channel.toLowerCase().includes(q)) return false
    }
    return true
  }), [logs, filter, levelFilter])

  const counts = useMemo(() => {
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

      <div className="flex items-center gap-1.5 border-b border-slate-200 px-3 py-1.5">
        <input
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-[11px] focus:border-slate-400 focus:outline-none"
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

      <div ref={bodyRef} className="flex-1 overflow-auto bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] italic text-slate-500">
            {isRunning ? 'Waiting for logs…' : 'Scrub the timeline or add a behavior block to generate logs.'}
          </div>
        ) : (
          filtered.map(l => (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap py-0.5 leading-snug">
              <span className="shrink-0 text-slate-500">{new Date(l.ts).toISOString().slice(11, 19)}</span>
              <span className="shrink-0 truncate text-cyan-300" style={{ maxWidth: 120 }}>{l.channel}</span>
              <span className={cn('shrink-0 w-12', levelClass(l.level))}>{l.level}</span>
              <span className="min-w-0 flex-1 break-all text-slate-100">{l.raw}</span>
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
      return 'text-red-400'
    case 'WARN':
      return 'text-amber-300'
    case 'INFO':
      return 'text-slate-300'
    case 'DEBUG':
      return 'text-slate-500'
    default:
      return 'text-slate-400'
  }
}
