'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, Trash2, ChevronUp, GripVertical } from 'lucide-react'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { BEHAVIOR_STATES, fmtTime, makeBlock } from '@/lib/episodeBehavior'
import type { BehaviorBlock, BehaviorState, NarrativeBeat } from '@/types/episode'
import { generateId } from '@/lib/id'
import { startPointerDrag } from '@/lib/pointerDrag'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const LANE_HEIGHT = 44
const LABEL_COL_DESKTOP = 160
const LABEL_COL_MOBILE = 108
const COMMENTS_TRACK_H = 32
const RULER_H = 22
const SCRUBBER_H = 22

const ZOOM_MIN = 0.2
const ZOOM_MAX = 4

interface ServiceRow {
  id: string
  label: string
  emoji: string
  kind: string
}

function useServices(): ServiceRow[] {
  const nodes = useScenarioStore(s => s.nodes)
  return useMemo(() => {
    return nodes
      .filter(n => n.data.type === 'service')
      .map(n => ({
        id: n.id,
        label: (n.data.label as string) || (n.data.id as string),
        emoji: ((n.data.appearance as Record<string, unknown> | undefined)?.emoji as string) || '◫',
        kind: (n.data.serviceType as string) || 'custom',
      }))
  }, [nodes])
}

// ---------- Ruler ----------
function Ruler({ totalTicks, pxPerTick, onSeek }: {
  totalTicks: number
  pxPerTick: number
  onSeek: (t: number) => void
}) {
  const widthPx = totalTicks * pxPerTick
  const stepTicks = pxPerTick > 1.2 ? 30 : pxPerTick > 0.6 ? 60 : 120
  const ticks: number[] = []
  for (let t = 0; t <= totalTicks; t += stepTicks) ticks.push(t)
  const seekFromClientX = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left
    onSeek(Math.max(0, Math.min(totalTicks, x / pxPerTick)))
  }
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    seekFromClientX(e.clientX, rect)
    startPointerDrag(e, {
      onMove: ({ event: ev }) => seekFromClientX(ev.clientX, rect),
    })
  }
  return (
    <div
      className="relative cursor-pointer touch-none border-b border-slate-200 bg-slate-100/80 font-mono text-[10px] text-slate-500"
      style={{ width: widthPx, height: RULER_H }}
      onPointerDown={onPointerDown}
    >
      {ticks.map(t => (
        <div
          key={t}
          className="absolute top-0 bottom-0 flex items-center border-l border-slate-300 pl-1 text-slate-600"
          style={{ left: t * pxPerTick }}
        >
          {fmtTime(t)}
        </div>
      ))}
    </div>
  )
}

// ---------- Comment edit modal ----------
type CommentEditState =
  | { mode: 'add'; tick: number }
  | { mode: 'edit'; beat: NarrativeBeat }

