'use client'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { BEHAVIOR_STATES, fmtTime, makeBlock } from '@/lib/episodeBehavior'
import type { BehaviorBlock, BehaviorState, NarrativeBeat } from '@/types/episode'
import { generateId } from '@/lib/id'
import { cn } from '@/lib/utils'

const LANE_HEIGHT = 44
const LABEL_COL = 160
const NARR_TRACK_H = 56
const RULER_H = 22

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
  const handleClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    onSeek(Math.max(0, Math.min(totalTicks, x / pxPerTick)))
  }
  return (
    <div
      className="relative cursor-pointer border-b border-slate-200 bg-slate-100/80 font-mono text-[10px] text-slate-500"
      style={{ width: widthPx, height: RULER_H }}
      onClick={handleClick}
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

// ---------- Narrative track ----------
function NarrativeTrack({ widthPx, pxPerTick, beats, duration, onSeek, onUpsert, onDelete }: {
  widthPx: number
  pxPerTick: number
  beats: NarrativeBeat[]
  duration: number
  onSeek: (t: number) => void
  onUpsert: (b: NarrativeBeat) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [adding, setAdding] = useState<{ tick: number } | null>(null)

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-narr-marker]') || target.closest('input')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const tick = Math.max(0, Math.min(duration, Math.round(x / pxPerTick)))
    setAdding({ tick })
    setEditText('')
  }

  const commit = () => {
    if (adding) {
      if (editText.trim()) {
        onUpsert({ id: generateId(), tick: adding.tick, text: editText.trim() })
      }
      setAdding(null); setEditText('')
    } else if (editing) {
      const beat = beats.find(b => b.id === editing)
      if (beat && editText.trim()) onUpsert({ ...beat, text: editText.trim() })
      setEditing(null); setEditText('')
    }
  }

  return (
    <div
      className="relative cursor-crosshair border-b border-slate-200 bg-gradient-to-b from-slate-50 to-slate-100/50 hover:bg-indigo-50/30"
      style={{ width: widthPx, height: NARR_TRACK_H }}
      onClick={onTrackClick}
    >
      {beats.map(m => (
        <div
          key={m.id}
          data-narr-marker
          className="group absolute top-0 bottom-0 z-10 flex -translate-x-1/2 flex-col items-center"
          style={{ left: m.tick * pxPerTick }}
        >
          {editing === m.id ? (
            <input
              autoFocus
              className="mt-1.5 w-44 rounded-md border-[1.5px] border-indigo-500 bg-white px-2 py-0.5 text-[11px] shadow-[0_0_0_3px_rgba(99,102,241,0.15)] outline-none"
              value={editText}
              onChange={e => setEditText(e.target.value)}
              onBlur={commit}
              onKeyDown={e => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') { setEditing(null); setEditText('') }
              }}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <div
              onDoubleClick={e => { e.stopPropagation(); setEditing(m.id); setEditText(m.text) }}
              onClick={e => { e.stopPropagation(); onSeek(m.tick) }}
              title={`${m.text} @ ${fmtTime(m.tick)} — double-click to edit`}
              className="mt-1.5 max-w-[200px] cursor-pointer truncate rounded-md border border-indigo-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-indigo-700 shadow-sm hover:border-indigo-400 hover:bg-indigo-50"
            >
              {m.text}
            </div>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(m.id) }}
            className="absolute top-1 -right-5 hidden size-4 items-center justify-center rounded border border-slate-300 bg-white text-[11px] leading-none text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 group-hover:flex"
            title="Delete beat"
          >
            <X className="size-2.5" />
          </button>
          <div className="mt-1 font-mono text-[9.5px] text-slate-400">{fmtTime(m.tick)}</div>
        </div>
      ))}
      {adding && (
        <div
          className="absolute top-0 bottom-0 z-10 flex -translate-x-1/2 flex-col items-center"
          style={{ left: adding.tick * pxPerTick }}
        >
          <input
            autoFocus
            placeholder="Type a narrative beat…"
            className="mt-1.5 w-44 rounded-md border-[1.5px] border-emerald-500 bg-white px-2 py-0.5 text-[11px] shadow-[0_0_0_3px_rgba(34,197,94,0.15)] outline-none"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setAdding(null); setEditText('') }
            }}
            onClick={e => e.stopPropagation()}
          />
          <div className="mt-1 font-mono text-[9.5px] text-slate-400">{fmtTime(adding.tick)}</div>
        </div>
      )}
      {beats.length === 0 && !adding && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] italic text-slate-400">
          Click anywhere to drop a narrative beat (e.g. &ldquo;DDoS starts&rdquo;)
        </div>
      )}
    </div>
  )
}

