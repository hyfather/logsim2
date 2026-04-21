'use client'
import React, { useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import Link from 'next/link'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import type { Episode, EpisodeFileV1 } from '@/types/episode'

interface ExampleEpisodeManifestEntry {
  file: string
  title: string
  description: string
  segmentCount: number
  totalTicks: number
}
import { useSimulationStore } from '@/store/useSimulationStore'
import { serializeScenario, deserializeScenario } from '@/lib/serialization'
import { downloadJson } from '@/lib/serialization'
import type { Connection } from '@/types/connections'
import { getDefaultLabel, getDefaultConfig } from '@/registry/nodeRegistry'
import type { NodeType, ServiceType } from '@/types/nodes'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'
import { asFlowEdgeData, asFlowNodeData } from '@/lib/flow-data'

function InsertMenuItem({ type, serviceType, label, icon }: { type: NodeType; serviceType?: ServiceType; label: string; icon: string }) {
  const { nodes, addNode } = useScenarioStore()
  const handleInsert = useCallback(() => {
    addNode({
      type,
      serviceType,
      position: { x: 200 + Math.random() * 200, y: 200 + Math.random() * 200 },
      size: DEFAULT_NODE_SIZES[type],
      parentId: null,
      label: getDefaultLabel(type, nodes.map(n => n.data), serviceType),
      config: getDefaultConfig(type, serviceType),
      provider: type === 'vpc' ? 'aws' : null,
    })
  }, [type, serviceType, nodes, addNode])

  return (
    <DropdownMenuItem onClick={handleInsert} className="text-xs cursor-pointer">
      {icon} {label}
    </DropdownMenuItem>
  )
}

export function Toolbar() {
  const { nodes, edges, metadata, setMetadata, resetScenario, loadScenario } = useScenarioStore()
  const { setShowBulkGenerateModal, setShowKeyboardShortcuts, mode, setMode } = useUIStore()
  const { logBuffer } = useSimulationStore()
  const { episode, setEpisode } = useEpisodeStore()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const episodeFileInputRef = useRef<HTMLInputElement>(null)
  const [examples, setExamples] = React.useState<ExampleEpisodeManifestEntry[]>([])
  const [examplesLoaded, setExamplesLoaded] = React.useState(false)

  const loadExamplesManifest = useCallback(async () => {
    if (examplesLoaded) return
    try {
      const res = await fetch('/examples/episodes/index.json', { cache: 'no-cache' })
      if (res.ok) setExamples(await res.json())
    } catch {
      // ignore — menu just stays empty
    }
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

  const handleEpisodeOpen = useCallback(() => {
    episodeFileInputRef.current?.click()
  }, [])

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

  const buildScenario = useCallback(() => serializeScenario(
    nodes.map(n => n.data),
    edges.map(e => e.data!).filter(Boolean) as Connection[],
    metadata
  ), [nodes, edges, metadata])

  const persistAutosave = useCallback(() => {
    const scenario = buildScenario()
    localStorage.setItem('logsim-autosave', JSON.stringify(scenario))
    localStorage.setItem('logsim-autosave-time', new Date().toISOString())
  }, [buildScenario])

  const handleSave = useCallback(() => {
    const scenario = buildScenario()
    downloadJson(scenario, `${metadata.name.toLowerCase().replace(/\s+/g, '-')}.logsim.json`)
    persistAutosave()
  }, [buildScenario, metadata.name, persistAutosave])

  useEffect(() => {
    window.addEventListener('logsim-save', handleSave as EventListener)
    window.addEventListener('logsim-autosave', persistAutosave as EventListener)

    return () => {
      window.removeEventListener('logsim-save', handleSave as EventListener)
      window.removeEventListener('logsim-autosave', persistAutosave as EventListener)
    }
  }, [handleSave, persistAutosave])

  const handleOpen = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string)
        const scenario = deserializeScenario(data)

        // Convert to flow nodes/edges
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

  const handleNew = useCallback(() => {
    if (nodes.length > 0) {
      if (!confirm('Create a new scenario? Unsaved changes will be lost.')) return
    }
    resetScenario()
  }, [nodes.length, resetScenario])

  const handleExportLogs = useCallback(() => {
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

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-gray-200 bg-gray-50">
      {/* App title */}
      <div className="flex items-center gap-1.5 mr-3">
        <span className="text-sm font-bold text-gray-800">LogSim</span>
      </div>

      {/* Mode toggle */}
      <div className="mr-3 flex overflow-hidden rounded-md border border-slate-200">
        <button
          onClick={() => setMode('design')}
          className={`px-2 py-0.5 text-[11px] font-medium transition-colors ${
            mode === 'design' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          Design
        </button>
        <button
          onClick={() => setMode('episodes')}
          className={`px-2 py-0.5 text-[11px] font-medium transition-colors ${
            mode === 'episodes' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          Episodes
        </button>
      </div>

      {/* File menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">File</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="text-xs">
          <DropdownMenuItem onClick={handleNew} className="text-xs cursor-pointer">📄 New Scenario</DropdownMenuItem>
          <DropdownMenuItem onClick={handleOpen} className="text-xs cursor-pointer">📂 Open Scenario...</DropdownMenuItem>
          <DropdownMenuItem onClick={handleSave} className="text-xs cursor-pointer">💾 Save Scenario (Ctrl+S)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleEpisodeOpen} className="text-xs cursor-pointer">🎬 Open Episode...</DropdownMenuItem>
          <DropdownMenuItem onClick={handleEpisodeSave} className="text-xs cursor-pointer">🎬 Save Episode</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className="text-xs cursor-pointer"
              onMouseEnter={loadExamplesManifest}
              onFocus={loadExamplesManifest}
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
                    <span className="text-[10px] leading-tight text-slate-500 whitespace-normal">
                      {ex.description}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {ex.segmentCount} segments · {ex.totalTicks} ticks
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleExportLogs} className="text-xs cursor-pointer">📋 Export Logs (.log)</DropdownMenuItem>
          <DropdownMenuItem onClick={handleExportJsonl} className="text-xs cursor-pointer">📋 Export Logs (.jsonl)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="text-xs cursor-pointer">
            <Link href="/settings">⚙️ Settings...</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Insert menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">Insert</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="text-xs">
          <InsertMenuItem type="vpc" label="VPC" icon="🌐" />
          <InsertMenuItem type="subnet" label="Subnet" icon="🔲" />
          <InsertMenuItem type="virtual_server" label="Virtual Server" icon="💻" />
          <DropdownMenuSeparator />
          <InsertMenuItem type="service" serviceType="nodejs" label="Node.js Service" icon="🟩" />
          <InsertMenuItem type="service" serviceType="golang" label="Go Service" icon="🐹" />
          <InsertMenuItem type="service" serviceType="postgres" label="PostgreSQL" icon="🐘" />
          <InsertMenuItem type="service" serviceType="mysql" label="MySQL" icon="🐬" />
          <InsertMenuItem type="service" serviceType="redis" label="Redis" icon="🔴" />
          <InsertMenuItem type="service" serviceType="nginx" label="Nginx" icon="🌿" />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Run menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">Run</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="text-xs">
          <DropdownMenuItem
            onClick={() => setShowBulkGenerateModal(true)}
            className="text-xs cursor-pointer"
          >
            ⚡ Generate Batch...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Configure menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">Configure</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="text-xs">
          <DropdownMenuItem
            onClick={() => {
              const name = prompt('Scenario name:', metadata.name)
              if (name) setMetadata({ name })
            }}
            className="text-xs cursor-pointer"
          >
            ✏️ Rename Scenario
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              const desc = prompt('Description:', metadata.description)
              if (desc !== null) setMetadata({ description: desc })
            }}
            className="text-xs cursor-pointer"
          >
            📝 Edit Description
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Help menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">Help</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="text-xs">
          <DropdownMenuItem onClick={() => setShowKeyboardShortcuts(true)} className="text-xs cursor-pointer">
            ⌨️ Keyboard Shortcuts
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-xs">
            ℹ️ LogSim v1.0 — Phases 1-3
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.logsim.json"
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={episodeFileInputRef}
        type="file"
        accept=".json,.episode.json"
        className="hidden"
        onChange={handleEpisodeFileChange}
      />
    </div>
  )
}
