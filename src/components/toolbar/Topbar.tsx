'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Settings,
  StepForward,
  Terminal,
  Trash2,
} from 'lucide-react'
import { materializeProposedScenarioJson } from '@/lib/scenarioPrompt'
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
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { useScenarioLibraryStore, type SavedScenario } from '@/store/useScenarioLibraryStore'
import { serializeScenario, deserializeScenario, downloadJson } from '@/lib/serialization'
import type { Connection } from '@/types/connections'
import { scenarioToFlow } from '@/lib/flow-data'
import { cn } from '@/lib/utils'
import { pickCriblPayload } from '@/lib/backendClient'
import { canvasToScenarioYaml } from '@/lib/canvasToScenarioYaml'
import { runStream } from '@/lib/runStream'
import { runForward, type ForwardSummary, type PostFrame } from '@/lib/runForward'
import { logsAt } from '@/lib/logsAt'
import { deleteDb, newSearchDbCode } from '@/lib/searchClient'
import { ExportPreviewModal, type ExportTab } from '@/components/toolbar/ExportPreviewModal'
import { RunLocallyModal } from '@/components/toolbar/RunLocallyModal'

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

interface PresetScenarioManifestEntry {
  file: string
  title: string
  description: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard' | string
  durationTicks: number
  serviceCount: number
}

interface PresetScenarioGroup {
  id: string
  label: string
  description?: string
  order?: number
}

const FALLBACK_GROUPS: PresetScenarioGroup[] = [
  { id: 'incident', label: 'Production Incidents', order: 1 },
  { id: 'deploy',   label: 'Deploys & Releases',  order: 2 },
  { id: 'security', label: 'External Threats',    order: 3 },
  { id: 'insider',  label: 'Insider & Abuse',     order: 4 },
  { id: 'cloud',    label: 'Cloud & Identity',    order: 5 },
  { id: 'baseline', label: 'Baselines',           order: 6 },
]

const GROUP_DOT: Record<string, string> = {
  security: 'bg-rose-500',
  incident: 'bg-amber-500',
  deploy:   'bg-violet-500',
  insider:  'bg-emerald-500',
  cloud:    'bg-sky-500',
  baseline: 'bg-slate-400',
}

const DIFFICULTY_TINT: Record<string, string> = {
  easy:   'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-800',
  hard:   'bg-rose-100 text-rose-700',
}

