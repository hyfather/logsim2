'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square, Pencil, GitFork, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { EpisodeTimeline } from './EpisodeTimeline'
import { SegmentEditorModal } from './SegmentEditorModal'
import { runEpisode } from '@/lib/episodeRunner'

export function EpisodeMode() {
  const {
    episode,
    selectedSegmentId,
    setEditingSegment,
    forkSegment,
    setEpisodeMeta,
    runStatus,
    setRunStatus,
    setRunningSegment,
    setRunProgress,
    resetRun,
  } = useEpisodeStore()
  const { addLogs, clearLogs, setTickCount, setSimulatedTime, setStatus } = useSimulationStore()
  const { destinations, setStatus: setDestStatus, recordSent } = useDestinationsStore()
  const stopRef = useRef(false)

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(episode.name)
  useEffect(() => setDraftTitle(episode.name), [episode.name])

  const selected = episode.segments.find(s => s.id === selectedSegmentId) || episode.segments[0] || null

  const destinationsRef = useRef(destinations)
  useEffect(() => { destinationsRef.current = destinations }, [destinations])

  const handleRun = useCallback(async () => {
    if (runStatus === 'running') {
      stopRef.current = true
      setRunStatus('stopped')
      setStatus('idle')
      return
    }

    stopRef.current = false
    clearLogs()
    setTickCount(0)
    resetRun()
    setRunStatus('running')
    setStatus('running')

    let cumulativeTicks = 0
    const enabledCribl = destinationsRef.current.find(d => d.enabled && d.type === 'cribl-hec')
    const simStart = Date.now()

    await runEpisode(episode, {
      onSegmentStart: (segId) => {
        setRunningSegment(segId)
        setRunProgress(0)
      },
      onProgress: (_segId, inSeg) => {
        setRunProgress(inSeg)
        const total = cumulativeTicks + inSeg
        setTickCount(total)
        setSimulatedTime(new Date(simStart + total * 1000))
      },
      onLogs: (logs) => {
        if (logs.length) addLogs(logs)
      },
      onForwarded: (n, err) => {
        if (!enabledCribl) return
        if (err) setDestStatus(enabledCribl.id, 'error', err)
        else if (n > 0) recordSent(enabledCribl.id, n)
        else setDestStatus(enabledCribl.id, 'idle')
      },
      onSegmentEnd: (segId) => {
        const seg = episode.segments.find(s => s.id === segId)
        if (seg) cumulativeTicks += seg.ticks
      },
      onDone: () => {
        setRunStatus('idle')
        setRunningSegment(null)
        setStatus('idle')
      },
      onError: (err) => {
        console.error('episode run error:', err)
        setRunStatus('idle')
        setRunningSegment(null)
        setStatus('idle')
      },
      shouldStop: () => stopRef.current,
      getDestinations: () => destinationsRef.current,
    }, simStart)
  }, [addLogs, clearLogs, destinations, episode, recordSent, resetRun, runStatus, setDestStatus, setRunProgress, setRunStatus, setRunningSegment, setSimulatedTime, setStatus, setTickCount])

  const handleReset = useCallback(() => {
    stopRef.current = true
    resetRun()
    clearLogs()
    setTickCount(0)
    setSimulatedTime(new Date())
    setStatus('idle')
  }, [clearLogs, resetRun, setSimulatedTime, setStatus, setTickCount])

  const commitTitle = () => {
    const next = draftTitle.trim() || episode.name
    setEpisodeMeta({ name: next })
    setIsEditingTitle(false)
  }

  const totalTicks = episode.segments.reduce((a, s) => a + s.ticks, 0)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      {/* Episode header with run controls */}
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2">
        {isEditingTitle ? (
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') { setDraftTitle(episode.name); setIsEditingTitle(false) }
            }}
            autoFocus
            className="h-8 w-[300px] text-lg font-semibold"
          />
        ) : (
          <button
            onClick={() => setIsEditingTitle(true)}
            className="rounded-md px-2 py-1 text-lg font-semibold text-slate-900 hover:bg-slate-100"
          >
            {episode.name}
          </button>
        )}

        <div className="text-[10px] text-slate-400">
          {episode.segments.length} segments · {totalTicks} ticks total
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant={runStatus === 'running' ? 'destructive' : 'outline'}
            size="sm"
            className="h-8 gap-1 px-3 text-xs"
            onClick={handleRun}
          >
            {runStatus === 'running' ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
            {runStatus === 'running' ? 'Stop Episode' : 'Run Episode'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 px-3 text-xs"
            onClick={handleReset}
            disabled={runStatus === 'running'}
          >
            <RotateCcw className="size-3.5" /> Reset
          </Button>
        </div>
      </div>

      {/* Timeline */}
      <EpisodeTimeline />

      {/* Selected segment preview */}
      <div className="flex flex-1 overflow-hidden">
        {selected ? (
          <div className="flex flex-1 flex-col overflow-hidden p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Selected Segment</div>
                <h2 className="text-xl font-semibold text-slate-900">{selected.name}</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Runs for <span className="font-mono">{selected.ticks}</span> ticks
                  (~{Math.floor(selected.ticks / 60)}m {selected.ticks % 60}s).
                  {selected.parentId && ' Forked from the previous segment.'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 px-3 text-xs"
                  onClick={() => setEditingSegment(selected.id)}
                >
                  <Pencil className="size-3.5" /> Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 px-3 text-xs"
                  onClick={() => forkSegment(selected.id)}
                  title="Duplicate this segment; edit the clone to introduce errors or new infra"
                >
                  <GitFork className="size-3.5" /> Fork
                </Button>
              </div>
            </div>

            <div className="mt-4 flex-1 overflow-hidden rounded-md border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  scenario.yaml (preview)
                </span>
                <span className="text-[10px] text-slate-400">
                  double-click timeline card to edit
                </span>
              </div>
              <pre className="h-full max-h-full overflow-auto p-3 font-mono text-[11px] leading-tight text-slate-700">
                {selected.scenarioYaml}
              </pre>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-slate-400">
            No segment selected.
          </div>
        )}
      </div>

      <SegmentEditorModal />
    </div>
  )
}