// ---------- Narrative guides overlay (dashed verticals over all lanes) ----------
function NarrativeGuides({ beats, pxPerTick, height, widthPx }: {
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

  const onBodyMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-resize-handle]')) return
    e.stopPropagation()
    onSelect()
    const startX = e.clientX
    const startVal = block.start
    const onMoveEv = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / pxPerTick
      const newStart = Math.max(0, Math.min(episodeDuration - block.duration, Math.round(startVal + dx)))
      onMove(newStart)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMoveEv)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMoveEv)
    window.addEventListener('mouseup', onUp)
  }

  const onResizeMouseDown = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startStart = block.start
    const startDur = block.duration
    const onMoveEv = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / pxPerTick
      if (side === 'right') {
        const newDur = Math.max(5, Math.round(startDur + dx))
        onResize({ start: startStart, duration: Math.min(newDur, episodeDuration - startStart) })
      } else {
        const newStart = Math.max(0, Math.min(startStart + startDur - 5, Math.round(startStart + dx)))
        const newDur = startDur + (startStart - newStart)
        onResize({ start: newStart, duration: newDur })
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMoveEv)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMoveEv)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={onBodyMouseDown}
      title={`${meta.label} • ${block.duration}t • err ${(block.errorRate * 100).toFixed(1)}% • lat ${block.latencyMul}× • log ${block.logVolMul}×`}
      className={cn(
        'absolute top-1.5 bottom-1.5 cursor-grab overflow-hidden rounded-md border text-[11px] shadow-sm transition-shadow active:cursor-grabbing',
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
        onMouseDown={onResizeMouseDown('left')}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-black/10"
      />
      <div
        data-resize-handle
        onMouseDown={onResizeMouseDown('right')}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-black/10"
      />
    </div>
  )
}

// ---------- Service swim lane ----------
function ServiceLane({
  service, blocks, pxPerTick, episodeDuration, selectedBlockId, widthPx,
  onSelectBlock, onMoveBlock, onResizeBlock, onAddBlock,
}: {
  service: ServiceRow
  blocks: BehaviorBlock[]
  pxPerTick: number
  episodeDuration: number
  selectedBlockId: string | null
  widthPx: number
  onSelectBlock: (id: string) => void
  onMoveBlock: (id: string, newStart: number) => void
  onResizeBlock: (id: string, patch: { start: number; duration: number }) => void
  onAddBlock: (tick: number) => void
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
      className="relative border-b border-slate-100 hover:bg-slate-50/40"
      style={{ width: widthPx, height: LANE_HEIGHT }}
      onClick={onLaneClick}
    >
      {/* baseline healthy stripe */}
      <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-emerald-100" />
      {blocks.map(b => (
        <div key={b.id} data-block className="absolute inset-y-0" style={{ left: 0, right: 0 }}>
          <BehaviorBlockView
            block={b}
            pxPerTick={pxPerTick}
            selected={selectedBlockId === b.id}
            episodeDuration={episodeDuration}
            onSelect={() => onSelectBlock(b.id)}
            onMove={(newStart) => onMoveBlock(b.id, newStart)}
            onResize={(patch) => onResizeBlock(b.id, patch)}
          />
        </div>
      ))}
    </div>
  )
}

