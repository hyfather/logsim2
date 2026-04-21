'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '@/components/canvas/Canvas'
import { Palette } from '@/components/palette/Palette'
import { LogPanel } from '@/components/panels/LogPanel'
import { SimulationControls } from '@/components/panels/SimulationControls'
import { Toolbar } from '@/components/toolbar/Toolbar'
import { BulkGenerateModal } from '@/components/panels/BulkGenerateModal'
import { DestinationManagerModal } from '@/components/panels/DestinationManagerModal'
import { EpisodeMode } from '@/components/episodes/EpisodeMode'
import { useUIStore } from '@/store/useUIStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { forwardToHec } from '@/lib/criblForwarder'
import type { CriblHecDestination } from '@/types/destinations'
import { ChevronLeft } from 'lucide-react'
import { deserializeScenario } from '@/lib/serialization'
import { asFlowEdgeData, asFlowNodeData } from '@/lib/flow-data'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUrlSync } from '@/hooks/useUrlSync'
import { useSegmentCanvasBridge } from '@/hooks/useSegmentCanvasBridge'
import { useEpisodeStore } from '@/store/useEpisodeStore'

function KeyboardShortcutsDialog() {
  const { showKeyboardShortcuts, setShowKeyboardShortcuts } = useUIStore()
  return (
    <Dialog open={showKeyboardShortcuts} onOpenChange={setShowKeyboardShortcuts}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="text-xs space-y-1">
          {[
            ['Ctrl+S', 'Save scenario'],
            ['Ctrl+Z', 'Undo'],
            ['Delete/Backspace', 'Delete selected'],
            ['Ctrl+A', 'Select all'],
            ['Ctrl+0', 'Fit view'],
            ['1', 'Step one tick'],
            ['2', 'Play/Stop simulation'],
            ['Escape', 'Deselect / close panel'],
          ].map(([key, desc]) => (
            <div key={key} className="flex justify-between">
              <kbd className="font-mono bg-gray-100 px-1 rounded text-[10px]">{key}</kbd>
              <span className="text-gray-600">{desc}</span>
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" className="text-xs w-full" onClick={() => setShowKeyboardShortcuts(false)}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export type PanelMode = 'collapsed' | 'quarter' | 'custom'

export default function EditorPageClient() {
  useUrlSync()
  useSegmentCanvasBridge()
  const { logPanelOpen, logPanelWidth, setLogPanelOpen, setLogPanelWidth, mode } = useUIStore()
  const canvasEditSegmentId = useEpisodeStore(s => s.canvasEditSegmentId)
  const setCanvasEditSegment = useEpisodeStore(s => s.setCanvasEditSegment)
  const episode = useEpisodeStore(s => s.episode)
  const editingSegment = canvasEditSegmentId ? episode.segments.find(s => s.id === canvasEditSegmentId) : null
  const { loadScenario } = useScenarioStore()
  const { logBuffer } = useSimulationStore()
  const accumulateMode = useSimulationStore(s => s.accumulateMode)
  const accumulateModeRef = useRef(accumulateMode)
  accumulateModeRef.current = accumulateMode
  const { destinations, setStatus, recordSent } = useDestinationsStore()
  const resizingRef = useRef(false)
  const [panelMode, setPanelMode] = useState<PanelMode>('quarter')
  const logPanelOpenRef = useRef(logPanelOpen)
  const prevLogCountRef = useRef(logBuffer.length)
  // Refs kept current every render so interval callbacks never close over stale state
  const logBufferRef = useRef(logBuffer)
  const destinationsRef = useRef(destinations)
  const forwardedUpToRef = useRef(logBuffer.length)
  const forwardingRef = useRef(false)
  logPanelOpenRef.current = logPanelOpen
  logBufferRef.current = logBuffer
  destinationsRef.current = destinations

  // Auto-restore from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('logsim-autosave')
    const savedTime = localStorage.getItem('logsim-autosave-time')
    if (saved && savedTime) {
      const age = Date.now() - new Date(savedTime).getTime()
      if (age < 7 * 24 * 3600 * 1000) { // within 7 days
        try {
          const data = JSON.parse(saved)
          const scenario = deserializeScenario(data)
          const flowNodes = scenario.nodes.map(n => ({
              id: n.id,
              type: n.type,
              position: n.position,
              parentId: n.parentId || undefined,
              data: asFlowNodeData(n),
              style: n.size ? { width: n.size.width, height: n.size.height } : {},
              ...(n.parentId ? { extent: 'parent' as const } : {}),
            }))
            const flowEdges = scenario.connections.map(c => ({
              id: c.id,
              source: c.sourceId,
              target: c.targetId,
              sourceHandle: c.sourceHandle,
              targetHandle: c.targetHandle,
              type: 'connectionEdge' as const,
              data: asFlowEdgeData(c),
              label: c.protocol.toUpperCase(),
            }))
            loadScenario(flowNodes, flowEdges, scenario.metadata)
        } catch {
          // ignore
        }
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      // This will be picked up by the toolbar's save mechanism
      // For simplicity, we fire a custom event
      window.dispatchEvent(new CustomEvent('logsim-autosave'))
    }, 30_000)
    return () => clearInterval(interval)
  }, [])

  // Coalesced forwarding: flush accumulated logs to all enabled destinations every
  // FLUSH_INTERVAL ms. Reading state via refs means the interval never goes stale
  // and we make at most 1 proxy round-trip per destination per interval, regardless
  // of how many simulation ticks fired in that window.
  useEffect(() => {
    const FLUSH_INTERVAL_MS = 3_000

    const flush = () => {
      if (accumulateModeRef.current) {
        // In accumulate mode the user forwards manually from the log panel.
        // Advance the cursor so that when they re-enable auto-forward we don't
        // double-send everything collected while paused.
        forwardedUpToRef.current = logBufferRef.current.length
        return
      }
      const buffer = logBufferRef.current
      const dests  = destinationsRef.current
      const newLogs = buffer.slice(forwardedUpToRef.current)
      if (newLogs.length === 0 || forwardingRef.current) return

      const enabledDests = dests.filter(d => d.enabled)
      if (enabledDests.length === 0) return

      const endIndex = buffer.length
      forwardingRef.current = true

      const forwards = enabledDests.map(dest => {
        setStatus(dest.id, 'sending')
        const fwd = dest.type === 'cribl-hec'
          ? forwardToHec(newLogs, dest as CriblHecDestination)
          : Promise.resolve()
        return fwd
          .then(() => recordSent(dest.id, newLogs.length))
          .catch((err: unknown) => {
            setStatus(dest.id, 'error', err instanceof Error ? err.message : String(err))
          })
      })

      Promise.all(forwards).finally(() => {
        forwardedUpToRef.current = endIndex
        forwardingRef.current = false
      })
    }

    const interval = setInterval(flush, FLUSH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('logsim-save'))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizingRef.current = true

    const onMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return
      const nextWidth = Math.min(760, Math.max(300, window.innerWidth - moveEvent.clientX))
      setLogPanelWidth(nextWidth)
      setPanelMode('custom')
    }

    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [setLogPanelWidth])

  const handleSetWidth = useCallback((fraction: number) => {
    setLogPanelWidth(Math.round(window.innerWidth * fraction))
    setLogPanelOpen(true)
    setPanelMode(fraction === 0.25 ? 'quarter' : 'custom')
  }, [setLogPanelWidth, setLogPanelOpen])

  const handleCollapse = useCallback(() => {
    setLogPanelOpen(false)
    setPanelMode('collapsed')
  }, [setLogPanelOpen])

  // Auto-expand to 25% when new logs arrive while panel is collapsed
  useEffect(() => {
    if (!logPanelOpenRef.current && logBuffer.length > prevLogCountRef.current) {
      setLogPanelWidth(Math.round(window.innerWidth * 0.25))
      setLogPanelOpen(true)
      setPanelMode('quarter')
    }
    prevLogCountRef.current = logBuffer.length
  }, [logBuffer.length, setLogPanelWidth, setLogPanelOpen])

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-white">
        {/* Toolbar */}
        <Toolbar />

        {/* Simulation controls (hidden in episodes mode — episode has its own run controls) */}
        {mode === 'design' && <SimulationControls />}

        {/* Main area */}
        <div className="flex flex-1 overflow-hidden">
          {mode === 'design' && <Palette />}

          <div className="flex-1 relative overflow-hidden flex flex-col">
            {mode === 'design' && editingSegment && (
              <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
                <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                  Editing segment
                </span>
                <span className="font-medium">{editingSegment.name}</span>
                <span className="text-[10px] text-amber-700">— canvas edits auto-save to this segment</span>
                <div className="ml-auto flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px]"
                    onClick={() => { setCanvasEditSegment(null); useUIStore.getState().setMode('episodes') }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}
            <div className="flex-1 relative overflow-hidden">
              {mode === 'design' ? <Canvas /> : <EpisodeMode />}
            </div>
          </div>

          <div
            className={cn(
              'relative border-l border-gray-200 bg-white transition-[width] duration-150',
              logPanelOpen ? 'shrink-0' : 'w-10 shrink-0',
            )}
            style={logPanelOpen ? { width: logPanelWidth } : undefined}
          >
            {logPanelOpen && (
              <div
                className="absolute left-0 top-0 z-20 h-full w-1 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-blue-200"
                onMouseDown={handleResizeStart}
              />
            )}

            {!logPanelOpen && (
              <div className="flex h-full flex-col items-center pt-2">
                <button
                  title="Open log panel"
                  onClick={() => handleSetWidth(0.25)}
                  className="rounded p-2 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-600"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="mt-auto mb-4 text-[9px] font-medium tracking-widest text-gray-300 [writing-mode:vertical-rl]">
                  LOGS
                </div>
              </div>
            )}

            {logPanelOpen && (
              <LogPanel
                panelMode={panelMode}
                onCollapse={handleCollapse}
                onSetWidth={handleSetWidth}
              />
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      <BulkGenerateModal />
      <KeyboardShortcutsDialog />
      <DestinationManagerModal />
    </ReactFlowProvider>
  )
}