function CommentEditDialog({
  state, duration, onClose, onSave, onDelete,
}: {
  state: CommentEditState | null
  duration: number
  onClose: () => void
  onSave: (b: NarrativeBeat) => void
  onDelete: (id: string) => void
}) {
  const [text, setText] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!state) return
    if (state.mode === 'edit') {
      setText(state.beat.text)
      setTick(state.beat.tick)
    } else {
      setText('')
      setTick(state.tick)
    }
  }, [state])

  const open = state !== null
  const isEdit = state?.mode === 'edit'

  const save = () => {
    if (!state) return
    const trimmed = text.trim()
    if (!trimmed) return
    const clampedTick = Math.max(0, Math.min(duration, Math.round(tick)))
    if (state.mode === 'edit') {
      onSave({ ...state.beat, tick: clampedTick, text: trimmed })
    } else {
      onSave({ id: generateId(), tick: clampedTick, text: trimmed })
    }
    onClose()
  }

  const remove = () => {
    if (state?.mode === 'edit') {
      onDelete(state.beat.id)
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm gap-3 p-4 sm:p-5">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-sm font-semibold">
            {isEdit ? 'Edit comment' : 'Add comment'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
              Time
            </span>
            <div className="flex items-center gap-2">
              <span className="rounded bg-indigo-100 px-2 py-1 font-mono text-[11px] font-semibold text-indigo-700">
                {fmtTime(Math.max(0, Math.min(duration, Math.round(tick))))}
              </span>
              <input
                type="number"
                min={0}
                max={duration}
                step={1}
                value={tick}
                onChange={e => setTick(Number(e.target.value))}
                className="w-24 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-700 outline-none focus:border-indigo-400"
              />
              <span className="font-mono text-[10.5px] text-slate-400">s</span>
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
              Comment
            </span>
            <Textarea
              autoFocus
              rows={3}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
                if (e.key === 'Escape') { e.preventDefault(); onClose() }
              }}
              placeholder="What's happening at this moment?"
              className="min-h-[72px] resize-none text-[12px]"
            />
          </label>
        </div>
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <div>
            {isEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={remove}
                className="h-8 gap-1 px-2 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} className="h-8">
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={!text.trim()} className="h-8">
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Comments track ----------
function CommentsTrack({ widthPx, pxPerTick, beats, duration, onAdd, onEdit }: {
  widthPx: number
  pxPerTick: number
  beats: NarrativeBeat[]
  duration: number
  onAdd: (tick: number) => void
  onEdit: (beat: NarrativeBeat) => void
}) {
  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-comment-marker]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const tick = Math.max(0, Math.min(duration, Math.round(x / pxPerTick)))
    onAdd(tick)
  }

  return (
    <div
      className="relative cursor-crosshair border-b border-slate-200 bg-gradient-to-b from-slate-50 to-slate-100/50 hover:bg-indigo-50/30"
      style={{ width: widthPx, height: COMMENTS_TRACK_H }}
      onClick={onTrackClick}
    >
      {beats.map((m, i) => (
        <div
          key={m.id}
          data-comment-marker
          className="group pointer-events-none absolute top-0 bottom-0 flex -translate-x-1/2 flex-col items-center"
          style={{ left: m.tick * pxPerTick, zIndex: 10 + i }}
        >
          <button
            onClick={e => { e.stopPropagation(); onEdit(m) }}
            title={`${m.text} @ ${fmtTime(m.tick)} — click to edit`}
            className="pointer-events-auto mt-1.5 inline-flex h-5 items-center gap-1 rounded-full border border-indigo-300 bg-white/95 px-1.5 font-mono text-[10px] font-semibold text-indigo-700 shadow-sm transition-colors hover:border-indigo-500 hover:bg-indigo-50 hover:shadow group-hover:z-50"
          >
            <span className="size-1.5 rounded-full bg-indigo-500" />
            {fmtTime(m.tick)}
          </button>
          <div className="pointer-events-none absolute left-1/2 top-7 z-50 hidden -translate-x-1/2 group-hover:block">
            <div className="flex max-w-[260px] items-center gap-2 whitespace-nowrap rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 shadow-[0_8px_24px_-12px_rgba(15,23,42,0.4)]">
              <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-700">
                {fmtTime(m.tick)}
              </span>
              <span className="overflow-hidden text-ellipsis text-[11px] font-medium text-indigo-900">
                {m.text}
              </span>
            </div>
          </div>
        </div>
      ))}
      {beats.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10.5px] italic text-slate-400">
          Click to drop a comment
        </div>
      )}
    </div>
  )
}

// ---------- Comment guides overlay (dashed verticals over all lanes) ----------
function CommentGuides({ beats, pxPerTick, height, widthPx }: {
  beats: NarrativeBeat[]
  pxPerTick: number
  height: number
  widthPx: number
}) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-0" style={{ width: widthPx, height }}>
      {beats.map(b => (
        <div
          key={b.id}
          className="absolute top-0 bottom-0 border-l border-dashed border-indigo-300/60"
          style={{ left: b.tick * pxPerTick }}
        />
      ))}
    </div>
  )
}

