'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square, Pencil, GitFork, RotateCcw, LayoutDashboard, Link as LinkIcon, Check, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { EpisodeTimeline } from './EpisodeTimeline'
import { SegmentEditorModal } from './SegmentEditorModal'
import { SegmentCanvasPreview } from './SegmentCanvasPreview'
import { SegmentCanvasModal } from './SegmentCanvasModal'
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
  const [canvasModalSegmentId, setCanvasModalSegmentId] = useState<string | null>(null)

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(episode.name)
  const [copied, setCopied] = useState(false)
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

  const openInCanvas = useCallback((segmentId: string) => {
    setCanvasModalSegmentId(segmentId)
  }, [])

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }, [])

  const commitTitle = () => {
    const next = draftTitle.trim() || episode.name
    setEpisodeMeta({ name: next })
    setIsEditingTitle(false)
  }

  const totalTicks = episode.segments.reduce((a, s) => a + s.ticks, 0)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      {/* Episode header with run controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 sm:px-4">
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
            className="h-8 w-full max-w-[300px] text-base font-semibold sm:text-lg"
          />
        ) : (
          <button
            onClick={() => setIsEditingTitle(true)}
            className="max-w-full truncate rounded-md px-2 py-1 text-base font-semibold text-slate-900 hover:bg-slate-100 sm:text-lg"
          >
            {episode.name}
          </button>
        )}

        <div className="text-[10px] text-slate-400">
          {episode.segments.length} seg · {totalTicks} ticks
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            onClick={copyLink}
            title="Copy link to this view (preserves episode + segment)"
          >
            {copied ? <Check className="size-3.5 text-emerald-600" /> : <LinkIcon className="size-3.5" />}
            <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy Link'}</span>
          </Button>
          <Button
            variant={runStatus === 'running' ? 'destructive' : 'outline'}
            size="sm"
            className="h-8 shrink-0 gap-1 px-3 text-xs"
            onClick={handleRun}
          >
            {runStatus === 'running' ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
            <span className="hidden sm:inline">{runStatus === 'running' ? 'Stop Episode' : 'Run Episode'}</span>
            <span className="sm:hidden">{runStatus === 'running' ? 'Stop' : 'Run'}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 px-3 text-xs"
            onClick={handleReset}
            disabled={runStatus === 'running'}
          >
            <RotateCcw className="size-3.5" />
            <span className="hidden sm:inline">Reset</span>
          </Button>
        </div>
      </div>

      {/* Timeline */}
      <EpisodeTimeline onOpenInCanvas={openInCanvas} />

      {/* Selected segment preview */}
      <div className="flex flex-1 overflow-hidden">
        {selected ? (
          <div className="flex flex-1 flex-col overflow-y-auto p-4 sm:overflow-hidden sm:p-6">
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Selected Segment</div>
                <h2 className="break-words text-lg font-semibold text-slate-900 sm:text-xl">{selected.name}</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Runs for <span className="font-mono">{selected.ticks}</span> ticks
                  (~{Math.floor(selected.ticks / 60)}m {selected.ticks % 60}s).
                  {selected.parentId && ' Forked from the previous segment.'}
                </p>
              </div>
              <div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto">
                <Button
                  variant="default"
                  size="sm"
                  className="h-8 gap-1 px-3 text-xs"
                  onClick={() => openInCanvas(selected.id)}
                  title="Edit this segment visually on the canvas"
                >
                  <LayoutDashboard className="size-3.5" />
                  <span className="hidden sm:inline">Edit in Canvas</span>
                  <span className="sm:hidden">Canvas</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 px-3 text-xs"
                  onClick={() => setEditingSegment(selected.id)}
                >
                  <Pencil className="size-3.5" />
                  <span className="hidden sm:inline">Edit YAML</span>
                  <span className="sm:hidden">YAML</span>
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

            <div className="mt-4 grid flex-1 grid-cols-1 gap-3 sm:grid-cols-5 sm:overflow-hidden">
              {/* Canvas preview — full width on mobile, 3/5 on desktop */}
              <div className="flex min-h-[260px] flex-col overflow-hidden rounded-md border border-slate-200 bg-white sm:col-span-3 sm:min-h-0">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Canvas</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">
                      {selected.canvas ? 'read-only · maximize to edit' : 'no canvas yet'}
                    </span>
                    {selected.canvas && selected.canvas.nodes.length > 0 && (
                      <button
                        type="button"
                        onClick={() => openInCanvas(selected.id)}
                        title="Maximize canvas for editing"
                        className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50"
                      >
                        <Maximize2 className="size-3" /> Maximize
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  {selected.canvas && selected.canvas.nodes.length > 0 ? (
                    <SegmentCanvasPreview key={selected.id + ':' + selected.canvas.nodes.length} snapshot={selected.canvas} />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-400">
                      <LayoutDashboard className="size-6 text-slate-300" />
                      <div>This segment has no visual canvas yet.</div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-1 h-7 gap-1 px-2 text-[11px]"
                        onClick={() => openInCanvas(selected.id)}
                      >
                        <LayoutDashboard className="size-3" /> Open in Canvas
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* YAML preview — full width on mobile, 2/5 on desktop */}
              <div className="flex min-h-[200px] flex-col overflow-hidden rounded-md border border-slate-200 bg-white sm:col-span-2 sm:min-h-0">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">scenario.yaml</span>
                  <span className="text-[10px] text-slate-400">double-click timeline to edit</span>
                </div>
                <pre className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-tight text-slate-700">
                  {selected.scenarioYaml}
                </pre>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-slate-400">
            No segment selected.
          </div>
        )}
      </div>

      <SegmentEditorModal />
      <SegmentCanvasModal
        segmentId={canvasModalSegmentId}
        onClose={() => setCanvasModalSegmentId(null)}
      />
    </div>
  )
}
