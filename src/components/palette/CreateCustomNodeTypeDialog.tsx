'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Sparkles, Loader2, AlertCircle, ExternalLink, RefreshCw, Trash2, ShieldCheck } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { useCustomNodeTypesStore } from '@/store/useCustomNodeTypesStore'
import { AI_PROVIDER_META, type AIProvider } from '@/types/aiKeys'
import { inferCustomNodeType } from '@/lib/customNodeTypePrompt'
import { previewCustomLogs } from '@/engine/generators/CustomLogGenerator'
import { AIRequestError } from '@/lib/aiClient'
import type { CustomNodeType } from '@/types/customNodeType'

const EXAMPLE_LOGS: { label: string; logs: string }[] = [
  {
    label: 'Apache access',
    logs: [
      '192.168.1.10 - - [24/Apr/2026:09:11:34 +0000] "GET /index.html HTTP/1.1" 200 2326 "-" "Mozilla/5.0"',
      '192.168.1.11 - - [24/Apr/2026:09:11:35 +0000] "POST /api/login HTTP/1.1" 401 87 "-" "curl/7.85"',
      '192.168.1.42 - - [24/Apr/2026:09:11:39 +0000] "GET /static/app.js HTTP/1.1" 304 0 "-" "Mozilla/5.0"',
    ].join('\n'),
  },
  {
    label: 'Kafka broker',
    logs: [
      '[2026-04-24 09:11:34,512] INFO [Controller id=1] Processing automatic preferred replica leader election (kafka.controller.KafkaController)',
      '[2026-04-24 09:11:35,201] WARN [ReplicaManager broker=2] Leader for partition orders-3 is no longer broker 1 (kafka.server.ReplicaManager)',
      '[2026-04-24 09:11:36,099] ERROR [Replica Manager on Broker 1] Error processing fetch operation on partition orders-7 (kafka.server.ReplicaManager)',
    ].join('\n'),
  },
  {
    label: 'JSON app',
    logs: [
      '{"ts":"2026-04-24T09:11:34.123Z","level":"info","msg":"order placed","order_id":"ord_19abf2","user_id":4218,"amount":42.50}',
      '{"ts":"2026-04-24T09:11:35.041Z","level":"warn","msg":"payment retry","order_id":"ord_19ac0c","attempt":2}',
      '{"ts":"2026-04-24T09:11:36.220Z","level":"error","msg":"gateway timeout","order_id":"ord_19ac0e","upstream":"stripe","duration_ms":12030}',
    ].join('\n'),
  },
]

interface Props {
  open: boolean
  onClose: () => void
  /** When set, the dialog edits an existing custom type instead of creating a new one. */
  editingType?: CustomNodeType
}

