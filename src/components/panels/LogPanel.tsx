'use client'
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { matchesChannel } from '@/engine/channels/ChannelMatcher'
import type { LogEntry, LogLevel } from '@/types/logs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'
import type { PanelMode } from '@/app/editor/page'

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: 'text-gray-400',
  INFO: 'text-blue-500',
  WARN: 'text-yellow-500',
  ERROR: 'text-red-500',
  FATAL: 'text-red-700 font-bold',
}

const LEVEL_BG: Record<LogLevel, string> = {
  DEBUG: '',
  INFO: '',
  WARN: 'bg-yellow-50',
  ERROR: 'bg-red-50',
  FATAL: 'bg-red-100',
}

const ALL_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']
const CUSTOM_CHANNEL_VALUE = '__custom__'
const MAX_RENDERED_LOGS = 500

function channelPresetValue(channel: string): string {
  return `${channel},${channel}.**`
}

function isPresetChannelValue(value: string, channels: string[]): boolean {
  return value === '*' || channels.some(channel => channelPresetValue(channel) === value)
}

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

function LogRow({
  entry,
  keyword,
  expanded,
  onClick,
}: {
  entry: LogEntry
  keyword: string
  expanded: boolean
  onClick: () => void
}) {
  const channelShort = entry.channel.split('.').slice(-2).join('.')

  return (
    <div
      className={cn(
        'cursor-pointer border-l-2 border-transparent px-2.5 py-1.5 hover:bg-gray-50',
        LEVEL_BG[entry.level],
        expanded && 'border-blue-400 bg-blue-50',
      )}
      onClick={onClick}
    >
      {/* Meta row: level + channel + timestamp */}
      <div className="flex items-center gap-1.5 font-mono text-[10px]">
        <span className={cn('shrink-0 font-bold', LEVEL_COLORS[entry.level])}>
          {entry.level.slice(0, 4)}
        </span>
        <span className="min-w-0 flex-1 truncate text-gray-400" title={entry.channel}>
          {channelShort}
        </span>
        <span className="shrink-0 text-[9px] text-gray-300">
          {entry.ts.slice(11, 23)}
        </span>
      </div>
      {/* Message row */}
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
}

export function LogPanel({
  onCollapse,
}: {
  panelMode: PanelMode
  onCollapse: () => void
  onSetWidth: (fraction: number) => void
}) {
  const { logBuffer, filter, autoScroll, setFilter, setAutoScroll, clearLogs } = useSimulationStore()
  const { nodes } = useScenarioStore()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [channelInput, setChannelInput] = useState(filter.channelGlob)
  const [channelPreset, setChannelPreset] = useState<string>(filter.channelGlob)
  const [renderWindowEnd, setRenderWindowEnd] = useState(MAX_RENDERED_LOGS)
  const scrollRef = useRef<HTMLDivElement>(null)
  const deferredKeyword = useDeferredValue(filter.keyword)
  const previousFilterKey = useRef('')

  const channels = useMemo(() =>
    [...new Set(nodes.map(n => n.data.channel).filter(Boolean))].sort(),
    [nodes]
  )

  useEffect(() => {
    setChannelInput(filter.channelGlob)
    setChannelPreset(isPresetChannelValue(filter.channelGlob, channels) ? filter.channelGlob : CUSTOM_CHANNEL_VALUE)
  }, [channels, filter.channelGlob])

  const filteredLogs = useMemo(() => {
    const normalizedKeyword = deferredKeyword.trim().toLowerCase()

    return logBuffer.filter(entry => {
      if (!matchesChannel(entry.channel, filter.channelGlob)) return false
      if (!filter.levels.includes(entry.level)) return false
      if (normalizedKeyword && !entry.raw.toLowerCase().includes(normalizedKeyword)) return false
      return true
    })
  }, [deferredKeyword, filter.channelGlob, filter.levels, logBuffer])

  const activeFilterKey = `${filter.channelGlob}__${filter.levels.join(',')}__${deferredKeyword.trim().toLowerCase()}`

  useEffect(() => {
    if (previousFilterKey.current !== activeFilterKey) {
      previousFilterKey.current = activeFilterKey
      setRenderWindowEnd(filteredLogs.length)
      return
    }

    if (autoScroll) {
      setRenderWindowEnd(filteredLogs.length)
      return
    }

    setRenderWindowEnd(prev => Math.min(prev, filteredLogs.length))
  }, [activeFilterKey, autoScroll, filteredLogs.length])

  useEffect(() => {
    setExpandedId(current => current && filteredLogs.some(entry => entry.id === current) ? current : null)
  }, [filteredLogs])

  const visibleStart = Math.max(0, renderWindowEnd - MAX_RENDERED_LOGS)
  const visibleLogs = useMemo(
    () => filteredLogs.slice(visibleStart, renderWindowEnd),
    [filteredLogs, renderWindowEnd, visibleStart]
  )
  const hiddenAboveCount = visibleStart
  const hiddenBelowCount = Math.max(0, filteredLogs.length - renderWindowEnd)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    if (atBottom && !autoScroll) {
      setRenderWindowEnd(filteredLogs.length)
      setAutoScroll(true)
    } else if (!atBottom && autoScroll) {
      setAutoScroll(false)
    }
  }, [autoScroll, filteredLogs.length, setAutoScroll])

  const applyChannel = useCallback((value: string) => {
    setChannelInput(value)
    setFilter({ channelGlob: value || '*' })
  }, [setFilter])

  const handlePresetChange = useCallback((value: string) => {
    setChannelPreset(value)
    if (value !== CUSTOM_CHANNEL_VALUE) applyChannel(value)
  }, [applyChannel])

  const handleLevelToggle = useCallback((level: LogLevel, checked: boolean) => {
    const levels = checked ? [...filter.levels, level] : filter.levels.filter(l => l !== level)
    setFilter({ levels })
  }, [filter.levels, setFilter])

  const handleScrollToBottom = useCallback(() => {
    setRenderWindowEnd(filteredLogs.length)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    setAutoScroll(true)
  }, [filteredLogs.length, setAutoScroll])

  const handleShowOlder = useCallback(() => {
    setAutoScroll(false)
    setRenderWindowEnd(prev => Math.max(MAX_RENDERED_LOGS, prev - MAX_RENDERED_LOGS))
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [setAutoScroll])

  const handleShowNewer = useCallback(() => {
    setRenderWindowEnd(prev => Math.min(filteredLogs.length, prev + MAX_RENDERED_LOGS))
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [filteredLogs.length])

  const handleDownloadVisibleText = useCallback(() => {
    downloadTextFile('visible-logs.log', filteredLogs.map(entry => entry.raw).join('\n'), 'text/plain')
  }, [filteredLogs])

  const handleDownloadVisibleJsonl = useCallback(() => {
    downloadTextFile('visible-logs.jsonl', filteredLogs.map(entry => JSON.stringify(entry)).join('\n'), 'application/jsonl')
  }, [filteredLogs])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-3 py-2">
        {/* Title row */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-800">Logs</span>
          <Badge variant="outline" className="px-1.5 text-[9px]">
            {filteredLogs.length} / {logBuffer.length}
          </Badge>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              title="Collapse panel"
              onClick={onCollapse}
              className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-2 space-y-1.5">
          {/* Source filter */}
          <div className="flex items-center gap-1.5">
            <Select value={channelPreset} onValueChange={handlePresetChange}>
              <SelectTrigger className="h-7 flex-1 min-w-0 text-xs">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="*" className="text-xs">All sources</SelectItem>
                {channels.map(channel => (
                  <SelectItem key={channel} value={channelPresetValue(channel)} className="text-xs">
                    {channel}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_CHANNEL_VALUE} className="text-xs">Custom pattern…</SelectItem>
              </SelectContent>
            </Select>
            {channelPreset === CUSTOM_CHANNEL_VALUE && (
              <Input
                value={channelInput}
                onChange={e => {
                  setChannelInput(e.target.value)
                  setChannelPreset(CUSTOM_CHANNEL_VALUE)
                }}
                onBlur={() => applyChannel(channelInput || '*')}
                onKeyDown={e => {
                  if (e.key === 'Enter') applyChannel(channelInput || '*')
                }}
                placeholder="glob pattern…"
                className="h-7 w-28 shrink-0 font-mono text-xs"
              />
            )}
          </div>

          {/* Search + auto-scroll */}
          <div className="flex items-center gap-1.5">
            <Input
              value={filter.keyword}
              onChange={e => setFilter({ keyword: e.target.value })}
              placeholder="Search logs…"
              className="h-7 flex-1 min-w-0 text-xs"
            />
            <Button
              variant={autoScroll ? 'default' : 'outline'}
              size="sm"
              className="h-7 shrink-0 px-2 text-[10px]"
              onClick={() => setAutoScroll(!autoScroll)}
            >
              Live
            </Button>
          </div>

          {/* Level toggles + actions */}
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-2">
              {ALL_LEVELS.map(level => (
                <label key={level} className="flex cursor-pointer items-center gap-0.5">
                  <Checkbox
                    checked={filter.levels.includes(level)}
                    onCheckedChange={checked => handleLevelToggle(level, !!checked)}
                    className="h-3 w-3"
                  />
                  <span className={cn('text-[10px] font-semibold', LEVEL_COLORS[level])}>{level.slice(0, 1)}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-6 px-1.5 text-[10px]" onClick={handleDownloadVisibleText}>
                .log
              </Button>
              <Button variant="outline" size="sm" className="h-6 px-1.5 text-[10px]" onClick={handleDownloadVisibleJsonl}>
                .jsonl
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={clearLogs}>
                Clear
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-x-hidden overflow-y-auto" onScroll={handleScroll}>
        {(hiddenAboveCount > 0 || hiddenBelowCount > 0) && (
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-gray-200 bg-white/95 px-3 py-2 backdrop-blur">
            <span className="text-[10px] text-gray-500">
              Showing {visibleLogs.length} of {filteredLogs.length} matching logs
            </span>
            <div className="flex items-center gap-1">
              {hiddenAboveCount > 0 && (
                <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={handleShowOlder}>
                  Older
                </Button>
              )}
              {hiddenBelowCount > 0 && (
                <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={handleShowNewer}>
                  Newer
                </Button>
              )}
            </div>
          </div>
        )}
        {filteredLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-gray-400">
            {logBuffer.length === 0
              ? 'No logs yet. Run the simulation or step a tick to start collecting them.'
              : 'No logs match the current filters.'}
          </div>
        ) : (
          visibleLogs.map(entry => (
            <LogRow
              key={entry.id}
              entry={entry}
              keyword={filter.keyword}
              expanded={expandedId === entry.id}
              onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
            />
          ))
        )}
      </div>

      {hiddenBelowCount > 0 && (
        <div className="absolute bottom-4 right-4">
          <Button size="sm" className="h-7 bg-blue-600 text-xs hover:bg-blue-700" onClick={handleScrollToBottom}>
            Show latest ({hiddenBelowCount})
          </Button>
        </div>
      )}
    </div>
  )
}