// ---------- Behavior block ----------
function BehaviorBlockView({
  block, pxPerTick, selected, episodeDuration, onSelect, onMove, onResize,
}: {
  block: BehaviorBlock
  pxPerTick: number
  selected: boolean
  episodeDuration: number
  onSelect: () => void
  onMove: (newStart: number) => void
  onResize: (patch: { start: number; duration: number }) => void
}) {
  const meta = BEHAVIOR_STATES[block.state]
  const left = block.start * pxPerTick
  const width = Math.max(8, block.duration * pxPerTick)
  const showLabel = width > 60
  const showMeta = width > 120

  const onBodyPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-resize-handle]')) return
    e.stopPropagation()
    onSelect()
    const startVal = block.start
    startPointerDrag(e, {
      onMove: ({ dx }) => {
        const newStart = Math.max(0, Math.min(episodeDuration - block.duration, Math.round(startVal + dx / pxPerTick)))
        onMove(newStart)
      },
    })
  }

  const onResizePointerDown = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const startStart = block.start
    const startDur = block.duration
    startPointerDrag(e, {
      onMove: ({ dx }) => {
        const ticks = dx / pxPerTick
        if (side === 'right') {
          const newDur = Math.max(5, Math.round(startDur + ticks))
          onResize({ start: startStart, duration: Math.min(newDur, episodeDuration - startStart) })
        } else {
          const newStart = Math.max(0, Math.min(startStart + startDur - 5, Math.round(startStart + ticks)))
          const newDur = startDur + (startStart - newStart)
          onResize({ start: newStart, duration: newDur })
        }
      },
    })
  }

  return (
    <div
      data-block
      onPointerDown={onBodyPointerDown}
      title={`${meta.label} • ${block.duration}t • err ${(block.errorRate * 100).toFixed(1)}% • lat ${block.latencyMul}× • log ${block.logVolMul}×`}
      className={cn(
        'absolute top-1.5 bottom-1.5 cursor-grab touch-none overflow-hidden rounded-md border text-[11px] shadow-sm transition-shadow active:cursor-grabbing',
        selected ? 'shadow-md ring-2 ring-blue-500/40' : 'hover:shadow-md',
      )}
      style={{
        left, width,
        background: meta.bg,
        borderColor: meta.color,
        color: meta.text,
      }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: meta.color }} />
      {showLabel && (
        <div className="flex h-full items-center gap-1.5 pl-2.5 pr-2">
          <span className="text-[12px] leading-none" style={{ color: meta.color }}>{meta.glyph}</span>
          <span className="truncate font-medium">{meta.label}</span>
          {showMeta && block.errorRate > 0.01 && (
            <span className="ml-auto font-mono text-[10px] opacity-75">{(block.errorRate * 100).toFixed(0)}%</span>
          )}
        </div>
      )}
      <div
        data-resize-handle
        onPointerDown={onResizePointerDown('left')}
        className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize touch-none hover:bg-black/10 sm:w-1.5"
      />
      <div
        data-resize-handle
        onPointerDown={onResizePointerDown('right')}
        className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize touch-none hover:bg-black/10 sm:w-1.5"
      />
    </div>
  )
}

// ---------- Service swim lane ----------
function ServiceLane({
  service, blocks, pxPerTick, episodeDuration, selectedBlockId, widthPx, hovered, active,
  onSelectBlock, onMoveBlock, onResizeBlock, onAddBlock, onHoverChange,
}: {
  service: ServiceRow
  blocks: BehaviorBlock[]
  pxPerTick: number
  episodeDuration: number
  selectedBlockId: string | null
  widthPx: number
  hovered: boolean
  active: boolean
  onSelectBlock: (id: string) => void
  onMoveBlock: (id: string, newStart: number) => void
  onResizeBlock: (id: string, patch: { start: number; duration: number }) => void
  onAddBlock: (tick: number) => void
  onHoverChange: (hovered: boolean) => void
}) {
  const onLaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-block]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const tick = Math.max(0, Math.min(episodeDuration - 30, Math.round(x / pxPerTick)))
    onAddBlock(tick)
  }
  return (
    <div
      className={cn(
        'relative border-b border-slate-100 transition-colors',
        active ? 'bg-blue-50/70 ring-1 ring-inset ring-blue-200' : hovered ? 'bg-blue-50/50' : 'hover:bg-slate-50/40',
      )}
      style={{ width: widthPx, height: LANE_HEIGHT }}
      onClick={onLaneClick}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      {/* baseline healthy stripe */}
      <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-emerald-100" />
      {blocks.map(b => (
        <BehaviorBlockView
          key={b.id}
          block={b}
          pxPerTick={pxPerTick}
          selected={selectedBlockId === b.id}
          episodeDuration={episodeDuration}
          onSelect={() => onSelectBlock(b.id)}
          onMove={(newStart) => onMoveBlock(b.id, newStart)}
          onResize={(patch) => onResizeBlock(b.id, patch)}
        />
      ))}
    </div>
  )
}