export function Topbar() {
  const { nodes, edges, metadata, setMetadata, loadScenario } = useScenarioStore()
  const setNewScenarioModalOpen = useUIStore(s => s.setNewScenarioModalOpen)
  const setModifyPanelOpen = useUIStore(s => s.setModifyPanelOpen)
  const setLogPanelOpen = useUIStore(s => s.setLogPanelOpen)
  const setCanvasOpen = useUIStore(s => s.setCanvasOpen)
  const episode = useEpisodeStore(s => s.episode)
  const setEpisode = useEpisodeStore(s => s.setEpisode)
  const setTick = useEpisodeStore(s => s.setTick)
  const setRunStatus = useEpisodeStore(s => s.setRunStatus)
  const {
    status,
    forwardDuringRealtime,
    setForwardDuringRealtime,
    selectedDestinationId,
    setSelectedDestinationId,
    tickCount,
    setStatus,
    setTickCount,
    setSimulatedTime,
    addLogs,
    clearActiveConnections,
    clearLogs,
    logBuffer,
    outputFormat,
    setRunError,
    forwardStarted,
    forwardProgress,
    forwardErrorLine,
    forwardFinished,
    forwardFailed,
    forwardStatus,
    dbCode,
    setDbCode,
    setDbStartTimeMs,
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
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  // The scenario name renders inline on desktop and on a second row on mobile;
  // the visible input wins the ref so focus targets the right element.
  const setTitleInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el && el.offsetParent !== null) {
      titleInputRef.current = el
    }
  }, [])

  const [draftName, setDraftName] = useState(metadata.name)
  const [editingTitle, setEditingTitle] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  // Recent scenarios from the persistent library (newest first).
  const recentScenarios = useScenarioLibraryStore(s => s.scenarios)
  const currentScenarioId = useScenarioLibraryStore(s => s.currentId)

  // Example scenarios — manifest is fetched lazily the first time the user
  // opens the Examples submenu, so the dropdown stays cheap to mount.
  const [presets, setPresets] = useState<PresetScenarioManifestEntry[]>([])
  const [presetGroups, setPresetGroups] = useState<PresetScenarioGroup[]>(FALLBACK_GROUPS)
  const [presetsLoaded, setPresetsLoaded] = useState(false)
  const [presetsError, setPresetsError] = useState<string | null>(null)

  const loadPresetsManifest = useCallback(async () => {
    if (presetsLoaded) return
    try {
      const res = await fetch('/scenarios/presets/index.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (Array.isArray(json)) {
        setPresets(json)
      } else if (json && Array.isArray(json.scenarios)) {
        setPresets(json.scenarios)
        if (Array.isArray(json.groups) && json.groups.length > 0) {
          setPresetGroups(json.groups)
        }
      }
    } catch (err) {
      setPresetsError(err instanceof Error ? err.message : String(err))
    } finally {
      setPresetsLoaded(true)
    }
  }, [presetsLoaded])

  const groupedPresets = useMemo(() => {
    const buckets = new Map<string, PresetScenarioManifestEntry[]>()
    for (const p of presets) {
      const list = buckets.get(p.category) ?? []
      list.push(p)
      buckets.set(p.category, list)
    }
    const known = presetGroups
      .map(g => ({ group: g, items: buckets.get(g.id) ?? [] }))
      .filter(b => b.items.length > 0)
    const knownIds = new Set(presetGroups.map(g => g.id))
    const unknown = Array.from(buckets.keys())
      .filter(id => !knownIds.has(id))
      .map(id => ({
        group: { id, label: id.charAt(0).toUpperCase() + id.slice(1) } as PresetScenarioGroup,
        items: buckets.get(id) ?? [],
      }))
    return [...known, ...unknown]
  }, [presets, presetGroups])

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

  // Autosave writes the current canvas + timeline as a single library entry,
  // so reloading the editor restores both. Reads from zustand getState() so
  // it picks up scenarios loaded in the same tick (no stale React closure).
  const persistAutosave = useCallback(() => {
    if (typeof window === 'undefined') return
    const scenarioState = useScenarioStore.getState()
    if (scenarioState.nodes.length === 0) return
    const scenario = serializeScenario(
      scenarioState.nodes.map(n => n.data),
      scenarioState.edges.map(e => e.data!).filter(Boolean) as Connection[],
      scenarioState.metadata,
    )
    const ep = useEpisodeStore.getState().episode
    const lib = useScenarioLibraryStore.getState()
    let id = lib.currentId
    if (!id) {
      id = lib.startNew()
    }
    const existing = lib.getById(id)
    const now = new Date().toISOString()
    lib.upsert({
      id,
      name: scenarioState.metadata.name,
      scenario,
      episode: ep,
      savedAt: now,
      createdAt: existing?.createdAt ?? now,
    })
  }, [])

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
        const { flowNodes, flowEdges } = scenarioToFlow(scenario)
        // Imported scenarios become a fresh library entry so autosave doesn't
        // overwrite whatever the user was editing before.
        useScenarioLibraryStore.getState().startNew()
        loadScenario(flowNodes, flowEdges, scenario.metadata)
        window.dispatchEvent(new CustomEvent('logsim-autosave'))
      } catch (err) {
        alert('Failed to load scenario: ' + String(err))
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }, [loadScenario])

  const handleNewScenario = useCallback(() => {
    setNewScenarioModalOpen(true)
  }, [setNewScenarioModalOpen])

  const handleLoadFromLibrary = useCallback((entry: SavedScenario) => {
    try {
      const { flowNodes, flowEdges } = scenarioToFlow(entry.scenario)
      useScenarioLibraryStore.getState().setCurrentId(entry.id)
      loadScenario(flowNodes, flowEdges, entry.scenario.metadata)
      setEpisode(entry.episode)
      // Bump savedAt so this entry jumps back to the top of Recent.
      window.dispatchEvent(new CustomEvent('logsim-autosave'))
    } catch (err) {
      alert('Failed to load scenario: ' + String(err))
    }
  }, [loadScenario, setEpisode])

  const handleLoadExample = useCallback(async (entry: PresetScenarioManifestEntry) => {
    try {
      const res = await fetch(`/scenarios/presets/${entry.file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const result = materializeProposedScenarioJson(json)
      const now = new Date().toISOString()
      // Each preset load opens a fresh library entry so it shows up under
      // "Recent" once the user starts editing it.
      useScenarioLibraryStore.getState().startNew()
      loadScenario(result.flowNodes, result.flowEdges, {
        name: result.name?.trim() || entry.title,
        description: result.description?.trim() || entry.description,
        createdAt: now,
        updatedAt: now,
      })
      if (result.episode) setEpisode(result.episode)
      // Capture the post-load YAML so Run-locally can detect whether the user
      // has since modified the canned scenario. Done after both stores have
      // settled so the snapshot matches what the modal will compute later.
      const slug = entry.file.replace(/\.scenario\.json$/, '')
      const sc = useScenarioStore.getState()
      const ep = useEpisodeStore.getState().episode
      const pristineYaml = canvasToScenarioYaml(sc.nodes, sc.edges, sc.metadata, {
        episode: ep,
        tickIntervalMs: 1000,
      })
      sc.markPresetOrigin(slug, pristineYaml)
      window.dispatchEvent(new CustomEvent('logsim-autosave'))
      // Reflect the loaded preset in the address bar so the URL is shareable.
      // Use history.replaceState (not Next router) so we don't trigger a route
      // transition that would dismount the editor and re-fetch the preset.
      window.history.replaceState(null, '', `/s/${slug}`)
    } catch (err) {
      alert(`Failed to load preset scenario: ${String(err)}`)
    }
  }, [loadScenario, setEpisode])

  const handleDeleteFromLibrary = useCallback((entry: SavedScenario, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(`Delete "${entry.name}" from your recent scenarios?`)) return
    useScenarioLibraryStore.getState().remove(entry.id)
  }, [])

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

  /** Common UI prep that both run paths share: open the log panel, collapse
   *  the canvas on mobile, and clear stale state from the previous run.
   *  Also fire-and-forget deletes any prior search db — the next play
   *  creates a fresh one. */
  const prepRunChrome = useCallback(() => {
    setModifyPanelOpen(false)
    setLogPanelOpen(true)
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      setCanvasOpen(false)
    }
    clearLogs()
    if (dbCode) {
      // Fire-and-forget — no need to block UI on cleanup. If the daemon's
      // gone (cold function instance), 404s are silently ignored by the
      // searchClient.
      void deleteDb(dbCode).catch(() => {})
      setDbCode(null)
      setDbStartTimeMs(null)
    }
    setRunError(null)
    setTick(0)
    setTickCount(0)
    setStatus('running')
    setRunStatus('running')
  }, [clearLogs, dbCode, setCanvasOpen, setDbCode, setDbStartTimeMs, setLogPanelOpen, setModifyPanelOpen, setRunError, setRunStatus, setStatus, setTick, setTickCount])

  /** Realtime playback: paces the scrubber 1 tick/sec wall-clock so an
   *  N-tick scenario takes N seconds. Forwards to the configured destination
   *  only when the user has toggled `forwardDuringRealtime` on.
   *
   *  Also creates a fresh search-daemon db at play start and ingests every
   *  tick's logs into it (fire-and-forget HEC POST). The db code lives in
   *  the simulation store so other components can query the daemon for
   *  historical events without going through `logBuffer`. */
  const startRealtime = useCallback(() => {
    if (status === 'running') return
    prepRunChrome()
    const enabledCribl = destinationsRef.current.find(d => d.enabled && d.type === 'cribl-hec')
    const cribl = forwardDuringRealtime ? pickCriblPayload(destinationsRef.current) : undefined

    const yaml = buildScenarioYaml()
    const ep = useEpisodeStore.getState().episode
    const simStart = Date.now()
    simCursorRef.current = simStart
    seedRef.current = Math.floor(Math.random() * 1e9)
    if (enabledCribl && forwardDuringRealtime) setDestStatus(enabledCribl.id, 'sending')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Mint a search-daemon db code locally — the daemon's ingest endpoint
    // auto-creates the db on first event, so we don't need a round-trip
    // to POST /dbs first. Picking the code client-side also means /api/run
    // has it ready in the very first chunk request. Stash simStart so the
    // scrubber can convert tick indices back to wall-clock for /get_raw.
    const runDbCode = newSearchDbCode()
    setDbCode(runDbCode)
    setDbStartTimeMs(simStart)

    runStream({
      scenarioYaml: yaml,
      duration: ep.duration,
      tickIntervalMs: 1000,
      startTimeMs: simStart,
      startTick: 0,
      seed: seedRef.current,
      paceMs: 1000,
      cribl,
      format: outputFormat,
      searchDBCode: runDbCode,
      signal: ctrl.signal,
      onTick: ({ tick: t, logs }) => {
        setTick(t + 1)
        setTickCount(t + 1)
        setSimulatedTime(new Date(simStart + (t + 1) * 1000))
        // Server-side tee handles persistence to /api/search; the live
        // view still pulls from the in-memory logBuffer for snappy render.
        if (logs.length) addLogs(logs)
      },
      onDone: ({ totalLogs }) => {
        if (enabledCribl && forwardDuringRealtime) {
          if (totalLogs > 0) recordSent(enabledCribl.id, totalLogs)
          else setDestStatus(enabledCribl.id, 'idle')
        }
        abortRef.current = null
        setStatus('idle')
        setRunStatus('idle')
      },
      onError: (err) => {
        console.error('run stream error:', err)
        setRunError(err.message)
        if (enabledCribl && forwardDuringRealtime) setDestStatus(enabledCribl.id, 'error', err.message)
        abortRef.current = null
        setStatus('idle')
        setRunStatus('idle')
      },
    })
  }, [addLogs, buildScenarioYaml, forwardDuringRealtime, outputFormat, prepRunChrome, recordSent, setDbCode, setDestStatus, setRunError, setRunStatus, setSimulatedTime, setStatus, setTick, setTickCount, status])

  /** "Run and Forward": runs the scenario flat-out on the backend and ships
   *  every event to the chosen destination. Resolves the destination from
   *  `selectedDestinationId` when set, otherwise uses the first enabled. */
  const startForward = useCallback(() => {
    if (status === 'running') return
    const enabledCribls = destinationsRef.current.filter(d => d.enabled && d.type === 'cribl-hec')
    const target = enabledCribls.find(d => d.id === selectedDestinationId) ?? enabledCribls[0]
    if (!target) {
      // Button should be disabled in this case — defensive fallback only.
      setRunError('Add and enable a Cribl HEC destination to forward events.')
      return
    }
    const cribl = pickCriblPayload([target])
    if (!cribl) return

    prepRunChrome()
    const yaml = buildScenarioYaml()
    const ep = useEpisodeStore.getState().episode
    const simStart = Date.now()
    simCursorRef.current = simStart
    seedRef.current = Math.floor(Math.random() * 1e9)
    setDestStatus(target.id, 'sending')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Forward mode also populates a search db so the editor can scrub
    // through the events that were just shipped to the destination.
    const runDbCode = newSearchDbCode()
    setDbCode(runDbCode)
    setDbStartTimeMs(simStart)

    forwardStarted({ destination: target.name || target.url, duration: ep.duration })
    runForward({
      scenarioYaml: yaml,
      duration: ep.duration,
      tickIntervalMs: 1000,
      startTimeMs: simStart,
      seed: seedRef.current,
      cribl,
      format: outputFormat,
      searchDBCode: runDbCode,
      signal: ctrl.signal,
      onStart: () => { /* status already initialized via forwardStarted */ },
      onPost: (post) => {
        if (post.err || post.status >= 400) {
          const suffix = !post.final ? ' — retrying'
            : (post.status >= 400 && post.status < 500 ? ' — dropped' : ' — gave up')
          const head = post.status > 0 ? `${post.status}` : 'ERR'
          forwardErrorLine(`POST → ${head} ${post.err ?? ''} (${post.size} events, ${post.durationMs}ms)${suffix}`)
        }
      },
      onProgress: ({ tick: t, eventsProduced, eventsSent }) => {
        setTick(t)
        setTickCount(eventsSent)
        setSimulatedTime(new Date(simStart + t * 1000))
        forwardProgress({ tick: t, eventsProduced, eventsSent })
      },
      onDone: (summary: ForwardSummary) => {
        forwardFinished(summary)
        if (summary.eventsSent > 0) recordSent(target.id, summary.eventsSent)
        if (summary.batchesFailed > 0) {
          setDestStatus(target.id, 'error', `${summary.batchesFailed} batch(es) failed`)
        } else {
          setDestStatus(target.id, 'idle')
        }
        setTickCount(summary.eventsSent)
        abortRef.current = null
        setStatus('idle')
        setRunStatus('idle')
      },
      onError: (err) => {
        console.error('run forward error:', err)
        forwardFailed(err.message)
        setRunError(err.message)
        setDestStatus(target.id, 'error', err.message)
        abortRef.current = null
        setStatus('idle')
        setRunStatus('idle')
      },
    })
  }, [buildScenarioYaml, forwardErrorLine, forwardFailed, forwardFinished, forwardProgress, forwardStarted, outputFormat, prepRunChrome, recordSent, selectedDestinationId, setDbCode, setDestStatus, setRunError, setRunStatus, setSimulatedTime, setStatus, setTick, setTickCount, status])

  const stopPlayback = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    setStatus('idle')
    setRunStatus('stopped')
  }, [clearActiveConnections, setRunStatus, setStatus, stopBackend])

  const handleRunToggle = useCallback(() => {
    if (status === 'running') stopPlayback()
    else startRealtime()
  }, [startRealtime, status, stopPlayback])

  const handleForwardToggle = useCallback(() => {
    if (status === 'running') stopPlayback()
    else startForward()
  }, [startForward, status, stopPlayback])

  const handleStep = useCallback(async () => {
    if (status === 'running') return
    try {
      const yaml = buildScenarioYaml()
      const startMs = simCursorRef.current || Date.now()
      const tickIdx = useEpisodeStore.getState().tick
      const from = Math.max(0, Math.floor(tickIdx))
      const to = from + 1
      // Step lazy-creates a search db on first use so subsequent ticks
      // accumulate in the same code. Server-side tee in /api/logs_at does
      // the actual ingest.
      let code = dbCode
      if (!code) {
        code = newSearchDbCode()
        setDbCode(code)
        setDbStartTimeMs(startMs)
      }
      const result = await logsAt({
        scenarioYaml: yaml,
        from,
        to,
        tickIntervalMs: 1000,
        startTimeMs: startMs,
        seed: (seedRef.current ||= Math.floor(Math.random() * 1e9)) + 1,
        format: outputFormat,
        searchDBCode: code,
        // Step always re-runs the engine (different seed per step). The
        // daemon db is the *destination* for these logs, not a source.
        dbCode: null,
      })
      simCursorRef.current = startMs + 1000
      if (result.length) addLogs(result)
      setTick(to)
      setTickCount(to)
      setSimulatedTime(new Date(startMs + 1000))
    } catch (err) {
      console.error('step failed:', err)
    }
  }, [addLogs, buildScenarioYaml, dbCode, outputFormat, setDbCode, setDbStartTimeMs, setSimulatedTime, setTick, setTickCount, status])

  const handleReset = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    clearLogs()
    if (dbCode) {
      void deleteDb(dbCode).catch(() => {})
      setDbCode(null)
      setDbStartTimeMs(null)
    }
    setTickCount(0)
    setTick(0)
    simCursorRef.current = Date.now()
    setSimulatedTime(new Date())
    setStatus('idle')
    setRunStatus('idle')
  }, [clearActiveConnections, clearLogs, dbCode, setDbCode, setDbStartTimeMs, setRunStatus, setSimulatedTime, setStatus, setTick, setTickCount, stopBackend])

  useEffect(() => () => stopBackend(), [stopBackend])

  // ── Title editing ───────────────────────────────────────────────
  const commitName = useCallback((raw: string) => {
    const next = raw.trim() || 'My Scenario'
    if (next !== metadata.name) {
      setMetadata({ name: next })
      const lib = useScenarioLibraryStore.getState()
      if (lib.currentId) lib.renameById(lib.currentId, next)
    }
    setDraftName(next)
    setEditingTitle(false)
  }, [metadata.name, setMetadata])

  // ── Exports ─────────────────────────────────────────────────────
  const downloadText = useCallback((text: string, filename: string, mime: string) => {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleExportLog = useCallback(() => {
    downloadText(logBuffer.map(l => l.raw).join('\n'), 'logs.log', 'text/plain')
  }, [downloadText, logBuffer])

  const handleExportJsonl = useCallback(() => {
    downloadText(logBuffer.map(l => JSON.stringify(l)).join('\n'), 'logs.jsonl', 'application/jsonl')
  }, [downloadText, logBuffer])

  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [exportModalTab, setExportModalTab] = useState<ExportTab>('yaml')
  const openExportModal = useCallback((tab: ExportTab) => {
    setExportModalTab(tab)
    setExportModalOpen(true)
  }, [])
  const [runLocallyOpen, setRunLocallyOpen] = useState(false)

  // ── Derived ─────────────────────────────────────────────────────
  const isRunning = status === 'running'
  const enabledDests = destinations.filter(d => d.enabled)
  // Cribl HEC subset specifically — these are the destinations the
  // forward path can ship to. Other destination types (when added)
  // won't show up here until they wire through `runForward`.
  const allCriblDests = destinations.filter(d => d.type === 'cribl-hec')
  const enabledCriblDests = allCriblDests.filter(d => d.enabled)
  const forwardTargetDest =
    enabledCriblDests.find(d => d.id === selectedDestinationId) ??
    enabledCriblDests[0] ?? null
  // ── Render ──────────────────────────────────────────────────────
  const scenarioNameEditor = editingTitle ? (
    <input
      ref={setTitleInputRef}
      value={draftName}
      onChange={e => setDraftName(e.target.value)}
      onBlur={e => commitName(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') commitName(draftName)
        if (e.key === 'Escape') { setDraftName(metadata.name); setEditingTitle(false) }
      }}
      className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[13px] font-medium text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
    />
  ) : (
    <button
      type="button"
      onClick={() => setEditingTitle(true)}
      className="group/name flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-[13px] font-medium text-slate-900 transition-colors hover:bg-slate-100"
      title="Rename scenario"
    >
      <span className="truncate">{metadata.name}</span>
      <Pencil className="h-3 w-3 shrink-0 text-slate-400 opacity-0 transition-opacity group-hover/name:opacity-100" />
    </button>
  )

  return (
    <>
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
          <DropdownMenuContent align="start" className="w-48 text-xs">
            <DropdownMenuItem
              onClick={() => setAboutOpen(true)}
              className="cursor-pointer text-xs"
            >
              <Info className="mr-2 h-3.5 w-3.5 text-slate-500" />
              About
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="cursor-pointer text-xs">
              <Link href="/run-locally">
                <Terminal className="mr-2 h-3.5 w-3.5 text-slate-500" />
                Run locally with the CLI…
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer text-xs">
              <Link href="/settings">
                <Settings className="mr-2 h-3.5 w-3.5 text-slate-500" />
                Settings…
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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
            <DropdownMenuItem onClick={handleNewScenario} className="cursor-pointer text-xs">
              📄 New Scenario…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenScenario} className="cursor-pointer text-xs">📂 Open Scenario…</DropdownMenuItem>
            <DropdownMenuItem onClick={handleSaveScenario} className="cursor-pointer text-xs">💾 Save Scenario  ⌘S</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                disabled={recentScenarios.length === 0}
                className="cursor-pointer text-xs data-[disabled]:opacity-50"
              >
                🕘 Recent Scenarios
                {recentScenarios.length > 0 && (
                  <span className="ml-auto text-[10px] text-slate-400">{recentScenarios.length}</span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-w-sm text-xs">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                  Saved in this browser
                </DropdownMenuLabel>
                {recentScenarios.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">No recent scenarios.</div>
                ) : (
                  recentScenarios.map(entry => {
                    const isCurrent = entry.id === currentScenarioId
                    const services = entry.scenario.nodes.filter(n => n.type === 'service').length
                    const beats = entry.episode.narrative?.length ?? 0
                    const blockCount = entry.episode.lanes
                      ? Object.values(entry.episode.lanes).reduce((sum, blocks) => sum + (blocks?.length ?? 0), 0)
                      : 0
                    return (
                      <DropdownMenuItem
                        key={entry.id}
                        onSelect={() => handleLoadFromLibrary(entry)}
                        className="group/recent flex cursor-pointer items-start gap-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{entry.name || 'Untitled'}</span>
                            {isCurrent && (
                              <span className="rounded bg-blue-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-blue-700">
                                Current
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {services} services · {blockCount} blocks · {beats} beats · {fmtRelativeTime(entry.savedAt)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => handleDeleteFromLibrary(entry, e)}
                          className="shrink-0 rounded p-1 text-slate-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover/recent:opacity-100"
                          title="Delete"
                          aria-label={`Delete ${entry.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </DropdownMenuItem>
                    )
                  })
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                onPointerEnter={loadPresetsManifest}
                onFocus={loadPresetsManifest}
                onPointerDown={loadPresetsManifest}
                className="cursor-pointer text-xs"
              >
                📚 Example Scenarios
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                collisionPadding={12}
                className="max-h-[70dvh] w-[min(18rem,calc(100vw-1.5rem))] overflow-y-auto text-xs"
              >
                <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                  Browse by category
                </DropdownMenuLabel>
                {!presetsLoaded ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">Loading…</div>
                ) : presetsError ? (
                  <div className="px-2 py-1.5 text-[11px] text-rose-600">Failed: {presetsError}</div>
                ) : groupedPresets.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-slate-400">No example scenarios found.</div>
                ) : (
                  groupedPresets.map(({ group, items }) => (
                    <DropdownMenuSub key={group.id}>
                      <DropdownMenuSubTrigger className="cursor-pointer text-xs">
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            <span
                              className={cn('inline-block h-2 w-2 rounded-full', GROUP_DOT[group.id] ?? 'bg-slate-400')}
                              aria-hidden
                            />
                            {group.label}
                          </span>
                          <span className="text-[10px] text-slate-400">{items.length}</span>
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        collisionPadding={12}
                        className="max-h-[70dvh] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto text-xs"
                      >
                        {group.description && (
                          <DropdownMenuLabel className="whitespace-normal text-[10px] leading-tight text-slate-500">
                            {group.description}
                          </DropdownMenuLabel>
                        )}
                        {items.map(p => (
                          <DropdownMenuItem
                            key={p.file}
                            onSelect={() => handleLoadExample(p)}
                            className="flex cursor-pointer flex-col items-start gap-0.5 text-xs"
                          >
                            <span className="flex items-center gap-1.5 font-medium">
                              <span className="truncate">{p.title}</span>
                              <span className={cn(
                                'shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide',
                                DIFFICULTY_TINT[p.difficulty] ?? 'bg-slate-100 text-slate-700',
                              )}>{p.difficulty}</span>
                            </span>
                            <span className="line-clamp-2 whitespace-normal text-[10px] leading-tight text-slate-500">
                              {p.description}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {p.serviceCount} services · {Math.round(p.durationTicks / 60)} min
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Subtle separator */}
        <span className="hidden h-4 w-px bg-slate-200 sm:inline-block" aria-hidden />

        {/* Scenario name (inline on desktop; mobile renders it on a second row below) */}
        <div className="hidden min-w-0 items-center sm:flex">
          {scenarioNameEditor}
        </div>
      </div>

      {/* RIGHT: format + transport tray + export */}
      <div className="flex shrink-0 items-center gap-2">
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
            onClick={handleRunToggle}
            className={cn(
              'inline-flex h-full items-center gap-1.5 pl-3 pr-2 text-[12px] font-medium transition-colors',
              isRunning
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'text-slate-700 hover:bg-slate-50',
            )}
            title={
              isRunning
                ? 'Stop simulation'
                : forwardDuringRealtime && enabledCriblDests.length > 0
                  ? `Play in real time and forward each event to ${enabledCriblDests[0].name || 'the configured destination'}`
                  : 'Play in real time — an N-tick scenario takes N seconds'
            }
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
          {!isRunning && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-full w-6 items-center justify-center border-l border-slate-200 transition-colors hover:bg-slate-50 hover:text-slate-900',
                    forwardDuringRealtime && enabledCriblDests.length > 0
                      ? 'text-emerald-600'
                      : 'text-slate-500',
                  )}
                  title={
                    forwardDuringRealtime
                      ? 'Forwarding is on — click to change'
                      : 'Run options'
                  }
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 text-xs">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Run options
                </DropdownMenuLabel>
                <button
                  type="button"
                  disabled={enabledCriblDests.length === 0}
                  onClick={() => setForwardDuringRealtime(!forwardDuringRealtime)}
                  className={cn(
                    'flex w-full items-start gap-2 px-2 py-2 text-left transition-colors hover:bg-slate-50',
                    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                      forwardDuringRealtime && enabledCriblDests.length > 0
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-slate-300 bg-white',
                    )}
                  >
                    {forwardDuringRealtime && enabledCriblDests.length > 0 && (
                      <Check className="h-2.5 w-2.5" />
                    )}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-slate-900">
                      Forward to destination during run
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {enabledCriblDests.length === 0
                        ? 'Add a Cribl HEC destination to enable.'
                        : `Ships every event to ${enabledCriblDests[0].name || 'the destination'} as it plays.`}
                    </span>
                  </span>
                </button>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Forward logs — backend ships events flat-out to the chosen
            destination. The chevron is always present: with destinations
            it's a picker, without any it's the path to settings. */}
        <div
          className={cn(
            'inline-flex h-8 shrink-0 items-center overflow-hidden rounded-lg border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors',
            isRunning && forwardStatus ? 'border-emerald-200' : 'border-slate-200',
          )}
        >
          <button
            type="button"
            onClick={handleForwardToggle}
            disabled={enabledCriblDests.length === 0 || (isRunning && !forwardStatus)}
            className={cn(
              'inline-flex h-full items-center gap-1.5 pl-3 pr-2 text-[12px] font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
              isRunning && forwardStatus
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'text-slate-700 hover:bg-slate-50',
            )}
            title={
              enabledCriblDests.length === 0
                ? 'Add a destination in Settings to enable forwarding'
                : isRunning && forwardStatus
                  ? 'Stop forwarding'
                  : `Forward every event to ${forwardTargetDest?.name ?? 'destination'} as fast as possible`
            }
          >
            {isRunning && forwardStatus ? (
              <>
                <Pause className="h-3.5 w-3.5 fill-current" />
                <span className="hidden sm:inline">Stop</span>
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span className="hidden max-w-[180px] truncate sm:inline">
                  {forwardTargetDest
                    ? `Forward to ${forwardTargetDest.name}`
                    : 'Forward logs'}
                </span>
              </>
            )}
          </button>
          {!isRunning && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-full w-6 items-center justify-center border-l border-slate-200 transition-colors hover:bg-slate-50 hover:text-slate-900',
                    enabledCriblDests.length === 0 ? 'text-amber-600' : 'text-slate-500',
                  )}
                  title={
                    enabledCriblDests.length === 0
                      ? 'No destination configured — open Settings'
                      : 'Pick destination'
                  }
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80 text-xs">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Forward to
                </DropdownMenuLabel>

                {allCriblDests.length === 0 ? (
                  <div className="px-3 py-3 space-y-1">
                    <p className="text-[12px] leading-snug text-slate-700">
                      No destinations configured.
                    </p>
                    <p className="text-[11px] leading-snug text-slate-500">
                      Add a Cribl HEC destination in Settings to enable
                      forwarding.
                    </p>
                  </div>
                ) : (
                  allCriblDests.map(d => {
                    const s = destStatuses[d.id]
                    const err = destErrors[d.id]
                    const isSelected = forwardTargetDest?.id === d.id
                    const dotCls = !d.enabled
                      ? 'bg-slate-300'
                      : s === 'error' ? 'bg-red-500'
                        : s === 'sending' ? 'bg-blue-500 animate-pulse'
                          : s === 'idle' ? 'bg-emerald-500'
                            : 'bg-slate-300'
                    return (
                      <div
                        key={d.id}
                        className={cn(
                          'flex items-start gap-2 px-2 py-2',
                          d.enabled && 'transition-colors hover:bg-slate-50',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => d.enabled && setSelectedDestinationId(d.id)}
                          disabled={!d.enabled}
                          className={cn(
                            'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
                            'disabled:cursor-not-allowed',
                            isSelected
                              ? 'border-emerald-500 bg-emerald-500'
                              : 'border-slate-300 bg-white hover:border-slate-400',
                          )}
                          title={d.enabled ? 'Use as forward destination' : 'Enable to use'}
                        >
                          {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => d.enabled && setSelectedDestinationId(d.id)}
                          disabled={!d.enabled}
                          className="flex min-w-0 flex-1 flex-col text-left disabled:cursor-not-allowed"
                        >
                          <span className="flex items-center gap-1.5">
                            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotCls)} title={err || undefined} />
                            <span className={cn('truncate font-medium', d.enabled ? 'text-slate-900' : 'text-slate-400')}>
                              {d.name}
                            </span>
                            {!d.enabled && (
                              <span className="shrink-0 rounded bg-slate-100 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-slate-500">
                                disabled
                              </span>
                            )}
                          </span>
                          <span className={cn('truncate text-[11px]', d.enabled ? 'text-slate-500' : 'text-slate-400')} title={d.url}>
                            {d.url}
                          </span>
                          {err && (
                            <span className="truncate text-[11px] text-red-600">{err}</span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleDestination(d.id)}
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                            d.enabled
                              ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                              : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
                          )}
                          title={d.enabled ? 'Disable destination' : 'Enable destination'}
                        >
                          {d.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    )
                  })
                )}

                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="cursor-pointer text-xs text-slate-600">
                  <Link href="/settings">
                    <Settings className="mr-2 h-3.5 w-3.5 text-slate-500" />
                    {allCriblDests.length === 0 ? 'Configure a destination…' : 'Manage destinations…'}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Export — same neutral chrome as the transport buttons so the
            toolbar reads as one row of equal-weight actions, not a blue
            CTA among greys. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-slate-50"
              title="Export dataset"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Export</span>
              <ChevronDown className="h-3 w-3 text-slate-500" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Logs ({logBuffer.length})
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
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Scenario
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openExportModal('yaml')} className="cursor-pointer text-xs">
              <span className="font-mono text-[11px] text-slate-400">.yaml</span>
              <span className="ml-2">scenario.yaml</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openExportModal('ground-truth')} className="cursor-pointer text-xs">
              <span className="font-mono text-[11px] text-slate-400">.txt</span>
              <span className="ml-2">Ground truth (SFT/RL)</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setRunLocallyOpen(true)} className="cursor-pointer text-xs">
              <Terminal className="h-3 w-3 text-slate-400" />
              <span className="ml-2">Run locally with CLI…</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    {/* Mobile-only second row: scenario name (hidden on sm+ where it sits inline) */}
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-3 sm:hidden">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Scenario</span>
      <span className="h-3 w-px bg-slate-300" aria-hidden />
      {editingTitle ? (
        <input
          ref={setTitleInputRef}
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          onBlur={e => commitName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitName(draftName)
            if (e.key === 'Escape') { setDraftName(metadata.name); setEditingTitle(false) }
          }}
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[13px] font-medium text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditingTitle(true)}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
          title="Rename scenario"
        >
          <span className="truncate text-[13px] font-medium text-slate-900">{metadata.name}</span>
          <Pencil className="h-3 w-3 shrink-0 text-slate-400" />
        </button>
      )}
    </div>

      {/* hidden file input */}
      <input ref={fileInputRef} type="file" accept=".json,.logsim.json" className="hidden" onChange={handleScenarioFileChange} />

      {/* Export preview modal */}
      <ExportPreviewModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        initialTab={exportModalTab}
        flowNodes={nodes}
        flowEdges={edges}
        metadata={metadata}
        episode={episode}
        tickIntervalMs={1000}
      />

      {/* Run locally with CLI modal */}
      <RunLocallyModal
        open={runLocallyOpen}
        onClose={() => setRunLocallyOpen(false)}
        flowNodes={nodes}
        flowEdges={edges}
        metadata={metadata}
        episode={episode}
        tickIntervalMs={1000}
      />

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
    </>
  )
}

function fmtRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

