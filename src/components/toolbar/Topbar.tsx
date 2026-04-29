'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  StepForward,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { DESTINATION_TYPE_META } from '@/types/destinations'
import { serializeScenario, deserializeScenario, downloadJson } from '@/lib/serialization'
import type { Connection } from '@/types/connections'
import { asFlowEdgeData, asFlowNodeData } from '@/lib/flow-data'
import { cn } from '@/lib/utils'
import { pickCriblPayload } from '@/lib/backendClient'
import { canvasToScenarioYaml } from '@/lib/canvasToScenarioYaml'
import { runStream } from '@/lib/runStream'
import { logsAt } from '@/lib/logsAt'
import { materializeProposedScenarioJson } from '@/lib/scenarioPrompt'

interface PresetScenarioManifestEntry {
  file: string
  title: string
  description: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
  durationTicks: number
  serviceCount: number
}

function LogoMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="0" y="0" width="8" height="8" rx="1.5" fill="#2563eb" />
      <rect x="10" y="0" width="8" height="8" rx="1.5" fill="#2563eb" opacity="0.4" />
      <rect x="0" y="10" width="8" height="8" rx="1.5" fill="#2563eb" opacity="0.4" />
      <rect x="10" y="10" width="8" height="8" rx="1.5" fill="#2563eb" />
    </svg>
  )
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

