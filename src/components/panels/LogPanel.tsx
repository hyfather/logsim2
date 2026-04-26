'use client'
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { forwardToHec } from '@/lib/criblForwarder'
import type { CriblHecDestination, DestinationConfig } from '@/types/destinations'
import type { LogEntry, LogLevel } from '@/types/logs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { PanelRightClose, PanelLeftClose, Download, Send, Trash2, Loader2, Check, AlertCircle } from 'lucide-react'
import { useUIStore } from '@/store/useUIStore'
import { useVirtualizer } from '@tanstack/react-virtual'
import { LogHistogram } from '@/components/panels/LogHistogram'
import { MultiSelectMenu } from '@/components/panels/MultiSelectMenu'
import type { PanelMode } from '@/app/editor/EditorPageClient'

const LEVEL_TEXT: Record<LogLevel, string> = {
  DEBUG: 'text-gray-500',
  INFO: 'text-blue-600',
  WARN: 'text-yellow-600',
  ERROR: 'text-red-600',
  FATAL: 'text-red-800 font-bold',
}

const LEVEL_DOT: Record<LogLevel, string> = {
  DEBUG: 'bg-gray-300',
  INFO: 'bg-blue-400',
  WARN: 'bg-yellow-400',
  ERROR: 'bg-red-500',
  FATAL: 'bg-red-700',
}

const LEVEL_BG: Record<LogLevel, string> = {
  DEBUG: '',
  INFO: '',
  WARN: 'bg-yellow-50',
  ERROR: 'bg-red-50',
  FATAL: 'bg-red-100',
}

const ALL_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']

// --- HTTP method / status regexes for auto-derived facets ---
const METHOD_REGEX = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/
const STATUS_REGEX = /\s(\d{3})\s/

function extractMethod(raw: string): string | null {
  const m = raw.match(METHOD_REGEX)
  return m ? m[1] : null
}

function extractStatusClass(raw: string): string | null {
  const m = raw.match(STATUS_REGEX)
  if (!m) return null
  const code = parseInt(m[1], 10)
  if (code < 100 || code > 599) return null
  return `${Math.floor(code / 100)}xx`
}

// Longest '.'-delimited prefix shared by every input. Returns '' when only
// one input or no segment-aligned prefix exists.
function commonDottedPrefix(strs: string[]): string {
  if (strs.length <= 1) return ''
  let p = strs[0]
  for (let i = 1; i < strs.length; i++) {
    while (p && strs[i].indexOf(p) !== 0) p = p.slice(0, -1)
    if (!p) return ''
  }
  const lastDot = p.lastIndexOf('.')
  return lastDot >= 0 ? p.slice(0, lastDot + 1) : ''
}

const COLLAPSED_ROW_HEIGHT = 52
const EXPANDED_ROW_HEIGHT = 176

