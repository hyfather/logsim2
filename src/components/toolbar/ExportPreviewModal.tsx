'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Check, Copy, Download, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { AI_PROVIDER_META, type AIProvider } from '@/types/aiKeys'
import {
  buildScenarioYamlForGroundTruth,
  generateScenarioGroundTruth,
} from '@/lib/scenarioGroundTruth'
import { AIRequestError } from '@/lib/aiClient'
import type { FlowNode, FlowEdge } from '@/store/useScenarioStore'
import type { ScenarioMetadata } from '@/types/scenario'
import type { Episode } from '@/types/episode'

export type ExportTab = 'yaml' | 'ground-truth'

interface ExportPreviewModalProps {
  open: boolean
  onClose: () => void
  initialTab?: ExportTab
  flowNodes: FlowNode[]
  flowEdges: FlowEdge[]
  metadata: ScenarioMetadata
  episode: Episode
  tickIntervalMs?: number
}

function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function fileSlug(name: string): string {
  const slug = (name || 'scenario').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '')
  return slug || 'scenario'
}

export function ExportPreviewModal({
  open,
  onClose,
  initialTab = 'yaml',
  flowNodes,
  flowEdges,
  metadata,
  episode,
  tickIntervalMs = 1000,
}: ExportPreviewModalProps) {
  const keys = useAIKeysStore(s => s.keys)
  const hydrated = useAIKeysStore(s => s.hydrated)
  const defaultKey = keys.find(k => k.isDefault) ?? keys[0]

  const [activeTab, setActiveTab] = useState<ExportTab>(initialTab)
  const [providerOverride, setProviderOverride] = useState<AIProvider | null>(null)
  const [groundTruth, setGroundTruth] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<ExportTab | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const selectedProvider: AIProvider | null = useMemo(() => {
    if (providerOverride && keys.some(k => k.provider === providerOverride)) return providerOverride
    return defaultKey?.provider ?? null
  }, [providerOverride, defaultKey, keys])

  const selectedKey = selectedProvider ? keys.find(k => k.provider === selectedProvider) : undefined
  const noKeys = hydrated && keys.length === 0

  const yamlText = useMemo(() => {
    if (!open) return ''
    return buildScenarioYamlForGroundTruth(flowNodes, flowEdges, metadata, {
      episode,
      tickIntervalMs,
    })
  }, [open, flowNodes, flowEdges, metadata, episode, tickIntervalMs])

  const slug = useMemo(() => fileSlug(metadata.name), [metadata.name])

  const runGeneration = useCallback(async () => {
    if (!selectedKey) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    try {
      const text = await generateScenarioGroundTruth(
        selectedKey,
        flowNodes,
        flowEdges,
        metadata,
        { episode, tickIntervalMs, signal: controller.signal },
      )
      setGroundTruth(text)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // user cancelled
      } else if (err instanceof AIRequestError) {
        setError(`${AI_PROVIDER_META[err.provider].label}: ${err.message}`)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [selectedKey, flowNodes, flowEdges, metadata, episode, tickIntervalMs])

  // Reset state when the modal opens.
  useEffect(() => {
    if (!open) return
    setActiveTab(initialTab)
    setError(null)
    setGroundTruth(null)
    setCopied(null)
  }, [open, initialTab])

  // Auto-generate ground truth on first open if there's a key configured.
  useEffect(() => {
    if (!open) return
    if (groundTruth !== null) return
    if (busy) return
    if (!selectedKey) return
    runGeneration()
    // We deliberately depend on `open` and `selectedKey` only — we don't want to
    // re-fire whenever the parent re-renders with new flowNodes references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedKey?.provider, selectedKey?.model])

  // Cancel any in-flight request when the modal closes / unmounts.
  useEffect(() => {
    if (open) return
    abortRef.current?.abort()
    setBusy(false)
  }, [open])
  useEffect(() => () => abortRef.current?.abort(), [])

  const handleCopy = useCallback(async (tab: ExportTab) => {
    const text = tab === 'yaml' ? yamlText : (groundTruth ?? '')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tab)
      setTimeout(() => setCopied(prev => (prev === tab ? null : prev)), 1500)
    } catch {
      // clipboard can fail in non-secure contexts; ignore quietly
    }
  }, [yamlText, groundTruth])

  const handleDownload = useCallback((tab: ExportTab) => {
    if (tab === 'yaml') {
      downloadText(yamlText, `${slug}.scenario.yaml`, 'application/x-yaml')
    } else if (groundTruth) {
      downloadText(groundTruth, `${slug}.ground-truth.txt`, 'text/plain')
    }
  }, [yamlText, groundTruth, slug])

  const activeText = activeTab === 'yaml' ? yamlText : (groundTruth ?? '')
  const downloadDisabled = activeTab === 'ground-truth' && !groundTruth

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-1.5rem)] max-w-3xl flex-col gap-3 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-4 py-3">
          <DialogTitle className="text-sm font-semibold text-slate-900">Export scenario</DialogTitle>
          <DialogDescription className="text-[11px] text-slate-500">
            Preview the scenario YAML the backend consumes, and an AI-generated ground-truth summary suitable as an SFT/RL target.
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 px-4">
          <TabButton
            active={activeTab === 'yaml'}
            onClick={() => setActiveTab('yaml')}
            label="scenario.yaml"
            sublabel="Backend YAML"
          />
          <TabButton
            active={activeTab === 'ground-truth'}
            onClick={() => setActiveTab('ground-truth')}
            label="ground-truth.txt"
            sublabel="SFT/RL target"
          />
          <div className="ml-auto flex items-center gap-1 py-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={() => handleCopy(activeTab)}
              disabled={!activeText}
              type="button"
            >
              {copied === activeTab ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied === activeTab ? 'Copied' : 'Copy'}
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={() => handleDownload(activeTab)}
              disabled={downloadDisabled || !activeText}
              type="button"
            >
              <Download className="h-3 w-3" />
              Download
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4">
          {activeTab === 'ground-truth' && (
            <GroundTruthControls
              hydrated={hydrated}
              noKeys={noKeys}
              keys={keys}
              selectedProvider={selectedProvider}
              setProviderOverride={setProviderOverride}
              busy={busy}
              hasResult={groundTruth !== null}
              onGenerate={runGeneration}
              onCancel={() => abortRef.current?.abort()}
            />
          )}

          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}

          <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
            {activeTab === 'ground-truth' && groundTruth === null ? (
              <GroundTruthPlaceholder busy={busy} noKeys={noKeys} hasKey={!!selectedKey} />
            ) : (
              <pre className="m-0 max-h-full w-full overflow-auto whitespace-pre p-3 font-mono text-[11.5px] leading-relaxed text-slate-800">
                {activeText}
              </pre>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TabButton({
  active,
  onClick,
  label,
  sublabel,
}: {
  active: boolean
  onClick: () => void
  label: string
  sublabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-0 px-3 py-2 text-left text-[11px] transition-colors',
        active
          ? 'border-b-2 border-blue-600 text-slate-900'
          : 'border-b-2 border-transparent text-slate-500 hover:text-slate-700',
      )}
    >
      <span className="font-mono text-[11.5px] font-medium">{label}</span>
      <span className="text-[9.5px] uppercase tracking-[0.12em] text-slate-400">{sublabel}</span>
    </button>
  )
}

