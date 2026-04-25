'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, FastForward, Pencil, Play, RotateCcw, Square, StepForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { DESTINATION_TYPE_META } from '@/types/destinations'
import { cn } from '@/lib/utils'
import { generate, pickCriblPayload } from '@/lib/backendClient'

const FAST_FORWARD_SPEEDS = [2, 4, 8, 16]

// ── Destinations dropdown ─────────────────────────────────────────────────────

function DestinationsDropdown() {
  const {
    destinations,
    statuses,
    errors,
    toggleDestination,
  } = useDestinationsStore()

  const enabled = destinations.filter(d => d.enabled)

  // Derive overall status
  const overallStatus: 'none' | 'error' | 'sending' | 'ok' = (() => {
    if (enabled.length === 0) return 'none'
    if (enabled.some(d => statuses[d.id] === 'error'))   return 'error'
    if (enabled.some(d => statuses[d.id] === 'sending')) return 'sending'
    return 'ok'
  })()

  const dotClass = {
    none:    'bg-gray-300',
    ok:      'bg-green-500',
    sending: 'bg-blue-500 animate-pulse',
    error:   'bg-red-500',
  }[overallStatus]

  const label = destinations.length === 0
    ? 'No Destinations'
    : `${enabled.length}/${destinations.length} Destination${destinations.length !== 1 ? 's' : ''}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 gap-1.5 px-3 text-xs',
            overallStatus === 'error' && 'border-red-200 text-red-700 hover:bg-red-50',
          )}
          title="Log forwarding destinations"
        >
          <span className={cn('h-2 w-2 rounded-full shrink-0', dotClass)} />
          {label}
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[min(calc(100vw-1.5rem),18rem)]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
          Log Destinations
        </DropdownMenuLabel>

        {destinations.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-gray-400">
            No destinations configured
          </div>
        ) : (
          destinations.map(dest => {
            const status = statuses[dest.id]
            const error  = errors[dest.id]
            const meta   = DESTINATION_TYPE_META[dest.type]

            const dotCls = dest.enabled
              ? status === 'error'   ? 'bg-red-500'
              : status === 'sending' ? 'bg-blue-500 animate-pulse'
              : status === 'idle'    ? 'bg-green-500'
              : 'bg-gray-300'
              : 'bg-gray-200'

            return (
              <div key={dest.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50">
                <span className={cn('h-2 w-2 rounded-full shrink-0', dotCls)} title={error || undefined} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-medium text-gray-800 truncate">{dest.name}</span>
                    <span className="text-[9px] text-gray-400 shrink-0">{meta.icon}</span>
                  </div>
                  {status === 'error' && error && (
                    <p className="text-[10px] text-red-500 truncate">{error}</p>
                  )}
                </div>
                <Switch
                  checked={dest.enabled}
                  onCheckedChange={() => toggleDestination(dest.id)}
                  aria-label={`Toggle ${dest.name}`}
                  className="shrink-0 scale-75"
                />
                <Link
                  href={`/settings?destination=${dest.id}`}
                  className="shrink-0 rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" />
                </Link>
              </div>
            )
          })
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="text-xs cursor-pointer text-gray-600">
          <Link href="/settings">
            <span className="mr-1.5">⚙️</span> Manage Destinations…
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
const DEFAULT_SCENARIO_NAME = 'My Scenario'
const PLAY_SPEED = 1

type ActivePlaybackMode = 'play' | 'fast-forward' | null

function toTitleCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

export function SimulationControls() {
  const {
    status,
    tickCount,
    speed,
    simulatedTime,
    setStatus,
    setSpeed,
    setTickCount,
    setSimulatedTime,
    addLogs,
    setActiveConnections,
    clearActiveConnections,
    clearLogs,
    setWorker,
  } = useSimulationStore()
  const { nodes, edges, metadata, setMetadata } = useScenarioStore()
  const { destinations, setStatus: setDestStatus, recordSent } = useDestinationsStore()
  const workerRef = useRef<Worker | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // --- Backend polling state ---
  // The frontend owns the clock. On each tick we POST a window of N simulated
  // seconds to /api/generate; the Go function runs the engine for that window
  // and (optionally) forwards the same batch to Cribl before responding.
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const simCursorRef = useRef<number>(Date.now())
  const seedRef = useRef<number>(0)
  const scenarioYamlRef = useRef<string>('')
  const destinationsRef = useRef(destinations)
  useEffect(() => { destinationsRef.current = destinations }, [destinations])

  const ensureScenarioYaml = useCallback(async (): Promise<string> => {
    if (scenarioYamlRef.current) return scenarioYamlRef.current
    const res = await fetch('/scenarios/web-service.yaml', { cache: 'force-cache' })
    if (!res.ok) throw new Error(`load scenario: HTTP ${res.status}`)
    scenarioYamlRef.current = await res.text()
    return scenarioYamlRef.current
  }, [])

  const stopBackend = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const pollOnce = useCallback(async (opts: { windowTicks: number; tickIntervalMs: number; intervalMs: number }) => {
    try {
      const yaml = await ensureScenarioYaml()
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
      if (pollRef.current !== null || abortRef.current !== null) {
        // Schedule next poll only if still running.
        if (useSimulationStore.getState().status === 'running') {
          pollRef.current = setTimeout(() => pollOnce(opts), opts.intervalMs)
        }
      }
    }
  }, [addLogs, ensureScenarioYaml, recordSent, setSimulatedTime, setStatus, setTickCount])
  const [draftScenarioName, setDraftScenarioName] = useState(metadata.name)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [activePlaybackMode, setActivePlaybackMode] = useState<ActivePlaybackMode>(null)

  useEffect(() => {
    setDraftScenarioName(metadata.name)
  }, [metadata.name])

  useEffect(() => {
    if (!isEditingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [isEditingTitle])

  // Reference still held so `nodes`/`edges` aren't treated as unused imports
  // by lint; editor state is not yet wired into backend requests (we send the
  // bundled web-service.yaml for now). Full editor → YAML round-trip is a
  // follow-up task.
  void nodes; void edges; void setActiveConnections; void setWorker

  const stopPlayback = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    setStatus('idle')
    setActivePlaybackMode(null)
  }, [clearActiveConnections, setStatus, stopBackend])

  const startPlayback = useCallback((mode: Exclude<ActivePlaybackMode, null>) => {
    const nextSpeed = mode === 'play' ? PLAY_SPEED : speed
    // Wall-clock poll interval — each call generates `nextSpeed` simulated
    // seconds, so fast-forward asks the backend for more ticks per window.
    const intervalMs = 1000
    const windowTicks = Math.max(1, Math.round(nextSpeed))
    const tickIntervalMs = 1000
    if (status !== 'running') {
      simCursorRef.current = Date.now()
      seedRef.current = Math.floor(Math.random() * 1e9)
      setStatus('running')
      // Kick an immediate poll, then start the interval.
      pollRef.current = setTimeout(() => {}, 0) // marker: running
      pollOnce({ windowTicks, tickIntervalMs, intervalMs })
    }
    setActivePlaybackMode(mode)
  }, [pollOnce, setStatus, speed, status])

  const handlePlayToggle = useCallback(() => {
    if (status === 'running' && activePlaybackMode === 'play') {
      stopPlayback()
      return
    }

    startPlayback('play')
  }, [activePlaybackMode, startPlayback, status, stopPlayback])

  const handleFastForwardToggle = useCallback(() => {
    if (status === 'running' && activePlaybackMode === 'fast-forward') {
      stopPlayback()
      return
    }

    startPlayback('fast-forward')
  }, [activePlaybackMode, startPlayback, status, stopPlayback])

  const handleStep = useCallback(async () => {
    if (status === 'running') return
    try {
      const yaml = await ensureScenarioYaml()
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
    setActivePlaybackMode(null)
  }, [addLogs, ensureScenarioYaml, recordSent, setSimulatedTime, setStatus, setTickCount, status])

  const handleReset = useCallback(() => {
    stopBackend()
    clearActiveConnections()
    clearLogs()
    setTickCount(0)
    simCursorRef.current = Date.now()
    setSimulatedTime(new Date())
    setStatus('idle')
    setActivePlaybackMode(null)
  }, [clearActiveConnections, clearLogs, setSimulatedTime, setStatus, setTickCount, stopBackend])

  const handleSpeedSelect = useCallback((nextSpeed: number) => {
    setSpeed(nextSpeed)
    if (status === 'running' && activePlaybackMode === 'fast-forward') {
      // Restart the loop with the new window size.
      stopBackend()
      pollOnce({
        windowTicks: Math.max(1, Math.round(nextSpeed)),
        tickIntervalMs: 1000,
        intervalMs: 1000,
      })
    }
  }, [activePlaybackMode, pollOnce, setSpeed, status, stopBackend])

  const commitScenarioName = useCallback((rawName: string) => {
    const nextName = toTitleCase(rawName) || DEFAULT_SCENARIO_NAME
    setDraftScenarioName(nextName)
    if (nextName !== metadata.name) {
      setMetadata({ name: nextName })
    }
    setIsEditingTitle(false)
  }, [metadata.name, setMetadata])

  const handleScenarioNameKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      commitScenarioName(event.currentTarget.value)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setDraftScenarioName(metadata.name)
      setIsEditingTitle(false)
    }
  }, [commitScenarioName, metadata.name])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      setWorker(null)
      stopBackend()
    }
  }, [setWorker, stopBackend])

  useEffect(() => {
    if (status === 'idle') {
      setActivePlaybackMode(null)
    }
  }, [status])

  const formatTime = (value: Date) => value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
      <div className="mr-2 min-w-0 max-w-full">
        {isEditingTitle ? (
          <Input
            ref={titleInputRef}
            value={draftScenarioName}
            onChange={(event) => setDraftScenarioName(event.target.value)}
            onBlur={(event) => commitScenarioName(event.target.value)}
            onKeyDown={handleScenarioNameKeyDown}
            aria-label="Scenario name"
            className="h-8 w-full max-w-[220px] border-slate-300 bg-white px-2 text-base font-semibold text-slate-900 shadow-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:text-xl"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsEditingTitle(true)}
            className="max-w-[220px] truncate rounded-md px-2 py-1 text-left text-base font-semibold text-slate-900 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:text-xl"
            title="Rename scenario"
          >
            {metadata.name}
          </button>
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="h-8 shrink-0 px-3 text-xs"
        onClick={handleStep}
        disabled={status === 'running'}
        title="Step one tick (key: 1)"
      >
        <StepForward className="size-3.5" />
        Step
      </Button>

      <Button
        variant={activePlaybackMode === 'play' ? 'destructive' : 'outline'}
        size="sm"
        className="h-8 shrink-0 px-3 text-xs"
        onClick={handlePlayToggle}
        title={activePlaybackMode === 'play' ? 'Stop simulation (key: 2)' : 'Play simulation (key: 2)'}
      >
        {activePlaybackMode === 'play' ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
        {activePlaybackMode === 'play' ? 'Stop' : 'Play'}
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="h-8 shrink-0 px-3 text-xs"
        onClick={handleReset}
        disabled={status !== 'running' && tickCount === 0}
        title="Reset simulation to tick 0"
      >
        <RotateCcw className="size-3.5" />
        Reset
      </Button>

      <div className="flex shrink-0 items-center">
        <Button
          variant={activePlaybackMode === 'fast-forward' ? 'destructive' : 'outline'}
          size="sm"
          className="h-8 rounded-r-none border-r-0 px-3 text-xs"
          onClick={handleFastForwardToggle}
          title={activePlaybackMode === 'fast-forward' ? `Stop fast forward (${speed}x)` : `Fast forward at ${speed}x`}
        >
          {activePlaybackMode === 'fast-forward' ? <Square className="size-3.5" /> : <FastForward className="size-3.5" />}
          {activePlaybackMode === 'fast-forward' ? 'Stop' : 'Fast Forward'}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-l-none px-2 text-xs"
              title="Choose fast forward speed"
            >
              <span className="text-[10px] font-semibold text-slate-600">{speed}x</span>
              <ChevronDown className="size-3.5 text-slate-500" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
              Playback speed
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(speed)} onValueChange={(value) => handleSpeedSelect(Number(value))}>
              {FAST_FORWARD_SPEEDS.map(option => (
                <DropdownMenuRadioItem key={option} value={String(option)} className="cursor-pointer text-xs">
                  {option}x
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <DestinationsDropdown />

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <div
          className={cn(
            'rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
            status === 'running'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-slate-50 text-slate-600'
          )}
        >
          {status === 'running' ? 'Running' : 'Ready'}
        </div>

        <div className="hidden text-right sm:block">
          <div className="text-[10px] text-gray-400">Tick: {tickCount}</div>
          <div className="font-mono text-[9px] text-gray-400">{formatTime(simulatedTime)}</div>
        </div>
      </div>
    </div>
  )
}
