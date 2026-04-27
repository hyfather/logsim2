'use client'
import React, { useCallback, useEffect, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '@/components/canvas/Canvas'
import { Palette } from '@/components/palette/Palette'
import { NodeInspectorPanel } from '@/components/panels/NodeInspectorPanel'
import { Topbar } from '@/components/toolbar/Topbar'
import { BulkGenerateModal } from '@/components/panels/BulkGenerateModal'
import { EpisodeTimeline } from '@/components/episodes/EpisodeTimeline'
import { BlockInspector } from '@/components/episodes/BlockInspector'
import { ScrubbedLogs } from '@/components/episodes/ScrubbedLogs'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useUIStore } from '@/store/useUIStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { forwardToHec } from '@/lib/criblForwarder'
import type { CriblHecDestination } from '@/types/destinations'
import { PanelLeftOpen, PanelRightOpen, ChevronDown, ChevronUp } from 'lucide-react'
import { deserializeScenario } from '@/lib/serialization'
import { asFlowEdgeData, asFlowNodeData } from '@/lib/flow-data'
import { materializeProposedScenarioJson } from '@/lib/scenarioPrompt'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUrlSync } from '@/hooks/useUrlSync'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { startPointerDrag } from '@/lib/pointerDrag'

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

export default function EditorPageClient() {
  useUrlSync()
  const isMobile = useIsMobile()
  const {
    logPanelOpen, logPanelWidth, setLogPanelOpen, setLogPanelWidth,
    canvasOpen, setCanvasOpen, selectedNodeId,
    timelineHeight, setTimelineHeight,
    timelineCollapsed, setTimelineCollapsed,
    canvasCollapsed, setCanvasCollapsed,
    setDescribePanelOpen,
  } = useUIStore()
  const selectedBlockId = useEpisodeStore(s => s.selectedBlockId)
  const setEpisode = useEpisodeStore(s => s.setEpisode)
  const selectedNode = useScenarioStore(s => selectedNodeId ? s.nodes.find(n => n.id === selectedNodeId)?.data ?? null : null)
  const { loadScenario } = useScenarioStore()
  const { logBuffer } = useSimulationStore()
  const accumulateMode = useSimulationStore(s => s.accumulateMode)
  const accumulateModeRef = useRef(accumulateMode)
  accumulateModeRef.current = accumulateMode
  const { destinations, setStatus, recordSent } = useDestinationsStore()
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

  // Bootstrap: prefer ?scenario=<slug> from the landing page, else fall back to autosave.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('ai') === '1') {
      setDescribePanelOpen(true)
      params.delete('ai')
      const next = params.toString()
      const url = next ? `${window.location.pathname}?${next}` : window.location.pathname
      window.history.replaceState(null, '', url)
    }
    const slug = params.get('scenario')
    if (slug) {
      let cancelled = false
      ;(async () => {
        try {
          const res = await fetch(`/scenarios/presets/${slug}.scenario.json`, { cache: 'no-cache' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const json = await res.json()
          if (cancelled) return
          const result = materializeProposedScenarioJson(json)
          const now = new Date().toISOString()
          loadScenario(result.flowNodes, result.flowEdges, {
            name: result.name?.trim() || slug,
            description: result.description?.trim() || '',
            createdAt: now,
            updatedAt: now,
          })
          if (result.episode) setEpisode(result.episode)
        } catch (err) {
          console.warn('Failed to load preset from URL:', err)
        } finally {
          // Strip the param so refreshes don't re-load and overwrite edits.
          const cleaned = new URLSearchParams(window.location.search)
          cleaned.delete('scenario')
          const next = cleaned.toString()
          const url = next ? `${window.location.pathname}?${next}` : window.location.pathname
          window.history.replaceState(null, '', url)
        }
      })()
      return () => { cancelled = true }
    }

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

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    startPointerDrag(event, {
      onMove: ({ event: ev }) => {
        const nextWidth = Math.min(760, Math.max(300, window.innerWidth - ev.clientX))
        setLogPanelWidth(nextWidth)
      },
    })
  }, [setLogPanelWidth])

  const handleSetWidth = useCallback((fraction: number) => {
    setLogPanelWidth(Math.round(window.innerWidth * fraction))
    setLogPanelOpen(true)
    // Mobile: panes are mutually exclusive. Opening logs collapses the canvas.
    if (window.matchMedia('(max-width: 767px)').matches) {
      setCanvasOpen(false)
    }
  }, [setLogPanelWidth, setLogPanelOpen, setCanvasOpen])

  const handleOpenCanvas = useCallback(() => {
    setCanvasOpen(true)
    if (window.matchMedia('(max-width: 767px)').matches) {
      setLogPanelOpen(false)
    }
  }, [setCanvasOpen, setLogPanelOpen])

  // First-load reconciliation: defaults open both panes; on mobile we keep
  // canvas (logs are accessible from the collapsed rail).
  useEffect(() => {
    if (!isMobile) return
    if (logPanelOpen && canvasOpen) {
      setLogPanelOpen(false)
    }
    // Run once per breakpoint change to mobile, not on every open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile])

  // Auto-expand to 25% when new logs arrive while panel is collapsed.
  // On mobile we don't auto-cover the canvas; the user opens logs explicitly.
  useEffect(() => {
    if (isMobile) {
      prevLogCountRef.current = logBuffer.length
      return
    }
    if (!logPanelOpenRef.current && logBuffer.length > prevLogCountRef.current) {
      setLogPanelWidth(Math.round(window.innerWidth * 0.25))
      setLogPanelOpen(true)
    }
    prevLogCountRef.current = logBuffer.length
  }, [logBuffer.length, isMobile, setLogPanelWidth, setLogPanelOpen])

  // On mobile, treat the log panel as a full-width overlay by setting its
  // effective width to 100% of the viewport (the existing flex-1 path handles this).
  const useFullWidthLogPanel = isMobile

  return (
    <ReactFlowProvider>
      <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--ls-bg)]">
        <Topbar />

        {/* Main area */}
        <div className="flex flex-1 overflow-hidden">
          <div
            className={cn(
              'relative overflow-hidden flex flex-col transition-[width] duration-150',
              canvasOpen ? 'flex-1' : 'w-10 shrink-0 border-r border-gray-200 bg-gray-50',
            )}
          >
            {!canvasOpen ? (
              <div className="flex h-full flex-col items-center gap-3 pt-2">
                <button
                  title="Expand canvas"
                  onClick={handleOpenCanvas}
                  className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 [writing-mode:vertical-rl]">
                  Canvas
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
                {/* Timeline (top) */}
                {timelineCollapsed ? (
                  <CollapsedSectionHeader
                    title="Timeline"
                    onExpand={() => setTimelineCollapsed(false)}
                  />
                ) : (
                  <div
                    className="shrink-0 border-b border-slate-200 bg-white overflow-hidden"
                    style={canvasCollapsed ? { flex: '1 1 0%', minHeight: 0 } : { height: timelineHeight }}
                  >
                    <EpisodeTimeline onCollapse={() => setTimelineCollapsed(true)} />
                  </div>
                )}

                {/* Resize divider — only when both expanded */}
                {!timelineCollapsed && !canvasCollapsed && (
                  <TimelineDivider height={timelineHeight} setHeight={setTimelineHeight} />
                )}

                {/* Canvas (bottom) */}
                {canvasCollapsed ? (
                  <CollapsedSectionHeader
                    title="Canvas"
                    onExpand={() => setCanvasCollapsed(false)}
                  />
                ) : (
                  <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                    <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-200 bg-white/95 px-3 py-1">
                      <button
                        onClick={() => setCanvasCollapsed(true)}
                        title="Collapse canvas"
                        aria-label="Collapse canvas"
                        className="-ml-1 rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                      >
                        <ChevronDown className="size-3.5" />
                      </button>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                        Canvas
                      </span>
                    </div>
                    <div className="relative flex-1 min-h-0 overflow-hidden">
                      <Canvas />
                      <Palette />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div
            className={cn(
              'relative border-l border-gray-200 bg-white transition-[width] duration-150',
              logPanelOpen
                ? (canvasOpen ? 'shrink-0' : 'flex-1')
                : 'w-10 shrink-0',
            )}
            style={logPanelOpen && canvasOpen && !useFullWidthLogPanel ? { width: logPanelWidth } : undefined}
          >
            {logPanelOpen && !useFullWidthLogPanel && (
              <div
                className="absolute left-0 top-0 z-20 hidden h-full w-1 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-blue-200 md:block"
                onPointerDown={handleResizeStart}
              />
            )}

            {!logPanelOpen && (
              <div className="flex h-full flex-col items-center gap-3 pt-2">
                <button
                  title="Open log panel"
                  onClick={() => handleSetWidth(0.25)}
                  className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                >
                  <PanelRightOpen className="h-4 w-4" />
                </button>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 [writing-mode:vertical-rl]">
                  Logs
                </div>
              </div>
            )}

            {logPanelOpen && (
              selectedBlockId
                ? <BlockInspector />
                : selectedNode
                  ? <NodeInspectorPanel nodeData={selectedNode} />
                  : <ScrubbedLogs />
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      <BulkGenerateModal />
      <KeyboardShortcutsDialog />
    </ReactFlowProvider>
  )
}

function CollapsedSectionHeader({ title, onExpand }: { title: string; onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      title={`Expand ${title.toLowerCase()}`}
      className="group flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-left hover:bg-slate-100"
    >
      <ChevronDown className="size-3.5 -rotate-90 text-slate-500 transition-transform group-hover:text-slate-800" />
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600 group-hover:text-slate-900">
        {title}
      </span>
      <span className="ml-auto text-[10px] text-slate-400">Click to expand</span>
    </button>
  )
}

function TimelineDivider({ height, setHeight }: { height: number; setHeight: (h: number) => void }) {
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startH = height
    startPointerDrag(e, {
      onMove: ({ dy }) => {
        const next = Math.max(120, Math.min(560, startH + dy))
        setHeight(next)
      },
    })
  }, [height, setHeight])
  return (
    <div
      onPointerDown={onPointerDown}
      // Visible bar stays thin, but the touch hit area is taller via the
      // ::before pseudo so it's grabbable on phones without making the divider
      // look chunky on desktop.
      className="relative h-1 shrink-0 cursor-row-resize touch-none bg-slate-200 transition-colors before:absolute before:inset-x-0 before:-top-2 before:-bottom-2 before:content-[''] hover:bg-blue-300"
      title="Drag to resize timeline"
    />
  )
}
