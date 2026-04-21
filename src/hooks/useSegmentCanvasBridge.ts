'use client'
import { useEffect } from 'react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'

/**
 * When the user picks "Edit in Canvas" on a segment, canvasEditSegmentId is set
 * and the segment's canvas snapshot is loaded into the scenario store. This hook
 * mirrors subsequent scenario store edits back into the segment so the user's
 * visual changes persist on the segment.
 *
 * Debounced so a drag doesn't thrash the episode store.
 */
export function useSegmentCanvasBridge() {
  const canvasEditSegmentId = useEpisodeStore(s => s.canvasEditSegmentId)
  const updateSegmentCanvas = useEpisodeStore(s => s.updateSegmentCanvas)

  useEffect(() => {
    if (!canvasEditSegmentId) return

    let handle: ReturnType<typeof setTimeout> | null = null

    const unsub = useScenarioStore.subscribe((state) => {
      if (handle) clearTimeout(handle)
      handle = setTimeout(() => {
        updateSegmentCanvas(canvasEditSegmentId, {
          nodes: state.nodes,
          edges: state.edges,
          metadata: state.metadata,
        })
      }, 400)
    })

    return () => {
      if (handle) clearTimeout(handle)
      unsub()
    }
  }, [canvasEditSegmentId, updateSegmentCanvas])
}
