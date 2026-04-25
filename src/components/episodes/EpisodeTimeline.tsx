'use client'
import React from 'react'
import { GitFork, Trash2, Film, Plus, LayoutDashboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { cn } from '@/lib/utils'

// Track total width is proportional; individual blocks share the track space
// according to their tick share. Title row lives below, always fully readable.
const TRACK_MIN_WIDTH = 520
const TRACK_MAX_WIDTH = 1200
const TITLE_MIN_WIDTH = 120

export function EpisodeTimeline({ onOpenInCanvas }: { onOpenInCanvas?: (segmentId: string) => void }) {
  const {
    episode,
    selectedSegmentId,
    runningSegmentId,
    runProgressTicks,
    runStatus,
    selectSegment,
    setEditingSegment,
    forkSegment,
    addSegment,
    removeSegment,
  } = useEpisodeStore()

  const totalTicks = episode.segments.reduce((a, s) => a + s.ticks, 0) || 1
  const segCount = episode.segments.length

  // Track width grows with segment count but capped; tick ratio is what
  // determines block width, not an absolute tick→px mapping.
  const trackWidth = Math.min(
    TRACK_MAX_WIDTH,
    Math.max(TRACK_MIN_WIDTH, segCount * 220),
  )

  return (
    <div className="flex flex-col gap-2 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Film className="size-3.5 shrink-0 text-slate-500" />
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
          Episode Timeline
        </span>
        <span className="text-[10px] text-slate-400">
          {segCount} segment{segCount !== 1 ? 's' : ''} · {totalTicks} ticks (~{Math.round(totalTicks / 60)}m)
        </span>
        <div className="ml-auto shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => addSegment()}
            title="Append a blank segment"
          >
            <Plus className="size-3" /> Add Segment
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto pb-1">
        <div style={{ width: trackWidth }} className="flex flex-col gap-1.5">
          {/* Proportional track — blocks share width by tick ratio */}
          <div className="flex h-8 items-stretch gap-[2px] overflow-hidden rounded-md border border-slate-200 bg-slate-100/60">
            {episode.segments.map((segment) => {
              const widthPct = (segment.ticks / totalTicks) * 100
              const isSelected = selectedSegmentId === segment.id
              const isRunning = runningSegmentId === segment.id && runStatus === 'running'
              const progressPct = isRunning ? Math.min(100, (runProgressTicks / segment.ticks) * 100) : 0
              return (
                <button
                  key={segment.id}
                  type="button"
                  onClick={() => selectSegment(segment.id)}
                  onDoubleClick={() => setEditingSegment(segment.id)}
                  title={`${segment.name} · ${segment.ticks} ticks`}
                  style={{ width: `${widthPct}%` }}
                  className={cn(
                    'relative flex items-center justify-center overflow-hidden text-[10px] font-medium transition-colors',
                    isSelected
                      ? 'bg-blue-500 text-white shadow-inner'
                      : segment.parentId
                        ? 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                        : 'bg-slate-200 text-slate-700 hover:bg-slate-300',
                    isRunning && 'ring-2 ring-inset ring-emerald-400',
                  )}
                >
                  <span className="px-1 font-mono opacity-80">{segment.ticks}</span>
                  {isRunning && (
                    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-emerald-200/40">
                      <div
                        className="h-full bg-emerald-500 transition-[width] duration-150"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          {/* Title row — always readable, widths mirror track unless too small */}
          <div className="flex items-stretch gap-[2px]">
            {episode.segments.map((segment, idx) => {
              const widthPct = (segment.ticks / totalTicks) * 100
              const proportionalPx = (widthPct / 100) * trackWidth
              const effectiveWidth = Math.max(TITLE_MIN_WIDTH, proportionalPx)
              const isSelected = selectedSegmentId === segment.id
              return (
                <div
                  key={segment.id}
                  style={{ width: effectiveWidth, flex: `0 0 ${effectiveWidth}px` }}
                  className={cn(
                    'group relative cursor-pointer rounded-md border bg-white px-2.5 py-2 text-left transition-all',
                    isSelected
                      ? 'border-blue-500 ring-2 ring-blue-100'
                      : 'border-slate-200 hover:border-slate-300',
                  )}
                  onClick={() => selectSegment(segment.id)}
                  onDoubleClick={() => setEditingSegment(segment.id)}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-400">
                        <span>#{idx + 1}</span>
                        {segment.parentId && <span className="text-violet-500">· forked</span>}
                      </div>
                      <div className="mt-0.5 truncate text-xs font-semibold text-slate-800" title={segment.name}>
                        {segment.name}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500">
                        <span className="font-mono">{segment.ticks}t</span>
                        <span className="mx-1 text-slate-300">·</span>
                        <span>~{Math.round(segment.ticks / 60)}m</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {onOpenInCanvas && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenInCanvas(segment.id) }}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        title="Open in canvas"
                      >
                        <LayoutDashboard className="size-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); forkSegment(segment.id) }}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      title="Fork segment"
                    >
                      <GitFork className="size-3" />
                    </button>
                    {episode.segments.length > 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); removeSegment(segment.id) }}
                        className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500"
                        title="Remove segment"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
