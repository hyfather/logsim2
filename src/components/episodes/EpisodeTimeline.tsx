'use client'
import React from 'react'
import { GitFork, Trash2, ChevronLeft, ChevronRight, Film, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { cn } from '@/lib/utils'

const PX_PER_TICK = 0.25
const MIN_SEGMENT_WIDTH = 80
const MAX_SEGMENT_WIDTH = 320

export function EpisodeTimeline() {
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
    moveSegment,
  } = useEpisodeStore()

  const totalTicks = episode.segments.reduce((a, s) => a + s.ticks, 0)

  return (
    <div className="flex flex-col gap-2 border-b border-gray-200 bg-gradient-to-b from-slate-50 to-white px-4 py-3">
      <div className="flex items-center gap-2">
        <Film className="size-3.5 text-slate-500" />
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
          Episode Timeline
        </span>
        <span className="text-[10px] text-slate-400">
          {episode.segments.length} segment{episode.segments.length !== 1 ? 's' : ''} · {totalTicks} ticks (~{Math.round(totalTicks / 60)}m)
        </span>
        <div className="ml-auto">
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

      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {episode.segments.map((segment, idx) => {
          const width = Math.min(
            MAX_SEGMENT_WIDTH,
            Math.max(MIN_SEGMENT_WIDTH, segment.ticks * PX_PER_TICK * 4),
          )
          const isSelected = selectedSegmentId === segment.id
          const isRunning = runningSegmentId === segment.id && runStatus === 'running'
          const progressPct = isRunning ? Math.min(100, (runProgressTicks / segment.ticks) * 100) : 0
          return (
            <div
              key={segment.id}
              className={cn(
                'group relative flex shrink-0 cursor-pointer flex-col justify-between rounded-md border bg-white px-3 py-2 transition-all',
                isSelected
                  ? 'border-blue-500 shadow-sm ring-2 ring-blue-100'
                  : 'border-slate-200 hover:border-slate-300',
                isRunning && 'ring-2 ring-emerald-300 border-emerald-400',
              )}
              style={{ width }}
              onClick={() => selectSegment(segment.id)}
              onDoubleClick={() => setEditingSegment(segment.id)}
              title="Click to select · double-click to edit YAML"
            >
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-slate-800">{segment.name}</div>
                  {segment.parentId && (
                    <div className="text-[9px] text-slate-400">forked</div>
                  )}
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveSegment(segment.id, -1) }}
                    disabled={idx === 0}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                    title="Move left"
                  >
                    <ChevronLeft className="size-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); moveSegment(segment.id, 1) }}
                    disabled={idx === episode.segments.length - 1}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                    title="Move right"
                  >
                    <ChevronRight className="size-3" />
                  </button>
                </div>
              </div>

              <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                <span className="font-mono">{segment.ticks} ticks</span>
                <span className="text-slate-400">~{Math.round(segment.ticks / 60)}m</span>
              </div>

              {isRunning && (
                <div className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-md bg-emerald-100">
                  <div
                    className="h-full bg-emerald-500 transition-[width] duration-150"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              )}

              <div className="mt-2 flex items-center justify-between gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); forkSegment(segment.id) }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  title="Fork into a new segment (clones YAML, appended after this)"
                >
                  <GitFork className="size-2.5" /> Fork
                </button>
                {episode.segments.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeSegment(segment.id) }}
                    className="rounded p-0.5 text-slate-300 hover:bg-red-50 hover:text-red-500"
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
  )
}
