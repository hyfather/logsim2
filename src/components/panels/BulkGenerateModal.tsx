'use client'
import React, { useCallback, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useUIStore } from '@/store/useUIStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import type { LogEntry } from '@/types/logs'
import { strToU8, zipSync } from 'fflate'

const DURATION_PRESETS = [
  { label: '1 hour', ms: 3600_000 },
  { label: '6 hours', ms: 6 * 3600_000 },
  { label: '12 hours', ms: 12 * 3600_000 },
  { label: '24 hours', ms: 24 * 3600_000 },
  { label: '7 days', ms: 7 * 24 * 3600_000 },
]

type OutputFormat = 'log' | 'jsonl' | 'both'
type FileOrg = 'single' | 'by-channel'

export function BulkGenerateModal() {
  const { showBulkGenerateModal, setShowBulkGenerateModal } = useUIStore()
  const { nodes, edges, metadata } = useScenarioStore()

  const [durationMs, setDurationMs] = useState(3600_000)
  const [customDurationH, setCustomDurationH] = useState('')
  const [channelFilter, setChannelFilter] = useState('*')
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('log')
  const [fileOrg, setFileOrg] = useState<FileOrg>('single')
  const [progress, setProgress] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [complete, setComplete] = useState(false)
  const workerRef = useRef<Worker | null>(null)

  const handleGenerate = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate()
    }

    const w = new Worker(new URL('../../engine/simulation.worker.ts', import.meta.url))
    workerRef.current = w
    setGenerating(true)
    setProgress(0)
    setComplete(false)

    w.onmessage = (event) => {
      const msg = event.data
      if (msg.type === 'bulkProgress') {
        setProgress(Math.round(msg.payload.progress * 100))
      } else if (msg.type === 'bulkComplete') {
        const logs: LogEntry[] = msg.payload.logs
        setProgress(100)
        setGenerating(false)
        setComplete(true)
        w.terminate()
        workerRef.current = null

        // Build ZIP
        buildAndDownloadZip(logs, outputFormat, fileOrg, metadata.name)
      }
    }

    const scenarioNodes = nodes.map(n => n.data)
    const connections = edges.map(e => e.data!).filter(Boolean)

    w.postMessage({
      type: 'bulkGenerate',
      payload: {
        nodes: scenarioNodes,
        connections,
        durationMs,
        channelFilter,
        startTime: Date.now(),
      },
    })
  }, [nodes, edges, metadata, durationMs, channelFilter, outputFormat, fileOrg])

  const handleClose = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }
    setGenerating(false)
    setComplete(false)
    setProgress(0)
    setShowBulkGenerateModal(false)
  }, [setShowBulkGenerateModal])

  return (
    <Dialog open={showBulkGenerateModal} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold">Generate Batch Logs</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Duration presets */}
          <div>
            <Label className="text-xs font-medium text-gray-700 mb-2 block">Duration</Label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {DURATION_PRESETS.map(p => (
                <Button
                  key={p.ms}
                  variant={durationMs === p.ms ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setDurationMs(p.ms)}
                  disabled={generating}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Custom hours"
                value={customDurationH}
                onChange={e => {
                  setCustomDurationH(e.target.value)
                  const h = parseFloat(e.target.value)
                  if (!isNaN(h) && h > 0) setDurationMs(h * 3600_000)
                }}
                className="h-7 text-xs w-28"
                disabled={generating}
              />
              <span className="text-xs text-gray-400">hours</span>
            </div>
          </div>

          {/* Channel filter */}
          <div>
            <Label className="text-xs font-medium text-gray-700 mb-1 block">Channel Filter (glob)</Label>
            <Input
              value={channelFilter}
              onChange={e => setChannelFilter(e.target.value)}
              placeholder="* (all channels)"
              className="h-7 text-xs font-mono"
              disabled={generating}
            />
          </div>

          {/* Output format */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-gray-700 mb-1 block">Output Format</Label>
              <Select
                value={outputFormat}
                onValueChange={v => setOutputFormat(v as OutputFormat)}
                disabled={generating}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="log" className="text-xs">.log (plain text)</SelectItem>
                  <SelectItem value="jsonl" className="text-xs">.jsonl</SelectItem>
                  <SelectItem value="both" className="text-xs">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-medium text-gray-700 mb-1 block">File Organization</Label>
              <Select
                value={fileOrg}
                onValueChange={v => setFileOrg(v as FileOrg)}
                disabled={generating}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single" className="text-xs">Single file</SelectItem>
                  <SelectItem value="by-channel" className="text-xs">Split by channel</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Progress */}
          {(generating || complete) && (
            <div>
              <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                <span>{complete ? 'Complete!' : 'Generating...'}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" className="text-xs" onClick={handleClose}>
            {complete ? 'Close' : 'Cancel'}
          </Button>
          {!complete && (
            <Button
              size="sm"
              className="text-xs"
              onClick={handleGenerate}
              disabled={generating || nodes.length === 0}
            >
              {generating ? 'Generating...' : 'Generate'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function buildAndDownloadZip(
  logs: LogEntry[],
  format: OutputFormat,
  org: FileOrg,
  scenarioName: string
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const dirName = `logs-${scenarioName.toLowerCase().replace(/\s+/g, '-')}-${timestamp}`

  const files: Record<string, Uint8Array> = {}

  // Manifest
  const manifest = {
    generatedAt: new Date().toISOString(),
    scenarioName,
    logCount: logs.length,
    channels: Array.from(new Set(logs.map(l => l.channel))),
  }
  files[`${dirName}/manifest.json`] = strToU8(JSON.stringify(manifest, null, 2))

  if (org === 'single') {
    if (format === 'log' || format === 'both') {
      files[`${dirName}/all.log`] = strToU8(logs.map(l => l.raw).join('\n'))
    }
    if (format === 'jsonl' || format === 'both') {
      files[`${dirName}/all.jsonl`] = strToU8(logs.map(l => JSON.stringify(l)).join('\n'))
    }
  } else {
    // Group by channel
    const byChannel: Record<string, LogEntry[]> = {}
    for (const entry of logs) {
      if (!byChannel[entry.channel]) byChannel[entry.channel] = []
      byChannel[entry.channel].push(entry)
    }

    for (const [channel, channelLogs] of Object.entries(byChannel)) {
      if (format === 'log' || format === 'both') {
        files[`${dirName}/channels/${channel}.log`] = strToU8(channelLogs.map(l => l.raw).join('\n'))
      }
      if (format === 'jsonl' || format === 'both') {
        files[`${dirName}/channels/${channel}.jsonl`] = strToU8(channelLogs.map(l => JSON.stringify(l)).join('\n'))
      }
    }
  }

  // Create ZIP
  const zipped = zipSync(files, { level: 6 })
  const blob = new Blob([new Uint8Array(zipped)], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${dirName}.zip`
  a.click()
  URL.revokeObjectURL(url)
}