function GroundTruthControls({
  hydrated,
  noKeys,
  keys,
  selectedProvider,
  setProviderOverride,
  busy,
  hasResult,
  onGenerate,
  onCancel,
}: {
  hydrated: boolean
  noKeys: boolean
  keys: ReturnType<typeof useAIKeysStore.getState>['keys']
  selectedProvider: AIProvider | null
  setProviderOverride: (p: AIProvider) => void
  busy: boolean
  hasResult: boolean
  onGenerate: () => void
  onCancel: () => void
}) {
  if (!hydrated) {
    return (
      <div className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-500">
        Loading…
      </div>
    )
  }
  if (noKeys) {
    return (
      <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
        <div className="flex items-center gap-1.5 font-semibold">
          <AlertCircle className="h-3.5 w-3.5" />
          No AI key configured
        </div>
        <p>
          The ground truth is generated by an LLM. Add a Claude, OpenAI, or Gemini key in Settings.
          Keys stay only in your browser.
        </p>
        <Link
          href="/settings?category=ai-keys"
          className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
        >
          Open AI key settings <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-700">
      <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Provider</span>
      <div className="flex flex-wrap gap-1">
        {keys.map(k => {
          const meta = AI_PROVIDER_META[k.provider]
          const active = selectedProvider === k.provider
          return (
            <button
              key={k.provider}
              onClick={() => setProviderOverride(k.provider)}
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] transition-colors',
                active
                  ? 'border-violet-300 bg-violet-50 text-violet-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
              )}
            >
              <span>{meta.icon}</span>
              <span>{meta.label}</span>
            </button>
          )
        })}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {busy ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[11px]"
            onClick={onCancel}
            type="button"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Cancel
          </Button>
        ) : (
          <Button
            variant={hasResult ? 'outline' : 'default'}
            size="sm"
            className="h-7 gap-1 text-[11px]"
            onClick={onGenerate}
            type="button"
          >
            {hasResult ? <RefreshCw className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
            {hasResult ? 'Regenerate' : 'Generate'}
          </Button>
        )}
      </div>
    </div>
  )
}

function GroundTruthPlaceholder({
  busy,
  noKeys,
  hasKey,
}: {
  busy: boolean
  noKeys: boolean
  hasKey: boolean
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-[12px] text-slate-500">
      {busy ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Compiling scenario into ground truth…
        </span>
      ) : noKeys ? (
        <span>Add an AI key in Settings to generate the ground truth.</span>
      ) : !hasKey ? (
        <span>Pick a provider above, then click Generate.</span>
      ) : (
        <span>Click Generate to compile the scenario into ground truth.</span>
      )}
    </div>
  )
}
