'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Sparkles, X, Loader2, AlertCircle, ExternalLink, ShieldCheck } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { AI_PROVIDER_META, type AIProvider } from '@/types/aiKeys'
import { generateScenarioFromDescription } from '@/lib/scenarioPrompt'
import { AIRequestError } from '@/lib/aiClient'

const EXAMPLES: { title: string; prompt: string }[] = [
  {
    title: 'Three-tier web app',
    prompt:
      'A production VPC in us-east-1 with a public subnet running an Nginx reverse proxy ' +
      'that fronts two Node.js API servers in a private subnet. The APIs talk to a primary ' +
      'PostgreSQL database and a Redis cache.',
  },
  {
    title: 'Microservices with bursty traffic',
    prompt:
      'A staging VPC with one subnet containing an api-gateway (Go), three Node.js microservices ' +
      '(orders, users, billing), a MySQL database, and a Redis cache. Add a bursty 200 req/s of ' +
      'traffic from the gateway into orders.',
  },
  {
    title: 'Simple cache + DB',
    prompt:
      'One VPC, one subnet, one Node.js API connected to PostgreSQL on port 5432 and to Redis on port 6379.',
  },
]

interface DescribeScenarioPanelProps {
  open: boolean
  onClose: () => void
}

export function DescribeScenarioPanel({ open, onClose }: DescribeScenarioPanelProps) {
  const keys = useAIKeysStore(s => s.keys)
  const hydrated = useAIKeysStore(s => s.hydrated)
  const defaultKey = keys.find(k => k.isDefault) ?? keys[0]
  const loadScenario = useScenarioStore(s => s.loadScenario)
  const setMetadata = useScenarioStore(s => s.setMetadata)
  const organizeLayout = useScenarioStore(s => s.organizeLayout)
  const setEpisode = useEpisodeStore(s => s.setEpisode)
  const { fitView } = useReactFlow()

  const [description, setDescription] = useState('')
  const [providerOverride, setProviderOverride] = useState<AIProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const selectedProvider: AIProvider | null = useMemo(() => {
    if (providerOverride && keys.some(k => k.provider === providerOverride)) return providerOverride
    return defaultKey?.provider ?? null
  }, [providerOverride, defaultKey, keys])

  const selectedKey = selectedProvider ? keys.find(k => k.provider === selectedProvider) : undefined

  // Reset transient state when panel opens.
  useEffect(() => {
    if (!open) return
    setError(null)
    setSuccess(null)
    setBusy(false)
    abortRef.current?.abort()
    setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open])

  // Cancel any in-flight request when the panel closes / unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  if (!open) return null

  const handleGenerate = async () => {
    if (!selectedKey || !description.trim() || busy) return
    setError(null)
    setSuccess(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const result = await generateScenarioFromDescription(
        selectedKey,
        description,
        { signal: controller.signal },
      )

      // Replace the current scenario with what the model proposed. The user
      // still has Ctrl+Z (or just typing again) as undo.
      loadScenario(result.flowNodes, result.flowEdges, {
        name: result.name?.trim() || 'AI scenario',
        description: result.description?.trim() || description.trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      setMetadata({ name: result.name?.trim() || 'AI scenario' })

      // If the model also produced a timeline, replace the active episode with it
      // so the timeline panel comes up populated and ready to scrub.
      if (result.episode) {
        setEpisode(result.episode)
      }

      // Re-run the canvas layout pass so service tiers and edge anchors are
      // computed from the live store state, then fit-view to center the result.
      organizeLayout()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitView({ padding: 0.2, duration: 400, maxZoom: 1 })
        })
      })

      const laneCount = result.episode ? Object.keys(result.episode.lanes).length : 0
      const beatCount = result.episode ? result.episode.narrative.length : 0
      const timelinePart = result.episode
        ? `, plus a ${Math.round(result.episode.duration / 60)}-minute timeline (${laneCount} lane${laneCount === 1 ? '' : 's'}, ${beatCount} beat${beatCount === 1 ? '' : 's'})`
        : ''
      setSuccess(
        `Generated ${result.flowNodes.length} node${result.flowNodes.length === 1 ? '' : 's'}` +
          ` and ${result.flowEdges.length} connection${result.flowEdges.length === 1 ? '' : 's'}` +
          `${timelinePart}.`,
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled, no error to surface.
      } else if (err instanceof AIRequestError) {
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

  const noKeys = hydrated && keys.length === 0

  return (
    <div className="absolute right-3 top-3 z-30 w-[360px] overflow-hidden rounded-xl border border-gray-200 bg-white/95 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <Sparkles className="h-4 w-4 text-violet-500" />
        <h3 className="text-xs font-semibold text-gray-900">Describe scenario</h3>
        <button
          onClick={onClose}
          title="Close"
          className="ml-auto rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3 p-3">
        {noKeys ? (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertCircle className="h-3.5 w-3.5" />
              No AI key configured
            </div>
            <p>Add a Claude, OpenAI, or Gemini key in Settings. Keys stay only in your browser.</p>
            <Link
              href="/settings?category=ai-keys"
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
            >
              Open AI key settings <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[10px] text-emerald-900">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
              <span>
                Calls go from your browser straight to{' '}
                {selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'the provider'}. Your
                key never touches the LogSim backend.
              </span>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] font-medium text-gray-700">Provider</Label>
              <div className="flex flex-wrap gap-1.5">
                {keys.map(k => {
                  const meta = AI_PROVIDER_META[k.provider]
                  const active = selectedProvider === k.provider
                  return (
                    <button
                      key={k.provider}
                      onClick={() => setProviderOverride(k.provider)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                        active
                          ? 'border-violet-300 bg-violet-50 text-violet-900'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                      )}
                      type="button"
                    >
                      <span>{meta.icon}</span>
                      <span>{meta.label}</span>
                      {k.isDefault && (
                        <span className="rounded bg-emerald-100 px-1 text-[9px] font-semibold text-emerald-800">
                          default
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {selectedKey && (
                <p className="text-[10px] text-gray-500">
                  Model: <code className="font-mono">{selectedKey.model}</code>
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] font-medium text-gray-700">Description</Label>
              <Textarea
                ref={textareaRef}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="e.g. A production VPC with two API servers, a Postgres database, and a Redis cache…"
                className="min-h-[120px] text-xs"
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleGenerate()
                  }
                }}
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {EXAMPLES.map(ex => (
                  <button
                    key={ex.title}
                    onClick={() => setDescription(ex.prompt)}
                    type="button"
                    className="rounded-full border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                  >
                    {ex.title}
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
            {success && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">
                ✓ {success} The canvas has been replaced.
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-[10px] text-gray-400">
                ⌘/Ctrl + Enter to generate
              </p>
              <div className="flex gap-2">
                {busy ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={handleCancelInFlight}
                    type="button"
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 gap-1 text-[11px]"
                    onClick={handleGenerate}
                    disabled={!selectedKey || !description.trim()}
                    type="button"
                  >
                    <Sparkles className="h-3 w-3" />
                    Generate
                  </Button>
                )}
              </div>
            </div>

            {busy && (
              <div className="flex items-center gap-2 rounded-md bg-blue-50 px-2.5 py-1.5 text-[11px] text-blue-700">
                <Loader2 className="h-3 w-3 animate-spin" />
                Asking {selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'the model'} to
                draft your scenario…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
