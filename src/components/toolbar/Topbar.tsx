'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ChevronDown,
  Download,
  FastForward,
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
import { Switch } from '@/components/ui/switch'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { DESTINATION_TYPE_META } from '@/types/destinations'
import type { Episode, EpisodeFileV1 } from '@/types/episode'
import { serializeScenario, deserializeScenario, downloadJson } from '@/lib/serialization'
import type { Connection } from '@/types/connections'
import { asFlowEdgeData, asFlowNodeData } from '@/lib/flow-data'
import { cn } from '@/lib/utils'
import { generate, pickCriblPayload } from '@/lib/backendClient'
import { canvasToScenarioYaml } from '@/lib/canvasToScenarioYaml'

interface ExampleEpisodeManifestEntry {
  file: string
  title: string
  description: string
  segmentCount: number
  totalTicks: number
}

const SPEED_OPTIONS = [1, 2, 4, 8] as const

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

export function Topbar() {
  const { nodes, edges, metadata, setMetadata, resetScenario, loadScenario } = useScenarioStore()
  const { mode, setMode, setShowBulkGenerateModal, setShowKeyboardShortcuts } = useUIStore()
  const { episode, setEpisode } = useEpisodeStore()
  const {
    status,
    speed,
    tickCount,
    setStatus,
    setSpeed,
    setTickCount,
    setSimulatedTime,
    addLogs,
    clearActiveConnections,
    clearLogs,
    logBuffer,
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
  const episodeFileInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const [examples, setExamples] = useState<ExampleEpisodeManifestEntry[]>([])
  const [examplesLoaded, setExamplesLoaded] = useState(false)
  const [draftName, setDraftName] = useState(metadata.name)
  const [editingTitle, setEditingTitle] = useState(false)

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
  }, [nodes.length, resetScenario])

  // ── Episode I/O ─────────────────────────────────────────────────
  const loadExamplesManifest = useCallback(async () => {
    if (examplesLoaded) return
    try {
      const res = await fetch('/examples/episodes/index.json', { cache: 'no-cache' })
      if (res.ok) setExamples(await res.json())
    } catch { /* ignore */ }
    setExamplesLoaded(true)
  }, [examplesLoaded])

  const loadExampleEpisode = useCallback(async (file: string) => {
    try {
      const res = await fetch(`/examples/episodes/${file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as EpisodeFileV1 | Episode
      const ep = 'episode' in data ? data.episode : data
      if (!ep || !Array.isArray(ep.segments)) throw new Error('Invalid episode file')
      setEpisode(ep)
      setMode('episodes')
    } catch (err) {
      alert(`Failed to load example episode: ${String(err)}`)
    }
  }, [setEpisode, setMode])

  const handleEpisodeSave = useCallback(() => {
    const payload: EpisodeFileV1 = { version: 1, episode }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${episode.name.toLowerCase().replace(/\s+/g, '-')}.episode.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [episode])

  const handleEpisodeOpen = useCallback(() => episodeFileInputRef.current?.click(), [])

  const handleEpisodeFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string) as EpisodeFileV1 | Episode
        const ep = 'episode' in data ? data.episode : data
        if (!ep || !Array.isArray(ep.segments)) throw new Error('Invalid episode file')
        setEpisode(ep)
      } catch (err) {
        alert('Failed to load episode: ' + String(err))
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }, [setEpisode])

  // ── Simulation control ─────────────────────────────────────────
  const buildScenarioYaml = useCallback((): string => {
    return canvasToScenarioYaml(
      useScenarioStore.getState().nodes,
      useScenarioStore.getState().edges,
      useScenarioStore.getState().metadata,
    )
  }, [])

  const stopBackend = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const pollOnce = useCallback(async (opts: { windowTicks: number; tickIntervalMs: number; intervalMs: number }) => {
    try {
      const yaml = buildScenarioYaml()
      const cribl = pickCriblPayload(destinationsRef.current)
      const enabledCribl = destinationsRef.current.find(d => d.enabled && d.type === 'cribl-hec')
      if (cribl && enabledCribl) setDestStatus(enabledCribl.id, 'sending')

      abortRef.current = new AbortController()
      const startMs = simCursorRef.current
      const { logs, forwarded, forwardError } = await generate({
        scenarioYaml: yaml,
        ticks: opts.windowTicks,
        tickIntervalMs: opts.tickIntervalMs,
        startTimeMs: startMs,
        seed: seedRef.current++,
        cribl,
      })

      simCursorRef.current = startMs + opts.windowTicks * opts.tickIntervalMs
      addLogs(logs)
      setTickCount(useSimulationStore.getState().tickCount + opts.windowTicks)
      setSimulatedTime(new Date(simCursorRef.current))

      if (enabledCribl) {
        if (forwardError) setDestStatus(enabledCribl.id, 'error', forwardError)
        else if (forwarded > 0) recordSent(enabledCribl.id, forwarded)
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      console.error('backend poll failed:', err)
    } finally {
      if (useSimulationStore.getState().status === 'running') {
        pollRef.current = setTimeout(() => pollOnce(opts), opts.intervalMs)
      }
    }
  }, [addLogs, buildScenarioYaml, recordSent, setDestStatus, setSimulatedTime, setTickCount])

  const startPlayback = useCallback((nextSpeed: number) => {
    if (status === 'running') return
    simCursorRef.current = Date.now()
    seedRef.current = Math.floor(Math.random() * 1e9)
    setStatus('running')
    pollOnce({
      windowTicks: Math.max(1, Math.round(nextSpeed)),
      tickIntervalMs: 1000,
      intervalMs: 1000,
    })
  }, [pollOnce, setStatus, status])

  const stopPlayback = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    setStatus('idle')
  }, [clearActiveConnections, setStatus, stopBackend])

  const handlePlayPause = useCallback(() => {
    if (status === 'running') stopPlayback()
    else {
      setSpeed(1)
      startPlayback(1)
    }
  }, [setSpeed, startPlayback, status, stopPlayback])

  const handleStep = useCallback(async () => {
    if (status === 'running') return
    try {
      const yaml = buildScenarioYaml()
      const cribl = pickCriblPayload(destinationsRef.current)
      const enabledCribl = destinationsRef.current.find(d => d.enabled && d.type === 'cribl-hec')
      if (enabledCribl) setDestStatus(enabledCribl.id, 'sending')
      const startMs = simCursorRef.current || Date.now()
      const { logs, forwarded, forwardError } = await generate({
        scenarioYaml: yaml,
        ticks: 1,
        tickIntervalMs: 1000,
        startTimeMs: startMs,
        seed: (seedRef.current ||= Math.floor(Math.random() * 1e9)) + 1,
        cribl,
      })
      simCursorRef.current = startMs + 1000
      addLogs(logs)
      setTickCount(useSimulationStore.getState().tickCount + 1)
      setSimulatedTime(new Date(simCursorRef.current))
      if (enabledCribl) {
        if (forwardError) setDestStatus(enabledCribl.id, 'error', forwardError)
        else if (forwarded > 0) recordSent(enabledCribl.id, forwarded)
      }
    } catch (err) {
      console.error('step failed:', err)
    }
  }, [addLogs, buildScenarioYaml, recordSent, setDestStatus, setSimulatedTime, setTickCount, status])

  const handleReset = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    clearLogs()
    setTickCount(0)
    simCursorRef.current = Date.now()
    setSimulatedTime(new Date())
    setStatus('idle')
  }, [clearActiveConnections, clearLogs, setSimulatedTime, setStatus, setTickCount, stopBackend])

  const handleSpeedSelect = useCallback((nextSpeed: number) => {
    setSpeed(nextSpeed)
    if (status === 'running') {
      stopBackend()
      pollOnce({
        windowTicks: Math.max(1, Math.round(nextSpeed)),
        tickIntervalMs: 1000,
        intervalMs: 1000,
      })
    }
  }, [pollOnce, setSpeed, status, stopBackend])

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
  return (
    <div
      className="grid h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3.5"
      style={{ gridTemplateColumns: '1fr auto 1fr' }}
    >
      {/* LEFT: logo + breadcrumbs */}
      <div className="flex min-w-0 items-center gap-3.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-slate-100"
              title="File menu"
            >
              <LogoMark />
              <span className="text-[14px] font-bold tracking-[-0.01em] text-slate-900">logsim</span>
              <span className="font-mono text-[11px] font-medium text-slate-500">v2</span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 text-xs">
            <DropdownMenuItem onClick={handleNewScenario} className="cursor-pointer text-xs">📄 New Scenario</DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenScenario} className="cursor-pointer text-xs">📂 Open Scenario…</DropdownMenuItem>
            <DropdownMenuItem onClick={handleSaveScenario} className="cursor-pointer text-xs">💾 Save Scenario  ⌘S</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleEpisodeOpen} className="cursor-pointer text-xs">🎬 Open Episode…</DropdownMenuItem>
            <DropdownMenuItem onClick={handleEpisodeSave} className="cursor-pointer text-xs">🎬 Save Episode</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                onMouseEnter={loadExamplesManifest}
                onFocus={loadExamplesManifest}
                className="cursor-pointer text-xs"
              >
                🎞️ Example Episodes
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-w-sm text-xs">
                {!examplesLoaded ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">Loading…</div>
                ) : examples.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">No examples found.</div>
                ) : (
                  examples.map(ex => (
                    <DropdownMenuItem
                      key={ex.file}
                      onClick={() => loadExampleEpisode(ex.file)}
                      className="flex cursor-pointer flex-col items-start gap-0.5 text-xs"
                    >
                      <span className="font-medium">{ex.title}</span>
                      <span className="whitespace-normal text-[10px] leading-tight text-slate-500">{ex.description}</span>
                      <span className="text-[10px] text-slate-400">{ex.segmentCount} segments · {ex.totalTicks} ticks</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowBulkGenerateModal(true)} className="cursor-pointer text-xs">⚡ Generate Batch…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowKeyboardShortcuts(true)} className="cursor-pointer text-xs">⌨️ Keyboard Shortcuts</DropdownMenuItem>
            <DropdownMenuItem asChild className="cursor-pointer text-xs">
              <Link href="/settings">⚙️ Settings…</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Breadcrumbs */}
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-slate-500">
          <span className="hidden md:inline">Workspace</span>
          <span className="hidden opacity-40 md:inline">/</span>
          <span className="hidden md:inline">Scenarios</span>
          <span className="hidden opacity-40 md:inline">/</span>
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
              className="min-w-0 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[12px] font-medium text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="group/name flex min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 text-[12px] font-medium text-slate-900 hover:bg-slate-100"
              title="Rename scenario"
            >
              <span className="truncate">{metadata.name}</span>
              <Pencil className="h-3 w-3 shrink-0 text-slate-400 opacity-0 group-hover/name:opacity-100" />
            </button>
          )}
        </div>
      </div>

      {/* CENTER: tab group */}
      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200 bg-slate-100 p-[3px]">
        <TabButton
          active={mode === 'design' && !isRunning}
          onClick={() => setMode('design')}
        >Build</TabButton>
        <TabButton
          active={mode === 'design' && isRunning}
          onClick={() => { setMode('design'); if (!isRunning) startPlayback(speed) }}
        >Run</TabButton>
        <TabButton
          active={mode === 'episodes'}
          onClick={() => setMode('episodes')}
        >Replay</TabButton>
        <TabButton
          asLink
          href="/settings"
        >Datasets</TabButton>
      </div>

      {/* RIGHT: status + speed + controls */}
      <div className="flex min-w-0 items-center justify-end gap-2">
        {/* Status pill */}
        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-slate-500">
          <span className={cn('ls-dot', isRunning ? 'ls-dot-live' : 'ls-dot-idle')} />
          <span className="hidden sm:inline">{isRunning ? 'streaming' : 'paused'}</span>
        </div>

        {/* Destinations status chip */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors',
                destOverall === 'error'
                  ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
              )}
              title="Log forwarding destinations"
            >
              <span className={cn(
                'h-1.5 w-1.5 rounded-full',
                destOverall === 'none' ? 'bg-slate-300'
                  : destOverall === 'error' ? 'bg-red-500'
                  : destOverall === 'sending' ? 'bg-blue-500 animate-pulse'
                  : 'bg-green-500',
              )} />
              <span className="hidden sm:inline">
                {destinations.length === 0 ? 'No dest.' : `${enabledDests.length}/${destinations.length} dest.`}
              </span>
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

        {/* Time multiplier segmented control */}
        <div className="hidden shrink-0 items-center gap-0.5 rounded-md border border-slate-200 bg-slate-100 p-[2px] sm:flex">
          {SPEED_OPTIONS.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => handleSpeedSelect(s)}
              className={cn(
                'rounded-[3px] px-2 py-[3px] font-mono text-[10.5px] font-semibold transition-colors',
                speed === s
                  ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.05)]'
                  : 'text-slate-500 hover:text-slate-900',
              )}
              title={`Speed ${s}×`}
            >{s}×</button>
          ))}
        </div>

        {/* Step + Reset (icon-only) */}
        <button
          type="button"
          onClick={handleStep}
          disabled={isRunning}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="Step one tick"
        >
          <StepForward className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!isRunning && tickCount === 0}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="Reset simulation"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        {/* Pause/Run primary */}
        <button
          type="button"
          onClick={handlePlayPause}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors',
            'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
          )}
          title={isRunning ? 'Pause simulation' : 'Run simulation'}
        >
          {isRunning ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{isRunning ? 'Pause' : 'Run'}</span>
          {!isRunning && speed > 1 && <FastForward className="h-3 w-3 text-slate-400" />}
        </button>

        {/* Export primary */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-blue-600 bg-blue-600 px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-blue-700"
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSaveScenario} className="cursor-pointer text-xs">
              <span className="font-mono text-[11px] text-slate-400">.json</span>
              <span className="ml-2">Save scenario</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* hidden file inputs */}
      <input ref={fileInputRef} type="file" accept=".json,.logsim.json" className="hidden" onChange={handleScenarioFileChange} />
      <input ref={episodeFileInputRef} type="file" accept=".json,.episode.json" className="hidden" onChange={handleEpisodeFileChange} />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
  asLink,
  href,
}: {
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
  asLink?: boolean
  href?: string
}) {
  const className = cn(
    'rounded-[4px] px-3 py-1 text-[12px] font-medium transition-colors',
    active
      ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.05)]'
      : 'bg-transparent text-slate-500 hover:text-slate-900',
  )
  if (asLink && href) {
    return <Link href={href} className={className}>{children}</Link>
  }
  return (
    <button type="button" onClick={onClick} className={className}>{children}</button>
  )
}