function highlightKeyword(text: string, keyword: string): React.ReactNode {
  if (!keyword) return text
  const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${safeKeyword})`, 'gi')
  const parts = text.split(regex)
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="bg-yellow-200 text-yellow-900">{part}</mark>
      : part
  )
}

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

interface LogRowProps {
  entry: LogEntry
  keyword: string
  expanded: boolean
  onToggle: () => void
}

const LogRow = React.memo(function LogRow({ entry, keyword, expanded, onToggle }: LogRowProps) {
  const channelShort = entry.channel.split('.').slice(-2).join('.')
  return (
    <div
      className={cn(
        'box-border flex h-full cursor-pointer flex-col overflow-hidden border-b border-gray-100 border-l-2 border-l-transparent px-2.5 py-1.5 hover:bg-gray-50',
        LEVEL_BG[entry.level],
        expanded && 'border-l-blue-400 bg-blue-50',
      )}
      onClick={onToggle}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px]">
        <span className={cn('shrink-0 font-bold', LEVEL_TEXT[entry.level])}>
          {entry.level.slice(0, 4)}
        </span>
        <span className="min-w-0 flex-1 truncate text-gray-400" title={entry.channel}>
          {channelShort}
        </span>
        <span className="shrink-0 text-[9px] text-gray-300">
          {entry.ts.slice(11, 23)}
        </span>
      </div>
      <div
        className={cn(
          'mt-0.5 font-mono text-[11px] leading-snug text-gray-700',
          expanded ? 'whitespace-pre-wrap break-all' : 'truncate',
        )}
      >
        {keyword ? highlightKeyword(entry.raw, keyword) : entry.raw}
      </div>
      {expanded && (
        <div className="mt-2 rounded-md border border-blue-100 bg-white px-2.5 py-2 font-mono text-[10px]">
          <div className="font-semibold text-gray-700">{entry.channel}</div>
          <div className="mt-1 text-gray-500">{entry.ts}</div>
          <div className="mt-1 uppercase tracking-wide text-gray-400">{entry.source}</div>
        </div>
      )}
    </div>
  )
})

interface LogPanelProps {
  panelMode: PanelMode
  onCollapse: () => void
  onSetWidth: (fraction: number) => void
}

export function LogPanel({ onCollapse }: LogPanelProps) {
  const logBuffer = useSimulationStore(s => s.logBuffer)
  const filter = useSimulationStore(s => s.filter)
  const autoScroll = useSimulationStore(s => s.autoScroll)
  const setFilter = useSimulationStore(s => s.setFilter)
  const setAutoScroll = useSimulationStore(s => s.setAutoScroll)
  const clearLogs = useSimulationStore(s => s.clearLogs)
  const destinations = useDestinationsStore(s => s.destinations)
  const destStatuses = useDestinationsStore(s => s.statuses)
  const destErrors = useDestinationsStore(s => s.errors)
  const setDestStatus = useDestinationsStore(s => s.setStatus)
  const recordSent = useDestinationsStore(s => s.recordSent)
  const canvasOpen = useUIStore(s => s.canvasOpen)
  const setCanvasOpen = useUIStore(s => s.setCanvasOpen)
  const logPanelWidth = useUIStore(s => s.logPanelWidth)
  // Panel occupies the full remaining viewport when canvas is collapsed;
  // otherwise it's the user-set width. Switch to an inline row layout once
  // there's room (~720px) to lay all filters + action button side by side.
  const [viewportWidth, setViewportWidth] = useState(typeof window === 'undefined' ? 1024 : window.innerWidth)
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const effectiveWidth = canvasOpen ? logPanelWidth : viewportWidth
  const isWide = effectiveWidth >= 720

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const deferredKeyword = useDeferredValue(filter.keyword)
  // Per-destination transient success indicators ("Sent N" that fades)
  const [recentSent, setRecentSent] = useState<Record<string, number>>({})

  // All source channels present in the current buffer (pre-filter).
  // Derived from real logs so this works in any mode, whether or not the
  // scenario has nodes wired up.
  const allSources = useMemo(() => {
    const set = new Set<string>()
    for (let i = 0; i < logBuffer.length; i++) set.add(logBuffer[i].channel)
    return Array.from(set).sort()
  }, [logBuffer])

  // --- Single-pass filtering + facet counting ---
  type FacetCounts = {
    level: Record<LogLevel, number>
    source: Record<string, number>
    method: Record<string, number>
    statusClass: Record<string, number>
  }

  const { filteredLogs, facets } = useMemo(() => {
    const normalizedKeyword = deferredKeyword.trim().toLowerCase()
    const sourceSet = filter.sources.length ? new Set(filter.sources) : null
    const levelSet = new Set(filter.levels)
    const timeRange = filter.timeRange
    const facets: FacetCounts = {
      level: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
      source: {},
      method: {},
      statusClass: {},
    }
    const out: LogEntry[] = []

    for (let i = 0; i < logBuffer.length; i++) {
      const entry = logBuffer[i]

      // Non-level filters first, so per-level facet counts reflect remaining dimensions.
      if (sourceSet && !sourceSet.has(entry.channel)) continue
      if (normalizedKeyword && !entry.raw.toLowerCase().includes(normalizedKeyword)) continue
      if (timeRange) {
        const t = Date.parse(entry.ts)
        if (t < timeRange[0] || t > timeRange[1]) continue
      }

      // For level facet, count without applying current level filter.
      facets.level[entry.level]++

      if (!levelSet.has(entry.level)) continue

      out.push(entry)

      // Source facet: keyed by full channel (matches what the filter uses).
      facets.source[entry.channel] = (facets.source[entry.channel] ?? 0) + 1

      const method = extractMethod(entry.raw)
      if (method) facets.method[method] = (facets.method[method] ?? 0) + 1

      const sc = extractStatusClass(entry.raw)
      if (sc) facets.statusClass[sc] = (facets.statusClass[sc] ?? 0) + 1
    }

    return { filteredLogs: out, facets }
  }, [logBuffer, filter.sources, filter.levels, filter.timeRange, deferredKeyword])

  // --- Method / status-class derived filters ---
  // Stored in component state (not persisted) since they're view-level facets.
  const [methodFilter, setMethodFilter] = useState<string[]>([])
  const [statusClassFilter, setStatusClassFilter] = useState<string[]>([])

  // Apply method/statusClass filters in a second pass (they're cheap relative to buffer filter).
  const displayedLogs = useMemo(() => {
    if (methodFilter.length === 0 && statusClassFilter.length === 0) return filteredLogs
    return filteredLogs.filter(entry => {
      if (methodFilter.length > 0) {
        const m = extractMethod(entry.raw)
        if (!m || !methodFilter.includes(m)) return false
      }
      if (statusClassFilter.length > 0) {
        const sc = extractStatusClass(entry.raw)
        if (!sc || !statusClassFilter.includes(sc)) return false
      }
      return true
    })
  }, [filteredLogs, methodFilter, statusClassFilter])

  // Keep expanded row valid
  useEffect(() => {
    if (expandedId && !displayedLogs.some(e => e.id === expandedId)) setExpandedId(null)
  }, [displayedLogs, expandedId])

  // --- Virtualizer: fixed-height rows for robustness under high log churn ---
  const rowVirtualizer = useVirtualizer({
    count: displayedLogs.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: (index) => {
      const entry = displayedLogs[index]
      return entry && entry.id === expandedId ? EXPANDED_ROW_HEIGHT : COLLAPSED_ROW_HEIGHT
    },
    overscan: 20,
    getItemKey: (index) => displayedLogs[index]?.id ?? index,
  })

  // Force the virtualizer to re-read its estimate only when the expanded row
  // changes. Fixed-height rows don't need remeasure on every log append —
  // doing so caused layout thrash and visible row overlap under high churn.
  useEffect(() => {
    rowVirtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId])

  // Auto-scroll on new logs when in Live mode. Use scrollTop on the parent;
  // it's immune to the virtualizer's internal bookkeeping being mid-update.
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollParentRef.current
    if (!el) return
    // Schedule after paint so the virtualizer has laid out the new rows.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [displayedLogs.length, autoScroll])

  const handleScroll = useCallback(() => {
    const el = scrollParentRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    if (atBottom && !autoScroll) setAutoScroll(true)
    else if (!atBottom && autoScroll) setAutoScroll(false)
  }, [autoScroll, setAutoScroll])

  // --- Filter setters ---
  const setSources = useCallback((next: string[]) => setFilter({ sources: next }), [setFilter])
  const setLevels = useCallback((next: string[]) => setFilter({ levels: next as LogLevel[] }), [setFilter])
  const setTimeRange = useCallback((r: [number, number] | null) => setFilter({ timeRange: r }), [setFilter])

  // --- Downloads ---
  const handleDownloadLog = useCallback(() => {
    downloadTextFile('logs.log', displayedLogs.map(e => e.raw).join('\n'), 'text/plain')
  }, [displayedLogs])

  const handleDownloadJsonl = useCallback(() => {
    downloadTextFile('logs.jsonl', displayedLogs.map(e => JSON.stringify(e)).join('\n'), 'application/jsonl')
  }, [displayedLogs])

  // --- Manual forward (on-demand) ---
  const handleForward = useCallback(async (dest: DestinationConfig) => {
    if (displayedLogs.length === 0) {
      setDestStatus(dest.id, 'error', 'Nothing to forward')
      return
    }
    const count = displayedLogs.length
    setDestStatus(dest.id, 'sending')
    try {
      if (dest.type === 'cribl-hec') {
        await forwardToHec(displayedLogs, dest as CriblHecDestination)
      }
      recordSent(dest.id, count)
      setRecentSent(prev => ({ ...prev, [dest.id]: count }))
      setTimeout(() => {
        setRecentSent(prev => {
          const { [dest.id]: _, ...rest } = prev
          return rest
        })
      }, 3000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setDestStatus(dest.id, 'error', msg)
    }
  }, [displayedLogs, setDestStatus, recordSent])

  // --- Facet options ---
  const sourcePrefix = useMemo(() => commonDottedPrefix(allSources), [allSources])

  const sourceFacetOptions = useMemo(() => {
    return allSources.map(channel => {
      const stripped = sourcePrefix ? channel.slice(sourcePrefix.length) : channel
      return {
        value: channel,
        label: stripped || channel,
        count: facets.source[channel] ?? 0,
        title: channel,
      }
    })
  }, [allSources, sourcePrefix, facets])

  const methodOptions = useMemo(() => {
    const keys = Object.keys(facets.method).sort()
    return keys.map(k => ({ value: k, label: k, count: facets.method[k] }))
  }, [facets.method])

  const statusClassOptions = useMemo(() => {
    const keys = Object.keys(facets.statusClass).sort()
    return keys.map(k => ({ value: k, label: k, count: facets.statusClass[k] }))
  }, [facets.statusClass])

  const levelOptions = useMemo(() =>
    ALL_LEVELS.map(l => ({
      value: l,
      label: l,
      count: facets.level[l],
      dotClassName: LEVEL_DOT[l],
    })),
    [facets.level]
  )

  const items = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()

  const infoCount = facets.level.INFO + facets.level.DEBUG
  const warnCount = facets.level.WARN
  const errorCount = facets.level.ERROR + facets.level.FATAL
  const totalCount = logBuffer.length

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-200 bg-white">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-3.5 py-3">
          {canvasOpen && (
            <button
              title="Collapse canvas"
              onClick={() => setCanvasOpen(false)}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
          <span className={cn('ls-dot', autoScroll ? 'ls-dot-live' : 'ls-dot-muted')} />
          <span className="text-[12px] font-semibold text-slate-900">Live logs</span>
          <span className="rounded-[3px] bg-slate-100 px-1.5 py-px font-mono text-[10.5px] font-medium text-slate-500">
            {totalCount}
          </span>

          {/* Count pills */}
          <div className="ml-1 flex shrink-0 items-center gap-1">
            <span className="rounded-[3px] border border-slate-200 bg-slate-100 px-1.5 py-px font-mono text-[10px] font-semibold text-slate-500">
              {infoCount}
            </span>
            <span className="rounded-[3px] border border-amber-200 bg-amber-50 px-1.5 py-px font-mono text-[10px] font-semibold text-amber-700">
              {warnCount}
            </span>
            <span className="rounded-[3px] border border-red-200 bg-red-50 px-1.5 py-px font-mono text-[10px] font-semibold text-red-600">
              {errorCount}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? 'Following tail — click to pause' : 'Paused — click to follow tail'}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded border px-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.04em] transition-colors',
                autoScroll
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-slate-200 bg-slate-100 text-slate-500 hover:text-slate-900',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', autoScroll ? 'bg-green-500' : 'bg-slate-300')} />
              Follow
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title="Download logs"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-gray-500">Export visible</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleDownloadLog} className="text-xs">
                  <span className="font-mono text-[11px] text-gray-400">.log</span>
                  <span className="ml-2">Plain text</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleDownloadJsonl} className="text-xs">
                  <span className="font-mono text-[11px] text-gray-400">.jsonl</span>
                  <span className="ml-2">JSON lines</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              title="Clear logs"
              onClick={clearLogs}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>

            <div className="mx-1 h-5 w-px bg-gray-200" aria-hidden />

            <button
              title="Collapse panel"
              onClick={onCollapse}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Filter + action cluster —
            narrow panel: stacked column; wide panel: single inline row so it doesn't sprawl */}
        <div className={cn('mt-2 flex gap-1.5', isWide ? 'flex-row flex-wrap items-center' : 'flex-col')}>
          <div className={cn('grid grid-cols-2 gap-1.5', isWide && 'contents')}>
            <MultiSelectMenu
              label="Sources"
              options={sourceFacetOptions}
              selected={filter.sources}
              onChange={setSources}
              triggerClassName={isWide ? 'w-44' : undefined}
              headerHint={sourcePrefix ? `${sourcePrefix}…` : undefined}
              renderTriggerText={(sel, opts) =>
                sel.length === 0
                  ? 'All sources'
                  : sel.length === 1
                    ? (opts.find(o => o.value === sel[0])?.label ?? sel[0]) as React.ReactNode
                    : `${sel.length} sources`
              }
            />
            <MultiSelectMenu
              label="Levels"
              options={levelOptions}
              selected={filter.levels}
              onChange={setLevels}
              triggerClassName={isWide ? 'w-32' : undefined}
              renderTriggerText={(sel) =>
                sel.length === ALL_LEVELS.length
                  ? 'All levels'
                  : sel.length === 0
                    ? 'No levels'
                    : sel.map(l => l.slice(0, 1)).join(' · ')
              }
            />
          </div>

          {(methodOptions.length > 0 || statusClassOptions.length > 0) && (
            <div className={cn('grid grid-cols-2 gap-1.5', isWide && 'contents')}>
              {methodOptions.length > 0 && (
                <MultiSelectMenu
                  label="Methods"
                  options={methodOptions}
                  selected={methodFilter}
                  onChange={setMethodFilter}
                  triggerClassName={isWide ? 'w-32' : undefined}
                  renderTriggerText={(sel) =>
                    sel.length === 0 ? 'Any method' : sel.length === 1 ? sel[0] : `${sel.length} methods`
                  }
                />
              )}
              {statusClassOptions.length > 0 && (
                <MultiSelectMenu
                  label="Status"
                  options={statusClassOptions}
                  selected={statusClassFilter}
                  onChange={setStatusClassFilter}
                  triggerClassName={isWide ? 'w-32' : undefined}
                  renderTriggerText={(sel) =>
                    sel.length === 0 ? 'Any status' : sel.length === 1 ? sel[0] : `${sel.length} statuses`
                  }
                />
              )}
            </div>
          )}

          <Input
            value={filter.keyword}
            onChange={e => setFilter({ keyword: e.target.value })}
            placeholder="Search logs…"
            className={cn('h-7 text-xs', isWide ? 'flex-1 min-w-[180px] max-w-md' : 'w-full')}
          />

          {/* Primary action: forward */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className={cn(
                  'gap-1.5 bg-blue-600 text-xs font-medium text-white shadow-sm hover:bg-blue-700',
                  isWide ? 'h-7 w-auto px-3' : 'mt-0.5 h-8 w-full',
                )}
                title={destinations.length === 0 ? 'No destinations configured' : 'Forward visible logs'}
              >
                <Send className="h-3.5 w-3.5" />
                Forward {displayedLogs.length} log{displayedLogs.length === 1 ? '' : 's'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-gray-500">
                Forward {displayedLogs.length} logs to
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {destinations.length === 0 && (
                <div className="px-2 py-3 text-[11px] text-gray-400">
                  No destinations configured.
                  <br />
                  Add one in Settings.
                </div>
              )}
              {destinations.map(dest => {
                const status = destStatuses[dest.id] ?? 'idle'
                const error = destErrors[dest.id]
                const sentCount = recentSent[dest.id]
                const isSending = status === 'sending'
                const hasError = status === 'error' && !!error
                const hasJustSent = sentCount !== undefined
                return (
                  <DropdownMenuItem
                    key={dest.id}
                    onSelect={(e) => {
                      e.preventDefault()
                      if (!isSending) handleForward(dest)
                    }}
                    className="flex-col items-start gap-0.5 text-xs"
                    disabled={isSending}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate">{dest.name || dest.type}</span>
                      <span className="shrink-0 text-[10px] uppercase text-gray-400">{dest.type}</span>
                    </span>
                    {isSending && (
                      <span className="flex items-center gap-1 text-[10px] text-blue-600">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Sending {displayedLogs.length}…
                      </span>
                    )}
                    {!isSending && hasJustSent && (
                      <span className="flex items-center gap-1 text-[10px] text-green-600">
                        <Check className="h-3 w-3" />
                        Sent {sentCount}
                      </span>
                    )}
                    {!isSending && !hasJustSent && hasError && (
                      <span className="flex items-start gap-1 text-[10px] text-red-600">
                        <AlertCircle className="mt-[1px] h-3 w-3 shrink-0" />
                        <span className="break-words">{error}</span>
                      </span>
                    )}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Histogram ────────────────────────────────────────── */}
      <LogHistogram
        logs={filteredLogs}
        selectedRange={filter.timeRange}
        onSelectRange={setTimeRange}
      />

      {/* ── Virtualized log list ─────────────────────────────── */}
      <div
        ref={scrollParentRef}
        className="flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={handleScroll}
      >
        {displayedLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-gray-400">
            {logBuffer.length === 0
              ? 'No logs yet. Run the simulation or step a tick to start collecting them.'
              : 'No logs match the current filters.'}
          </div>
        ) : (
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {items.map(virtualRow => {
              const entry = displayedLogs[virtualRow.index]
              if (!entry) return null
              return (
                <div
                  key={`${virtualRow.key}-${virtualRow.index}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                    contain: 'strict',
                  }}
                >
                  <LogRow
                    entry={entry}
                    keyword={filter.keyword}
                    expanded={expandedId === entry.id}
                    onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

    </div>
  )
}