export function Topbar() {
  const { nodes, edges, metadata, setMetadata, resetScenario, loadScenario } = useScenarioStore()
  const setDescribePanelOpen = useUIStore(s => s.setDescribePanelOpen)
  const setEpisode = useEpisodeStore(s => s.setEpisode)
  const setTick = useEpisodeStore(s => s.setTick)
  const setRunStatus = useEpisodeStore(s => s.setRunStatus)
  const {
    status,
    speed,
    tickCount,
    setStatus,
    setTickCount,
    setSimulatedTime,
    addLogs,
    clearActiveConnections,
    clearLogs,
    logBuffer,
    outputFormat,
    setOutputFormat,
  } = useSimulationStore()
  const {
    destinations,
    statuses: destStatuses,
    errors: destErrors,
    toggleDestination,
    setStatus: setDestStatus,
    recordSent,
  } = useDestinationsStore()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const [presets, setPresets] = useState<PresetScenarioManifestEntry[]>([])
  const [presetsLoaded, setPresetsLoaded] = useState(false)
  const [draftName, setDraftName] = useState(metadata.name)
  const [editingTitle, setEditingTitle] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  // Backend polling refs (mirrors SimulationControls)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const simCursorRef = useRef<number>(Date.now())
  const seedRef = useRef<number>(0)
  const destinationsRef = useRef(destinations)
  useEffect(() => { destinationsRef.current = destinations }, [destinations])

  useEffect(() => { setDraftName(metadata.name) }, [metadata.name])
  useEffect(() => {
    if (!editingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [editingTitle])

  // ── File operations ─────────────────────────────────────────────
  const buildScenario = useCallback(() => serializeScenario(
    nodes.map(n => n.data),
    edges.map(e => e.data!).filter(Boolean) as Connection[],
    metadata,
  ), [nodes, edges, metadata])

  const persistAutosave = useCallback(() => {
    const scenario = buildScenario()
    localStorage.setItem('logsim-autosave', JSON.stringify(scenario))
    localStorage.setItem('logsim-autosave-time', new Date().toISOString())
  }, [buildScenario])

  const handleSaveScenario = useCallback(() => {
    const scenario = buildScenario()
    downloadJson(scenario, `${metadata.name.toLowerCase().replace(/\s+/g, '-')}.logsim.json`)
    persistAutosave()
  }, [buildScenario, metadata.name, persistAutosave])

  useEffect(() => {
    window.addEventListener('logsim-save', handleSaveScenario as EventListener)
    window.addEventListener('logsim-autosave', persistAutosave as EventListener)
    return () => {
      window.removeEventListener('logsim-save', handleSaveScenario as EventListener)
      window.removeEventListener('logsim-autosave', persistAutosave as EventListener)
    }
  }, [handleSaveScenario, persistAutosave])

  const handleOpenScenario = useCallback(() => fileInputRef.current?.click(), [])

  const handleScenarioFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string)
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
      } catch (err) {
        alert('Failed to load scenario: ' + String(err))
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }, [loadScenario])

  const handleNewScenario = useCallback(() => {
    if (nodes.length > 0) {
      if (!confirm('Create a new scenario? Unsaved changes will be lost.')) return
    }
    resetScenario()
    setDescribePanelOpen(true)
  }, [nodes.length, resetScenario, setDescribePanelOpen])

  // ── Example Scenarios (presets w/ embedded timelines) ───────────
  const loadPresetsManifest = useCallback(async () => {
    if (presetsLoaded) return
    try {
      const res = await fetch('/scenarios/presets/index.json', { cache: 'no-cache' })
      if (res.ok) setPresets(await res.json())
    } catch { /* ignore */ }
    setPresetsLoaded(true)
  }, [presetsLoaded])

  const loadExampleScenario = useCallback(async (entry: PresetScenarioManifestEntry) => {
    try {
      const res = await fetch(`/scenarios/presets/${entry.file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const result = materializeProposedScenarioJson(json)
      const now = new Date().toISOString()
      loadScenario(result.flowNodes, result.flowEdges, {
        name: result.name?.trim() || entry.title,
        description: result.description?.trim() || entry.description,
        createdAt: now,
        updatedAt: now,
      })
      if (result.episode) setEpisode(result.episode)
    } catch (err) {
      alert(`Failed to load preset scenario: ${String(err)}`)
    }
  }, [loadScenario, setEpisode])

  // ── Simulation control ─────────────────────────────────────────
  // Build the timeline-baked scenario YAML so the backend applies per-tick
  // overrides server-side from a single request.
  const buildScenarioYaml = useCallback((): string => {
    const ep = useEpisodeStore.getState().episode
    return canvasToScenarioYaml(
      useScenarioStore.getState().nodes,
      useScenarioStore.getState().edges,
      useScenarioStore.getState().metadata,
      { episode: ep, tickIntervalMs: 1000 },
    )
  }, [])

  const stopBackend = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const startPlayback = useCallback((nextSpeed: number) => {
    if (status === 'running') return
    const enabledCribl = destinationsRef.current.find(d => d.enabled && d.type === 'cribl-hec')
    const cribl = pickCriblPayload(destinationsRef.current)
    const yaml = buildScenarioYaml()
    const ep = useEpisodeStore.getState().episode
    const simStart = Date.now()
    simCursorRef.current = simStart
    seedRef.current = Math.floor(Math.random() * 1e9)
    // Play always plays the scenario from the beginning. Reset the scrubber
    // and clear accumulated logs so the panel fills as ticks emit.
    clearLogs()
    setTick(0)
    setTickCount(0)
    setStatus('running')
    setRunStatus('running')
    if (enabledCribl) setDestStatus(enabledCribl.id, 'sending')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    runStream({
      scenarioYaml: yaml,
      duration: ep.duration,
      tickIntervalMs: 1000,
      startTimeMs: simStart,
      startTick: 0,
      seed: seedRef.current,
      // Run the engine flat-out server-side and pace the scrubber on the
      // client. Vercel Functions buffer the streaming response, so a paced
      // server run would produce no visible motion until the function ends —
      // and at rate=1 that's hundreds of seconds, well past maxDuration.
      rate: 0,
      paceMs: nextSpeed > 0 ? Math.max(16, Math.round(1000 / nextSpeed)) : 0,
      cribl,
      format: outputFormat,
      signal: ctrl.signal,
      onTick: ({ tick: t, logs }) => {
        setTick(t + 1)
        setTickCount(t + 1)
        setSimulatedTime(new Date(simStart + (t + 1) * 1000))
        if (logs.length) addLogs(logs)
      },
      onDone: ({ totalLogs }) => {
        if (enabledCribl) {
          if (totalLogs > 0) recordSent(enabledCribl.id, totalLogs)
          else setDestStatus(enabledCribl.id, 'idle')
        }
        abortRef.current = null
        setStatus('idle')
        setRunStatus('idle')
      },
      onError: (err) => {
        console.error('run stream error:', err)
        if (enabledCribl) setDestStatus(enabledCribl.id, 'error', err.message)
        abortRef.current = null
        setStatus('idle')
        setRunStatus('idle')
      },
    })
  }, [addLogs, buildScenarioYaml, clearLogs, outputFormat, recordSent, setDestStatus, setRunStatus, setSimulatedTime, setStatus, setTick, setTickCount, status])

  const stopPlayback = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    setStatus('idle')
    setRunStatus('stopped')
  }, [clearActiveConnections, setRunStatus, setStatus, stopBackend])

  const handlePlayPause = useCallback(() => {
    if (status === 'running') stopPlayback()
    else startPlayback(speed)
  }, [speed, startPlayback, status, stopPlayback])

  const handleStep = useCallback(async () => {
    if (status === 'running') return
    try {
      const yaml = buildScenarioYaml()
      const startMs = simCursorRef.current || Date.now()
      const tickIdx = useEpisodeStore.getState().tick
      const from = Math.max(0, Math.floor(tickIdx))
      const to = from + 1
      const result = await logsAt({
        scenarioYaml: yaml,
        from,
        to,
        tickIntervalMs: 1000,
        startTimeMs: startMs,
        seed: (seedRef.current ||= Math.floor(Math.random() * 1e9)) + 1,
        format: outputFormat,
      })
      simCursorRef.current = startMs + 1000
      if (result.length) addLogs(result)
      setTick(to)
      setTickCount(to)
      setSimulatedTime(new Date(startMs + 1000))
    } catch (err) {
      console.error('step failed:', err)
    }
  }, [addLogs, buildScenarioYaml, outputFormat, setSimulatedTime, setTick, setTickCount, status])

  const handleReset = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    clearLogs()
    setTickCount(0)
    setTick(0)
    simCursorRef.current = Date.now()
    setSimulatedTime(new Date())
    setStatus('idle')
    setRunStatus('idle')
  }, [clearActiveConnections, clearLogs, setRunStatus, setSimulatedTime, setStatus, setTick, setTickCount, stopBackend])

  useEffect(() => () => stopBackend(), [stopBackend])

  // ── Title editing ───────────────────────────────────────────────
  const commitName = useCallback((raw: string) => {
    const next = raw.trim() || 'My Scenario'
    if (next !== metadata.name) setMetadata({ name: next })
    setDraftName(next)
    setEditingTitle(false)
  }, [metadata.name, setMetadata])

  // ── Exports ─────────────────────────────────────────────────────
  const handleExportLog = useCallback(() => {
    const text = logBuffer.map(l => l.raw).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'logs.log'
    a.click()
    URL.revokeObjectURL(url)
  }, [logBuffer])

  const handleExportJsonl = useCallback(() => {
    const text = logBuffer.map(l => JSON.stringify(l)).join('\n')
    const blob = new Blob([text], { type: 'application/jsonl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'logs.jsonl'
    a.click()
    URL.revokeObjectURL(url)
  }, [logBuffer])

  // ── Derived ─────────────────────────────────────────────────────
  const isRunning = status === 'running'
  const enabledDests = destinations.filter(d => d.enabled)
  const destOverall: 'none' | 'error' | 'sending' | 'ok' = (() => {
    if (enabledDests.length === 0) return 'none'
    if (enabledDests.some(d => destStatuses[d.id] === 'error')) return 'error'
    if (enabledDests.some(d => destStatuses[d.id] === 'sending')) return 'sending'
    return 'ok'
  })()

  // ── Render ──────────────────────────────────────────────────────
  const destLabel =
    enabledDests.length === 0
      ? 'No destination'
      : enabledDests.length === 1
        ? enabledDests[0].name
        : `${enabledDests.length} destinations`

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 sm:px-4">
      {/* LEFT: brand + scenarios menu + scenario name */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {/* Brand: LogSim2 — opens About / GitHub menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-slate-100"
              title="About LogSim2"
            >
              <LogoMark />
              <span className="hidden text-[13.5px] font-semibold tracking-[-0.01em] text-slate-900 sm:inline">LogSim2</span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44 text-xs">
            <DropdownMenuItem
              onClick={() => setAboutOpen(true)}
              className="cursor-pointer text-xs"
            >
              <Info className="mr-2 h-3.5 w-3.5 text-slate-500" />
              About
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="cursor-pointer text-xs">
              <a
                href="https://github.com/hyfather/logsim2"
                target="_blank"
                rel="noreferrer noopener"
              >
                <GithubMark className="mr-2 h-3.5 w-3.5 text-slate-600" />
                GitHub
                <ExternalLink className="ml-auto h-3 w-3 text-slate-400" />
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Subtle separator */}
        <span className="hidden h-4 w-px bg-slate-200 sm:inline-block" aria-hidden />

        {/* Scenarios: top-level menu with New / Open / Save / Examples / Settings */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group/scenarios flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-slate-50 hover:text-slate-900 data-[state=open]:bg-slate-50 data-[state=open]:text-slate-900"
              title="Scenarios menu"
            >
              <span>Scenarios</span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400 transition-transform group-data-[state=open]/scenarios:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 text-xs">
            <DropdownMenuItem onClick={handleNewScenario} className="cursor-pointer text-xs">📄 New Scenario</DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenScenario} className="cursor-pointer text-xs">📂 Open Scenario…</DropdownMenuItem>
            <DropdownMenuItem onClick={handleSaveScenario} className="cursor-pointer text-xs">💾 Save Scenario  ⌘S</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                onMouseEnter={loadPresetsManifest}
                onFocus={loadPresetsManifest}
                className="cursor-pointer text-xs"
              >
                📚 Example Scenarios
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-w-sm text-xs">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                  Realistic scenarios with timelines
                </DropdownMenuLabel>
                {!presetsLoaded ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">Loading…</div>
                ) : presets.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">No example scenarios found.</div>
                ) : (
                  presets.map(p => (
                    <DropdownMenuItem
                      key={p.file}
                      onClick={() => loadExampleScenario(p)}
                      className="flex cursor-pointer flex-col items-start gap-0.5 text-xs"
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        {p.title}
                        <span className={cn(
                          'rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide',
                          p.category === 'security' ? 'bg-rose-100 text-rose-700'
                            : p.category === 'incident' ? 'bg-amber-100 text-amber-800'
                            : p.category === 'deploy' ? 'bg-violet-100 text-violet-700'
                            : 'bg-slate-100 text-slate-600',
                        )}>{p.category}</span>
                      </span>
                      <span className="whitespace-normal text-[10px] leading-tight text-slate-500">{p.description}</span>
                      <span className="text-[10px] text-slate-400">
                        {p.serviceCount} services · {Math.round(p.durationTicks / 60)} min · {p.difficulty}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer text-xs">
              <Link href="/settings">⚙️ Settings…</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Subtle separator */}
        <span className="hidden h-4 w-px bg-slate-200 sm:inline-block" aria-hidden />

        {/* Scenario name */}
        <div className="flex min-w-0 items-center">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              onBlur={e => commitName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitName(draftName)
                if (e.key === 'Escape') { setDraftName(metadata.name); setEditingTitle(false) }
              }}
              className="min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-[13px] font-medium text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="group/name flex min-w-0 items-center gap-1.5 truncate rounded-md px-2 py-1 text-[13px] font-medium text-slate-900 transition-colors hover:bg-slate-100"
              title="Rename scenario"
            >
              <span className="truncate">{metadata.name}</span>
              <Pencil className="h-3 w-3 shrink-0 text-slate-400 opacity-0 transition-opacity group-hover/name:opacity-100" />
            </button>
          )}
        </div>
      </div>

      {/* RIGHT: destinations + format + transport tray + export */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Destinations chip — refined pill, state-aware */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'group/dest h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium transition-colors sm:inline-flex',
                destinations.length === 0 ? 'hidden sm:inline-flex' : 'inline-flex',
                destOverall === 'error'
                  ? 'bg-red-50 text-red-700 hover:bg-red-100'
                  : destOverall === 'sending'
                    ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                    : destOverall === 'ok'
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'text-slate-500 hover:bg-slate-100',
              )}
              title="Log forwarding destinations"
            >
              <span className={cn(
                'h-1.5 w-1.5 rounded-full',
                destOverall === 'none' ? 'bg-slate-300'
                  : destOverall === 'error' ? 'bg-red-500'
                    : destOverall === 'sending' ? 'bg-blue-500 animate-pulse'
                      : 'bg-emerald-500',
              )} />
              <span className="max-w-[140px] truncate">{destLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-50 transition-opacity group-hover/dest:opacity-80" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Log Destinations
            </DropdownMenuLabel>
            {destinations.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-slate-400">No destinations configured</div>
            ) : (
              destinations.map(dest => {
                const s = destStatuses[dest.id]
                const err = destErrors[dest.id]
                const meta = DESTINATION_TYPE_META[dest.type]
                const dotCls = dest.enabled
                  ? s === 'error' ? 'bg-red-500'
                  : s === 'sending' ? 'bg-blue-500 animate-pulse'
                  : s === 'idle' ? 'bg-green-500'
                  : 'bg-gray-300'
                  : 'bg-gray-200'
                return (
                  <div key={dest.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', dotCls)} title={err || undefined} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="truncate text-xs font-medium text-slate-800">{dest.name}</span>
                        <span className="shrink-0 text-[9px] text-slate-400">{meta.icon}</span>
                      </div>
                      {s === 'error' && err && <p className="truncate text-[10px] text-red-500">{err}</p>}
                    </div>
                    <Switch
                      checked={dest.enabled}
                      onCheckedChange={() => toggleDestination(dest.id)}
                      aria-label={`Toggle ${dest.name}`}
                      className="shrink-0 scale-75"
                    />
                    <Link
                      href={`/settings?destination=${dest.id}`}
                      className="shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
                      title="Edit"
                    >
                      <Pencil className="h-3 w-3" />
                    </Link>
                  </div>
                )
              })
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer text-xs text-slate-600">
              <Link href="/settings"><span className="mr-1.5">⚙️</span> Manage Destinations…</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Output schema toggle — generators emit a canonical event, the
            backend maps it to Native / OCSF / (later) UDM / ASIM before the
            line reaches the UI. Switching clears the buffer because formats
            don't mix cleanly. */}
        <div className="hidden h-8 shrink-0 items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-[3px] sm:flex">
          {(['native', 'ocsf'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setOutputFormat(f)}
              className={cn(
                'rounded-[5px] px-2 py-[2px] font-mono text-[10.5px] font-semibold uppercase transition-colors',
                outputFormat === f
                  ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.05)]'
                  : 'text-slate-500 hover:text-slate-900',
              )}
              title={f === 'native' ? 'Generator-native log lines' : 'OCSF v1.x JSON events'}
            >{f}</button>
          ))}
        </div>

        {/* Transport tray — unified container with subtle dividers */}
        <div
          className={cn(
            'inline-flex h-8 shrink-0 items-center overflow-hidden rounded-lg border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors',
            isRunning ? 'border-emerald-200' : 'border-slate-200',
          )}
        >
          <button
            type="button"
            onClick={handleReset}
            disabled={!isRunning && tickCount === 0}
            className="inline-flex h-full w-8 items-center justify-center text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
            title="Reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <span className="h-4 w-px bg-slate-200" aria-hidden />
          <button
            type="button"
            onClick={handleStep}
            disabled={isRunning}
            className="inline-flex h-full w-8 items-center justify-center text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
            title="Step one tick"
          >
            <StepForward className="h-3.5 w-3.5" />
          </button>
          <span className="h-4 w-px bg-slate-200" aria-hidden />
          <button
            type="button"
            onClick={handlePlayPause}
            className={cn(
              'inline-flex h-full items-center gap-1.5 px-3 text-[12px] font-medium transition-colors',
              isRunning
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'text-slate-700 hover:bg-slate-50',
            )}
            title={isRunning ? 'Pause simulation' : 'Run simulation'}
          >
            {isRunning ? (
              <>
                <span className="relative flex h-2 w-2 items-center justify-center" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <Pause className="h-3.5 w-3.5 fill-current" />
                <span className="hidden sm:inline">Pause</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current" />
                <span className="hidden sm:inline">Run</span>
              </>
            )}
          </button>
        </div>

        {/* Export primary */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-[12px] font-semibold text-white shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition-colors hover:bg-blue-700"
              title="Export dataset"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Export</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Export {logBuffer.length} log{logBuffer.length === 1 ? '' : 's'}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleExportLog} className="cursor-pointer text-xs">
              <span className="font-mono text-[11px] text-slate-400">.log</span>
              <span className="ml-2">Plain text</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleExportJsonl} className="cursor-pointer text-xs">
              <span className="font-mono text-[11px] text-slate-400">.jsonl</span>
              <span className="ml-2">JSON lines</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* hidden file input */}
      <input ref={fileInputRef} type="file" accept=".json,.logsim.json" className="hidden" onChange={handleScenarioFileChange} />

      {/* About modal */}
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <LogoMark />
              <DialogTitle>LogSim2</DialogTitle>
            </div>
            <DialogDescription>
              A drag-and-drop infrastructure log simulator for designing realistic
              telemetry scenarios in the browser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-[13px] leading-relaxed text-slate-700">
            <p>
              Compose services on a canvas, define incident timelines, and stream
              the resulting logs to your observability pipeline.
            </p>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Open source
              </p>
              <p className="text-[12.5px] text-slate-600">
                LogSim2 is open source under the Apache 2.0 license, so you can
                confidently use real-world production logs to simulate services
                without those logs being stored on the LogSim2 backend. Your logs
                are sent only to the LLM via the model provider API key you provide.
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Your API keys stay in your browser
              </p>
              <p className="text-[12.5px] text-slate-600">
                Any API keys you supply (OpenAI, Anthropic, Gemini, etc.) are
                stored only in your browser&apos;s local storage and sent directly
                to the model provider. They are never transmitted to a LogSim2,
                logged, or shared with third parties.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