// ---------- Playhead ----------
function Playhead({ tick, pxPerTick, height, onScrub }: {
  tick: number
  pxPerTick: number
  height: number
  onScrub: (t: number) => void
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startTick = tick
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      onScrub(startTick + dx / pxPerTick)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  return (
    <div
      className="pointer-events-none absolute top-0 z-20"
      style={{ left: tick * pxPerTick, height }}
    >
      <div className="absolute left-1/2 -translate-x-1/2 -top-0 z-30 -mt-0.5 rounded bg-blue-600 px-1.5 py-0.5 font-mono text-[10px] text-white shadow">
        {fmtTime(Math.round(tick))}
      </div>
      <div className="absolute left-0 top-4 -ml-px h-[calc(100%-1rem)] w-0.5 bg-blue-500" />
      <div
        onMouseDown={onMouseDown}
        className="pointer-events-auto absolute left-0 top-0 -ml-2 size-4 cursor-ew-resize rounded-full border-2 border-blue-500 bg-white shadow"
      />
    </div>
  )
}

// ---------- Main ----------
export function EpisodeTimeline() {
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
  const [pxPerTick, setPxPerTick] = useState(0.85)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const zoomOut = () => setPxPerTick(v => Math.max(ZOOM_MIN, v / 1.5))
  const zoomIn = () => setPxPerTick(v => Math.min(ZOOM_MAX, v * 1.5))
  const zoomReset = () => setPxPerTick(0.85)

  return (
    <div className="flex min-h-0 flex-1 flex-col border-b border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">Timeline</span>
        <span className="font-mono text-[11px] text-slate-400">
          {services.length} service{services.length !== 1 ? 's' : ''} · {fmtTime(episode.duration)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center rounded border border-slate-200 bg-slate-50">
            <button onClick={zoomOut} className="px-2 py-1 font-mono text-[11px] text-slate-500 hover:text-slate-800" title="Zoom out">
              <Minus className="size-3" />
            </button>
            <button onClick={zoomReset} className="border-x border-slate-200 px-2 py-1 font-mono text-[10px] text-slate-700" title="Reset zoom">
              {pxPerTick.toFixed(2)}×
            </button>
            <button onClick={zoomIn} className="px-2 py-1 font-mono text-[11px] text-slate-500 hover:text-slate-800" title="Zoom in">
              <Plus className="size-3" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left sticky labels */}
        <div className="shrink-0 border-r border-slate-200 bg-slate-50" style={{ width: LABEL_COL }}>
          <div className="border-b border-slate-200 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500" style={{ height: NARR_TRACK_H, lineHeight: `${NARR_TRACK_H}px` }}>
            Narrative
          </div>
          <div className="border-b border-slate-200 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500" style={{ height: RULER_H, lineHeight: `${RULER_H}px` }}>
            Time
          </div>
          {services.map(s => (
            <div
              key={s.id}
              className="flex items-center gap-2 border-b border-slate-100 px-3"
              style={{ height: LANE_HEIGHT }}
            >
              <span className="text-base leading-none">{s.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-slate-800">{s.label}</div>
                <div className="truncate font-mono text-[9.5px] uppercase tracking-wider text-slate-400">{s.kind}</div>
              </div>
            </div>
          ))}
          {services.length === 0 && (
            <div className="px-3 py-4 text-[11px] italic text-slate-400">
              Drag a service from the palette to populate lanes here.
            </div>
          )}
        </div>

        {/* Right scrollable timeline */}
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-auto">
          <div className="relative" style={{ width: widthPx, minWidth: '100%' }}>
            <NarrativeTrack
              widthPx={widthPx}
              pxPerTick={pxPerTick}
              beats={episode.narrative}
              duration={episode.duration}
              onSeek={setTick}
              onUpsert={upsertBeat}
              onDelete={deleteBeat}
            />
            <Ruler
              totalTicks={episode.duration}
              pxPerTick={pxPerTick}
              onSeek={setTick}
            />
            <div className="relative" style={{ width: widthPx }}>
              <NarrativeGuides
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
                  onSelectBlock={setSelectedBlock}
                  onMoveBlock={(id, start) => updateBlock(id, { start })}
                  onResizeBlock={(id, patch) => updateBlock(id, patch)}
                  onAddBlock={(t) => onAddBlock(s.id, t)}
                />
              ))}
            </div>
            <Playhead
              tick={tick}
              pxPerTick={pxPerTick}
              height={NARR_TRACK_H + RULER_H + lanesHeight}
              onScrub={setTick}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
