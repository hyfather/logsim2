'use client'
import React, { useEffect, useRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ReactFlowProvider } from '@xyflow/react'
import { X } from 'lucide-react'
import { Canvas } from '@/components/canvas/Canvas'
import { Palette } from '@/components/palette/Palette'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import type { SegmentCanvasSnapshot } from '@/types/episode'

interface Props {
  segmentId: string | null
  onClose: () => void
}

export function SegmentCanvasModal({ segmentId, onClose }: Props) {
  const segment = useEpisodeStore(s =>
    segmentId ? s.episode.segments.find(seg => seg.id === segmentId) ?? null : null
  )
  const updateSegmentCanvas = useEpisodeStore(s => s.updateSegmentCanvas)
  const setCanvasEditSegment = useEpisodeStore(s => s.setCanvasEditSegment)

  // Snapshot scenario store state on open so we can restore it on close.
  // Without this, opening the modal would permanently clobber whatever the
  // user had loaded in design mode.
  const prevScenarioRef = useRef<SegmentCanvasSnapshot | null>(null)
  const openForSegmentRef = useRef<string | null>(null)

  const open = segmentId !== null

  useEffect(() => {
    if (!open || !segment) return
    if (openForSegmentRef.current === segment.id) return
    openForSegmentRef.current = segment.id

    const prev = useScenarioStore.getState()
    prevScenarioRef.current = {
      nodes: prev.nodes,
      edges: prev.edges,
      metadata: prev.metadata,
    }

    const snapshot: SegmentCanvasSnapshot = segment.canvas ?? {
      nodes: prev.nodes,
      edges: prev.edges,
      metadata: { ...prev.metadata, name: segment.name },
    }
    if (!segment.canvas) {
      updateSegmentCanvas(segment.id, snapshot)
    }
    useScenarioStore.getState().loadScenario(snapshot.nodes, snapshot.edges, snapshot.metadata)
    setCanvasEditSegment(segment.id)
  }, [open, segment, setCanvasEditSegment, updateSegmentCanvas])

  const handleClose = () => {
    const segId = openForSegmentRef.current
    if (segId) {
      // Flush current scenario state into the segment immediately so we don't
      // race the 400ms bridge debounce when the user closes quickly.
      const s = useScenarioStore.getState()
      updateSegmentCanvas(segId, { nodes: s.nodes, edges: s.edges, metadata: s.metadata })
    }
    setCanvasEditSegment(null)
    if (prevScenarioRef.current) {
      const { nodes, edges, metadata } = prevScenarioRef.current
      useScenarioStore.getState().loadScenario(nodes, edges, metadata)
      prevScenarioRef.current = null
    }
    openForSegmentRef.current = null
    onClose()
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
          <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2">
            <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900">
              Editing segment
            </span>
            <DialogPrimitive.Title className="text-sm font-semibold text-slate-900">
              {segment?.name ?? ''}
            </DialogPrimitive.Title>
            <span className="text-[11px] text-slate-500">
              — changes auto-save to this segment
            </span>
            <button
              type="button"
              onClick={handleClose}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Done
            </button>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-md p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
              >
                <X className="size-4" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="relative flex-1 overflow-hidden">
            {open && (
              <ReactFlowProvider>
                <Canvas />
                <Palette />
              </ReactFlowProvider>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
