'use client'
import React, { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '@/components/canvas/Canvas'
import { Palette } from '@/components/palette/Palette'
import { NodeInspectorPanel } from '@/components/panels/NodeInspectorPanel'
import { Topbar } from '@/components/toolbar/Topbar'
import { ModifyScenarioPanel } from '@/components/canvas/ModifyScenarioPanel'
import { NewScenarioModal } from '@/components/canvas/NewScenarioModal'
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
import { PanelLeftOpen, PanelRightOpen, ChevronDown, ChevronUp, Sparkles, AlertTriangle, X } from 'lucide-react'
import { deserializeScenario } from '@/lib/serialization'
import { scenarioToFlow } from '@/lib/flow-data'
import { materializeProposedScenarioJson } from '@/lib/scenarioPrompt'
import { useScenarioLibraryStore } from '@/store/useScenarioLibraryStore'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { startPointerDrag } from '@/lib/pointerDrag'

interface EditorPageClientProps {
  /** Pre-selected scenario slug from a server route like `/s/<slug>`. Takes
   *  precedence over `?scenario=<slug>` and is the source of truth when set. */
  initialScenarioSlug?: string
}

export default function EditorPageClient({ initialScenarioSlug }: EditorPageClientProps = {}) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const {
    logPanelOpen, logPanelWidth, setLogPanelOpen, setLogPanelWidth,
    canvasOpen, setCanvasOpen, selectedNodeId,
    timelineHeight, setTimelineHeight,
    timelineCollapsed, setTimelineCollapsed,
    canvasCollapsed, setCanvasCollapsed,
    modifyPanelOpen, setModifyPanelOpen,
    newScenarioModalOpen, setNewScenarioModalOpen,
  } = useUIStore()
  const selectedBlockId = useEpisodeStore(s => s.selectedBlockId)
  const setEpisode = useEpisodeStore(s => s.setEpisode)
  const selectedNode = useScenarioStore(s => selectedNodeId ? s.nodes.find(n => n.id === selectedNodeId)?.data ?? null : null)
  const { loadScenario } = useScenarioStore()
  const { logBuffer } = useSimulationStore()
  const runError = useSimulationStore(s => s.runError)
  const setRunError = useSimulationStore(s => s.setRunError)
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

  // Bootstrap: prefer ?scenario=<slug>, else last library entry, else legacy
  // autosave migration, else drop a first-time visitor into an intro template.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)

    // Strip the legacy ?ep= param if present — episodes are no longer URL-synced.
    if (params.has('ep')) {
      const cleaned = new URLSearchParams(window.location.search)
      cleaned.delete('ep')
      const next = cleaned.toString()
      const url = next ? `${window.location.pathname}?${next}` : window.location.pathname
      router.replace(url, { scroll: false })
    }

    const loadPresetBySlug = async (slug: string, fallbackName?: string) => {
      const res = await fetch(`/scenarios/presets/${slug}.scenario.json`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (cancelled) return
      const result = materializeProposedScenarioJson(json)
      const now = new Date().toISOString()
      useScenarioLibraryStore.getState().startNew()
      loadScenario(result.flowNodes, result.flowEdges, {
        name: result.name?.trim() || fallbackName || slug,
        description: result.description?.trim() || '',
        createdAt: now,
        updatedAt: now,
      })
      if (result.episode) setEpisode(result.episode)
      // Immediately persist so the scenario shows up under "Recent" without
      // waiting for the 30s autosave tick.
      window.dispatchEvent(new CustomEvent('logsim-autosave'))
    }

    // Slug source priority: server-provided prop (e.g. /s/<slug>) over
    // ?scenario=<slug> query, since the prop is set by a route that already
    // verified the slug exists in the index.
    const slug = initialScenarioSlug ?? params.get('scenario')
    if (slug) {
      ;(async () => {
        try {
          await loadPresetBySlug(slug, slug)
        } catch (err) {
          console.warn('Failed to load preset from URL:', err)
        } finally {
          // Land on the canonical /editor URL so refreshes don't re-load and
          // overwrite edits. router.replace (vs raw history API) keeps Next's
          // pathname state in sync.
          const cleaned = new URLSearchParams(window.location.search)
          cleaned.delete('scenario')
          cleaned.delete('ep')
          const next = cleaned.toString()
          const url = next ? `/editor?${next}` : '/editor'
          router.replace(url, { scroll: false })
        }
      })()
      return () => { cancelled = true }
    }

    // Restore the last-edited scenario (canvas + timeline) from the library.
    const lib = useScenarioLibraryStore.getState()
    const current = lib.currentId ? lib.getById(lib.currentId) : undefined
    if (current) {
      try {
        const { flowNodes, flowEdges } = scenarioToFlow(current.scenario)
        loadScenario(flowNodes, flowEdges, current.scenario.metadata)
        setEpisode(current.episode)
        // Touch savedAt so revisiting bumps it to the top of the Recent list.
        window.dispatchEvent(new CustomEvent('logsim-autosave'))
        return () => { cancelled = true }
      } catch {
        // fall through to migration / first-visit intro
      }
    }

    // One-time migration: import the legacy `logsim-autosave` key (canvas-only)
    // into the library so users don't lose work when this version ships. The
    // legacy entry is then removed.
    let migrated = false
    const saved = localStorage.getItem('logsim-autosave')
    const savedTime = localStorage.getItem('logsim-autosave-time')
    if (saved && savedTime) {
      const age = Date.now() - new Date(savedTime).getTime()
      if (age < 7 * 24 * 3600 * 1000) {
        try {
          const data = JSON.parse(saved)
          const scenario = deserializeScenario(data)
          const { flowNodes, flowEdges } = scenarioToFlow(scenario)
          loadScenario(flowNodes, flowEdges, scenario.metadata)
          // Defer; the next autosave will write this into the library under a
          // fresh id (allocated here so renames stick).
          lib.startNew()
          migrated = true
        } catch {
          // ignore corrupted legacy data
        }
      }
      localStorage.removeItem('logsim-autosave')
      localStorage.removeItem('logsim-autosave-time')
    }
    if (migrated) return () => { cancelled = true }

    // First visit: no library entry, no legacy autosave. Drop the user into an
    // intro template so they see a working scenario instead of a blank canvas.
    ;(async () => {
      try {
        await loadPresetBySlug('db-slowdown-cascade', 'Database Slowdown Cascade')
      } catch (err) {
        console.warn('Failed to load intro template:', err)
      }
    })()
    return () => { cancelled = true }
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

  // Modify-with-AI shares the right rail with logs (mutually exclusive). Opening
  // the chat forces the rail open and bumps width to a chat-friendly minimum.
  const handleOpenModify = useCallback(() => {
    setModifyPanelOpen(true)
    setLogPanelOpen(true)
    setLogPanelWidth(Math.max(380, logPanelWidth))
    if (window.matchMedia('(max-width: 767px)').matches) {
      setCanvasOpen(false)
    }
  }, [setModifyPanelOpen, setLogPanelOpen, setLogPanelWidth, logPanelWidth, setCanvasOpen])

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

        {runError && (
          <RunErrorBanner message={runError} onDismiss={() => setRunError(null)} />
        )}

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
                      <button
                        type="button"
                        onClick={handleOpenModify}
                        title="Modify scenario with AI"
                        className="group absolute bottom-4 right-4 z-30 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white/95 px-3 py-1.5 text-[12px] font-semibold text-violet-800 shadow-md backdrop-blur transition-all hover:-translate-y-0.5 hover:bg-violet-50 hover:shadow-lg"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Modify with AI
                      </button>
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
              modifyPanelOpen
                ? <ModifyScenarioPanel onClose={() => setModifyPanelOpen(false)} />
                : selectedBlockId
                  ? <BlockInspector />
                  : selectedNode
                    ? <NodeInspectorPanel nodeData={selectedNode} />
                    : <ScrubbedLogs />
            )}
          </div>
        </div>
      </div>

      <NewScenarioModal open={newScenarioModalOpen} onClose={() => setNewScenarioModalOpen(false)} />
    </ReactFlowProvider>
  )
}

function RunErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  // Validation errors come back multiline (`4 validation error(s):\n  - …`).
  // Render the full text but cap height + allow scrolling so a long error
  // doesn't shove the canvas off-screen.
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-900"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-rose-700">
          Run failed
        </div>
        <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-rose-900">
          {message}
        </pre>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss error"
        className="rounded p-1 text-rose-700 transition-colors hover:bg-rose-100 hover:text-rose-900"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
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