// ---------- Playhead vertical line (spans all lanes) ----------
function PlayheadLine({ tick, pxPerTick, height }: {
  tick: number
  pxPerTick: number
  height: number
}) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-20"
      style={{ left: tick * pxPerTick, height }}
    >
      <div className="absolute left-0 top-0 -ml-px h-full w-0.5 bg-blue-500" />
    </div>
  )
}

// ---------- Dedicated scrubber swimlane (handle lives here) ----------
function ScrubberLane({ tick, pxPerTick, widthPx, duration, onScrub }: {
  tick: number
  pxPerTick: number
  widthPx: number
  duration: number
  onScrub: (t: number) => void
}) {
  const seekFromClientX = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left
    onScrub(Math.max(0, Math.min(duration, x / pxPerTick)))
  }
  const onLanePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-scrubber-handle]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    seekFromClientX(e.clientX, rect)
    startPointerDrag(e, {
      onMove: ({ event: ev }) => seekFromClientX(ev.clientX, rect),
    })
  }
  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startTick = tick
    startPointerDrag(e, {
      onMove: ({ dx }) => onScrub(Math.max(0, Math.min(duration, startTick + dx / pxPerTick))),
    })
  }
  return (
    <div
      className="relative cursor-pointer touch-none border-b border-slate-200 bg-gradient-to-b from-blue-50/60 to-blue-100/40"
      style={{ width: widthPx, height: SCRUBBER_H }}
      onPointerDown={onLanePointerDown}
      title="Drag to scrub"
    >
      {/* Subtle baseline groove */}
      <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-blue-200/70" />
      {/* Handle */}
      <div
        data-scrubber-handle
        onPointerDown={onHandlePointerDown}
        className="absolute top-0 bottom-0 z-10 flex -translate-x-1/2 items-center"
        style={{ left: tick * pxPerTick }}
      >
        <div className="pointer-events-auto flex h-[18px] cursor-ew-resize items-center gap-0.5 rounded-md border border-blue-600 bg-blue-600 px-1 text-white shadow-sm transition-colors hover:bg-blue-700">
          <GripVertical className="size-3 opacity-90" />
          <span className="font-mono text-[10px] font-semibold tabular-nums">
            {fmtTime(Math.round(tick))}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------- Main ----------
export function EpisodeTimeline({ onCollapse }: { onCollapse?: () => void } = {}) {
  const episode = useEpisodeStore(s => s.episode)
  const tick = useEpisodeStore(s => s.tick)
  const selectedBlockId = useEpisodeStore(s => s.selectedBlockId)
  const setTick = useEpisodeStore(s => s.setTick)
  const setSelectedBlock = useEpisodeStore(s => s.setSelectedBlock)
  const addBlock = useEpisodeStore(s => s.addBlock)
  const updateBlock = useEpisodeStore(s => s.updateBlock)
  const upsertBeat = useEpisodeStore(s => s.upsertBeat)
  const deleteBeat = useEpisodeStore(s => s.deleteBeat)

  const services = useServices()
  const hoveredServiceId = useUIStore(s => s.hoveredServiceId)
  const setHoveredServiceId = useUIStore(s => s.setHoveredServiceId)
  const selectNode = useUIStore(s => s.selectNode)
  const selectedNodeId = useUIStore(s => s.selectedNodeId)
  const setLogPanelOpen = useUIStore(s => s.setLogPanelOpen)

  const [commentEdit, setCommentEdit] = useState<CommentEditState | null>(null)

  // The "active" service is the one whose details panel is currently open —
  // either because that lane (node) was clicked, or because a behavior block
  // on that lane is selected. We highlight the lane (and the canvas node)
  // persistently so the user keeps their visual anchor while editing.
  const activeServiceId = useMemo(() => {
    if (selectedBlockId) {
      for (const [sid, blocks] of Object.entries(episode.lanes)) {
        if (blocks.some(b => b.id === selectedBlockId)) return sid
      }
    }
    if (selectedNodeId && services.some(s => s.id === selectedNodeId)) return selectedNodeId
    return null
  }, [selectedBlockId, selectedNodeId, episode.lanes, services])
  const isMobile = useIsMobile()
  const labelCol = isMobile ? LABEL_COL_MOBILE : LABEL_COL_DESKTOP
  // Default to a slightly tighter zoom on mobile so a typical 20-minute episode
  // fits without endless horizontal scrolling.
  const [pxPerTick, setPxPerTick] = useState(0.85)
  const scrollRef = useRef<HTMLDivElement>(null)

  // When the breakpoint flips, ease the default zoom so the timeline stays
  // legible on both ends without touching the user's manually-set zoom.
  const userZoomedRef = useRef(false)
  useEffect(() => {
    if (userZoomedRef.current) return
    setPxPerTick(isMobile ? 0.55 : 0.85)
  }, [isMobile])

  const widthPx = episode.duration * pxPerTick
  const lanesHeight = services.length * LANE_HEIGHT

  const onAddBlock = useCallback((serviceId: string, startTick: number) => {
    // pick a default state cycling by what's already there
    const existing = episode.lanes[serviceId] ?? []
    const used = new Set(existing.map(b => b.state))
    const order: BehaviorState[] = ['degraded', 'down', 'under_attack', 'throttled', 'recovering', 'compromised', 'healthy']
    const state = order.find(s => !used.has(s)) ?? 'degraded'
    const dur = Math.min(60, episode.duration - startTick)
    if (dur < 5) return
    addBlock(serviceId, makeBlock(state, startTick, dur))
  }, [addBlock, episode.duration, episode.lanes])

  const zoomOut = () => { userZoomedRef.current = true; setPxPerTick(v => Math.max(ZOOM_MIN, v / 1.5)) }
  const zoomIn = () => { userZoomedRef.current = true; setPxPerTick(v => Math.min(ZOOM_MAX, v * 1.5)) }
  const zoomReset = () => { userZoomedRef.current = false; setPxPerTick(isMobile ? 0.55 : 0.85) }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-2 py-1.5 sm:gap-3 sm:px-4 sm:py-2">
        {onCollapse && (
          <button
            onClick={onCollapse}
            title="Collapse timeline"
            aria-label="Collapse timeline"
            className="-ml-1 inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <ChevronUp className="size-3.5" />
          </button>
        )}
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">Timeline</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-slate-400">
          {services.length} svc{services.length !== 1 ? 's' : ''} · {fmtTime(episode.duration)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center rounded-md border border-slate-200 bg-slate-50">
            <button
              onClick={zoomOut}
              className="inline-flex h-9 w-9 items-center justify-center text-slate-500 hover:text-slate-800 sm:h-7 sm:w-7"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <Minus className="size-4 sm:size-3" />
            </button>
            <button
              onClick={zoomReset}
              className="border-x border-slate-200 px-2 py-1 font-mono text-[11px] text-slate-700 sm:text-[10px]"
              title="Reset zoom"
            >
              {pxPerTick.toFixed(2)}×
            </button>
            <button
              onClick={zoomIn}
              className="inline-flex h-9 w-9 items-center justify-center text-slate-500 hover:text-slate-800 sm:h-7 sm:w-7"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Plus className="size-4 sm:size-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Single scroll container — vertical for many services, horizontal for long durations.
          Labels are sticky-left so they stay visible while panning right. */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative flex" style={{ width: labelCol + widthPx, minWidth: '100%' }}>
          {/* Sticky left labels column */}
          <div className="sticky left-0 z-20 shrink-0 border-r border-slate-200 bg-slate-50" style={{ width: labelCol }}>
            <div className="border-b border-slate-200 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500" style={{ height: COMMENTS_TRACK_H, lineHeight: `${COMMENTS_TRACK_H}px` }}>
              Comments
            </div>
            <div className="border-b border-slate-200 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500" style={{ height: RULER_H, lineHeight: `${RULER_H}px` }}>
              Time
            </div>
            <div className="flex items-center gap-1.5 border-b border-slate-200 px-3 text-[10px] font-semibold uppercase tracking-wider text-blue-600" style={{ height: SCRUBBER_H }}>
              <GripVertical className="size-3 text-blue-500" />
              Scrubber
            </div>
            {services.map(s => (
              <div
                key={s.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2 border-b border-slate-100 px-2 transition-colors sm:px-3',
                  activeServiceId === s.id
                    ? 'bg-blue-50/70 ring-1 ring-inset ring-blue-200'
                    : hoveredServiceId === s.id && 'bg-blue-50/50',
                )}
                style={{ height: LANE_HEIGHT }}
                title={`${s.label} (${s.kind}) — click to open details`}
                onMouseEnter={() => setHoveredServiceId(s.id)}
                onMouseLeave={() => setHoveredServiceId(null)}
                onClick={() => { selectNode(s.id); setLogPanelOpen(true) }}
              >
                <span className="text-base leading-none">{s.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-slate-800">{s.label}</div>
                  <div className="hidden truncate font-mono text-[9.5px] uppercase tracking-wider text-slate-400 sm:block">{s.kind}</div>
                </div>
              </div>
            ))}
            {services.length === 0 && (
              <div className="px-3 py-4 text-[11px] italic text-slate-400">
                Drag a service from the palette to populate lanes here.
              </div>
            )}
          </div>

          {/* Right timeline content — natural width = widthPx */}
          <div className="relative" style={{ width: widthPx }}>
            <CommentsTrack
              widthPx={widthPx}
              pxPerTick={pxPerTick}
              beats={episode.narrative}
              duration={episode.duration}
              onAdd={(t) => setCommentEdit({ mode: 'add', tick: t })}
              onEdit={(b) => setCommentEdit({ mode: 'edit', beat: b })}
            />
            <Ruler
              totalTicks={episode.duration}
              pxPerTick={pxPerTick}
              onSeek={setTick}
            />
            <ScrubberLane
              tick={tick}
              pxPerTick={pxPerTick}
              widthPx={widthPx}
              duration={episode.duration}
              onScrub={setTick}
            />
            <div className="relative" style={{ width: widthPx }}>
              <CommentGuides
                beats={episode.narrative}
                pxPerTick={pxPerTick}
                height={lanesHeight}
                widthPx={widthPx}
              />
              {services.map(s => (
                <ServiceLane
                  key={s.id}
                  service={s}
                  blocks={episode.lanes[s.id] ?? []}
                  pxPerTick={pxPerTick}
                  episodeDuration={episode.duration}
                  selectedBlockId={selectedBlockId}
                  widthPx={widthPx}
                  hovered={hoveredServiceId === s.id}
                  active={activeServiceId === s.id}
                  onSelectBlock={setSelectedBlock}
                  onMoveBlock={(id, start) => updateBlock(id, { start })}
                  onResizeBlock={(id, patch) => updateBlock(id, patch)}
                  onAddBlock={(t) => onAddBlock(s.id, t)}
                  onHoverChange={(h) => setHoveredServiceId(h ? s.id : null)}
                />
              ))}
            </div>
            <PlayheadLine
              tick={tick}
              pxPerTick={pxPerTick}
              height={COMMENTS_TRACK_H + RULER_H + SCRUBBER_H + lanesHeight}
            />
          </div>
        </div>
      </div>

      <CommentEditDialog
        state={commentEdit}
        duration={episode.duration}
        onClose={() => setCommentEdit(null)}
        onSave={upsertBeat}
        onDelete={deleteBeat}
      />
    </div>
  )
}
