'use client'
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { forwardToHec } from '@/lib/criblForwarder'
import type { CriblHecDestination, DestinationConfig } from '@/types/destinations'
import type { LogEntry, LogLevel } from '@/types/logs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ChevronRight, Download, Send, Pause, Play, Trash2 } from 'lucide-react'
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
  const accumulateMode = useSimulationStore(s => s.accumulateMode)
  const setFilter = useSimulationStore(s => s.setFilter)
  const setAutoScroll = useSimulationStore(s => s.setAutoScroll)
  const setAccumulateMode = useSimulationStore(s => s.setAccumulateMode)
  const clearLogs = useSimulationStore(s => s.clearLogs)
  const destinations = useDestinationsStore(s => s.destinations)
  const setDestStatus = useDestinationsStore(s => s.setStatus)
  const recordSent = useDestinationsStore(s => s.recordSent)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const deferredKeyword = useDeferredValue(filter.keyword)
  const [forwardingDestId, setForwardingDestId] = useState<string | null>(null)
  const [forwardToast, setForwardToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  // Auto-dismiss toast
  useEffect(() => {
    if (!forwardToast) return
    const t = setTimeout(() => setForwardToast(null), 3500)
    return () => clearTimeout(t)
  }, [forwardToast])

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

  // --- Manual forward (accumulate-then-forward) ---
  const enabledDests = destinations.filter(d => d.enabled)

  const handleForward = useCallback(async (dest: DestinationConfig) => {
    if (displayedLogs.length === 0) {
      setForwardToast({ kind: 'err', msg: 'Nothing to forward' })
      return
    }
    setForwardingDestId(dest.id)
    setDestStatus(dest.id, 'sending')
    try {
      if (dest.type === 'cribl-hec') {
        await forwardToHec(displayedLogs, dest as CriblHecDestination)
      }
      recordSent(dest.id, displayedLogs.length)
      setForwardToast({ kind: 'ok', msg: `Forwarded ${displayedLogs.length} logs → ${dest.name || dest.type}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setDestStatus(dest.id, 'error', msg)
      setForwardToast({ kind: 'err', msg })
    } finally {
      setForwardingDestId(null)
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

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-800">Logs</span>
          <Badge variant="outline" className="px-1.5 text-[9px]">
            {displayedLogs.length} / {logBuffer.length}
          </Badge>

          <div className="ml-auto flex items-center gap-1">
            {/* Download menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title="Download logs"
                  className="rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
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

            {/* Forward menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title={enabledDests.length === 0 ? 'No destinations configured' : 'Forward to destination'}
                  className={cn(
                    'rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900',
                    forwardingDestId && 'animate-pulse text-blue-600',
                  )}
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-gray-500">
                  Forward {displayedLogs.length} logs to
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {enabledDests.length === 0 && (
                  <div className="px-2 py-3 text-[11px] text-gray-400">
                    No enabled destinations.
                    <br />
                    Configure via the Destinations toolbar.
                  </div>
                )}
                {enabledDests.map(dest => (
                  <DropdownMenuItem
                    key={dest.id}
                    onSelect={() => handleForward(dest)}
                    className="text-xs"
                    disabled={forwardingDestId !== null}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate">{dest.name || dest.type}</span>
                      <span className="shrink-0 text-[10px] uppercase text-gray-400">{dest.type}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={accumulateMode}
                  onCheckedChange={setAccumulateMode}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  <span>Accumulate mode</span>
                </DropdownMenuCheckboxItem>
                <div className="px-2 pb-2 pt-1 text-[10px] leading-snug text-gray-400">
                  {accumulateMode
                    ? 'Auto-forward paused. Use this menu to send on demand.'
                    : 'Auto-forward is on. Toggle to hold logs here and send manually.'}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              title="Clear logs"
              onClick={clearLogs}
              className="rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>

            <button
              title="Collapse panel"
              onClick={onCollapse}
              className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Filter row */}
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <MultiSelectMenu
            label="Sources"
            options={sourceFacetOptions}
            selected={filter.sources}
            onChange={setSources}
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
            renderTriggerText={(sel) =>
              sel.length === ALL_LEVELS.length
                ? 'All levels'
                : sel.length === 0
                  ? 'No levels'
                  : sel.map(l => l.slice(0, 1)).join(' · ')
            }
          />
        </div>

        {/* Search + Live */}
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            value={filter.keyword}
            onChange={e => setFilter({ keyword: e.target.value })}
            placeholder="Search logs…"
            className="h-7 flex-1 min-w-0 text-xs"
          />
          <Button
            variant={autoScroll ? 'default' : 'outline'}
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-[10px]"
            onClick={() => setAutoScroll(!autoScroll)}
          >
            {autoScroll ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            Live
          </Button>
        </div>

        {/* Extra facets: only appear if the logs have them */}
        {(methodOptions.length > 0 || statusClassOptions.length > 0) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {methodOptions.length > 0 && (
              <MultiSelectMenu
                label="Methods"
                options={methodOptions}
                selected={methodFilter}
                onChange={setMethodFilter}
                triggerClassName="flex-1 min-w-0"
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
                triggerClassName="flex-1 min-w-0"
                renderTriggerText={(sel) =>
                  sel.length === 0 ? 'Any status' : sel.length === 1 ? sel[0] : `${sel.length} statuses`
                }
              />
            )}
          </div>
        )}
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

      {/* Toast */}
      {forwardToast && (
        <div
          className={cn(
            'absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md px-3 py-2 text-[11px] shadow-lg',
            forwardToast.kind === 'ok'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white',
          )}
        >
          {forwardToast.msg}
        </div>
      )}
    </div>
  )
}