export function CreateCustomNodeTypeDialog({ open, onClose, editingType }: Props) {
  const keys = useAIKeysStore(s => s.keys)
  const hydrated = useAIKeysStore(s => s.hydrated)
  const defaultKey = keys.find(k => k.isDefault) ?? keys[0]
  const upsertCustom = useCustomNodeTypesStore(s => s.upsert)
  const removeCustom = useCustomNodeTypesStore(s => s.remove)

  const [sampleLogs, setSampleLogs] = useState('')
  const [providerOverride, setProviderOverride] = useState<AIProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CustomNodeType | null>(null)
  const [previewSeed, setPreviewSeed] = useState(1)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setPreviewSeed(1)
    if (editingType) {
      setSampleLogs(editingType.sampleLogs)
      setDraft(editingType)
    } else {
      setSampleLogs('')
      setDraft(null)
    }
    abortRef.current?.abort()
  }, [open, editingType])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const selectedProvider: AIProvider | null = useMemo(() => {
    if (providerOverride && keys.some(k => k.provider === providerOverride)) return providerOverride
    return defaultKey?.provider ?? null
  }, [providerOverride, defaultKey, keys])

  const selectedKey = selectedProvider ? keys.find(k => k.provider === selectedProvider) : undefined
  const noKeys = hydrated && keys.length === 0

  const previewSamples = useMemo(() => {
    if (!draft) return []
    try {
      return previewCustomLogs(draft, 6, previewSeed)
    } catch {
      return []
    }
  }, [draft, previewSeed])

  const handleAnalyze = async () => {
    if (!selectedKey || !sampleLogs.trim() || busy) return
    setError(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const inferred = await inferCustomNodeType(selectedKey, sampleLogs, {
        signal: controller.signal,
      })
      // Preserve the editing id if we're updating an existing type so it stays the same node-type identity.
      const final: CustomNodeType = editingType
        ? { ...inferred, id: editingType.id, createdAt: editingType.createdAt }
        : inferred
      setDraft(final)
      setPreviewSeed(s => s + 1)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      if (err instanceof AIRequestError) {
        setError(`${AI_PROVIDER_META[err.provider].label}: ${err.message}`)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const handleCancelInFlight = () => {
    abortRef.current?.abort()
    setBusy(false)
  }

  const handleSave = () => {
    if (!draft) return
    upsertCustom({ ...draft, updatedAt: new Date().toISOString() })
    onClose()
  }

  const handleDelete = () => {
    if (!editingType) return
    removeCustom(editingType.id)
    onClose()
  }

  const updateDraft = (patch: Partial<CustomNodeType>) => {
    setDraft(d => (d ? { ...d, ...patch } : d))
    setPreviewSeed(s => s + 1)
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-violet-500" />
            {editingType ? `Edit “${editingType.name}”` : 'Create custom node type'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Paste sample logs from the system you want to simulate. AI will infer the format,
            identify variable fields, and produce a generator that emits matching synthetic logs.
          </DialogDescription>
        </DialogHeader>

        {noKeys ? (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertCircle className="h-3.5 w-3.5" /> No AI key configured
            </div>
            <p>Add a Claude, OpenAI, or Gemini key in Settings. Keys stay in your browser.</p>
            <Link
              href="/settings?category=ai-keys"
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
            >
              Open AI key settings <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-900">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
              <span>
                Calls go from your browser straight to{' '}
                {selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'the provider'}. Your key never touches the LogSim backend.
              </span>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Provider</Label>
              <div className="flex flex-wrap gap-1.5">
                {keys.map(k => {
                  const meta = AI_PROVIDER_META[k.provider]
                  const active = selectedProvider === k.provider
                  return (
                    <button
                      key={k.provider}
                      onClick={() => setProviderOverride(k.provider)}
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                        active
                          ? 'border-violet-300 bg-violet-50 text-violet-900'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                      )}
                    >
                      <span>{meta.icon}</span>
                      <span>{meta.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Sample logs</Label>
              <Textarea
                value={sampleLogs}
                onChange={e => setSampleLogs(e.target.value)}
                placeholder="Paste 3–20 representative log lines here…"
                className="min-h-[140px] font-mono text-[11px]"
                spellCheck={false}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleAnalyze()
                  }
                }}
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {EXAMPLE_LOGS.map(ex => (
                  <button
                    key={ex.label}
                    type="button"
                    onClick={() => setSampleLogs(ex.logs)}
                    className="rounded-full border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{error}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-[10px] text-gray-400">⌘/Ctrl + Enter to analyze</p>
              {busy ? (
                <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={handleCancelInFlight}>Cancel</Button>
              ) : (
                <Button
                  size="sm"
                  className="h-7 gap-1 text-[11px]"
                  onClick={handleAnalyze}
                  disabled={!selectedKey || !sampleLogs.trim()}
                  type="button"
                >
                  <Sparkles className="h-3 w-3" />
                  {draft ? 'Re-analyze' : 'Analyze with AI'}
                </Button>
              )}
            </div>

            {busy && (
              <div className="flex items-center gap-2 rounded-md bg-blue-50 px-2.5 py-1.5 text-[11px] text-blue-700">
                <Loader2 className="h-3 w-3 animate-spin" />
                Asking the model to infer the log format…
              </div>
            )}

            {draft && (
              <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-gray-900">Inferred type</h3>
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-800">
                    {draft.detectedFormat}
                  </span>
                </div>
                {draft.inferredKind && (
                  <p className="text-[11px] text-gray-600 italic">{draft.inferredKind}</p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-[10px] text-gray-500">Icon</Label>
                    <Input
                      value={draft.icon}
                      onChange={e => updateDraft({ icon: e.target.value })}
                      maxLength={4}
                      className="h-7 text-center text-base"
                    />
                  </div>
                  <div className="col-span-2 space-y-0.5">
                    <Label className="text-[10px] text-gray-500">Name</Label>
                    <Input
                      value={draft.name}
                      onChange={e => updateDraft({ name: e.target.value })}
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-[10px] text-gray-500">Default port</Label>
                    <Input
                      type="number"
                      value={draft.defaultPort ?? ''}
                      onChange={e => updateDraft({ defaultPort: e.target.value ? parseInt(e.target.value) : undefined })}
                      className="h-7 text-xs"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[10px] text-gray-500">Events / sec</Label>
                    <Input
                      type="number"
                      value={draft.defaultRate}
                      onChange={e => updateDraft({ defaultRate: Math.max(1, parseFloat(e.target.value) || 1) })}
                      className="h-7 text-xs"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[10px] text-gray-500">Error rate (0–1)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={draft.defaultErrorRate}
                      onChange={e => updateDraft({ defaultErrorRate: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) })}
                      className="h-7 text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-gray-500">
                      Generated samples ({draft.templates.length} templates,{' '}
                      {Object.keys(draft.placeholders).length} placeholders)
                    </Label>
                    <button
                      type="button"
                      onClick={() => setPreviewSeed(s => s + 1)}
                      className="inline-flex items-center gap-1 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                      title="Re-roll preview"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="rounded border border-gray-200 bg-white p-2 max-h-[160px] overflow-auto">
                    {previewSamples.length === 0 ? (
                      <p className="text-[11px] text-gray-400">No preview available.</p>
                    ) : (
                      <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-gray-700 leading-relaxed">
                        {previewSamples.join('\n')}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {editingType && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 border-red-200 text-red-700 hover:bg-red-50"
              onClick={handleDelete}
              type="button"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8" onClick={onClose} type="button">Cancel</Button>
          <Button
            size="sm"
            className="h-8 gap-1"
            onClick={handleSave}
            disabled={!draft}
            type="button"
          >
            Save type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
