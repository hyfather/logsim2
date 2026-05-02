'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Sparkles, Loader2, AlertCircle, ExternalLink, ShieldCheck, Send, User } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioLibraryStore } from '@/store/useScenarioLibraryStore'
import { AI_PROVIDER_META, type AIProvider } from '@/types/aiKeys'
import {
  modifyScenarioFromInstruction,
  currentCanvasToProposedJson,
  type ModifyChatTurn,
} from '@/lib/scenarioPrompt'
import { AIRequestError } from '@/lib/aiClient'

const SUGGESTIONS: string[] = [
  'Add a Redis cache in front of the database',
  'Make the incident a DDoS instead of a slow query',
  'Double the traffic and add a 30-second outage at tick 600',
  'Add a second API instance behind the load balancer',
]

interface ModifyScenarioPanelProps {
  open: boolean
  onClose: () => void
}

export function ModifyScenarioPanel({ open, onClose }: ModifyScenarioPanelProps) {
  const keys = useAIKeysStore(s => s.keys)
  const hydrated = useAIKeysStore(s => s.hydrated)
  const defaultKey = keys.find(k => k.isDefault) ?? keys[0]

  const nodes = useScenarioStore(s => s.nodes)
  const edges = useScenarioStore(s => s.edges)
  const loadScenario = useScenarioStore(s => s.loadScenario)
  const organizeLayout = useScenarioStore(s => s.organizeLayout)
  const episode = useEpisodeStore(s => s.episode)
  const setEpisode = useEpisodeStore(s => s.setEpisode)
  const currentScenarioId = useScenarioLibraryStore(s => s.currentId)
  const { fitView } = useReactFlow()

  const [providerOverride, setProviderOverride] = useState<AIProvider | null>(null)
  const [instruction, setInstruction] = useState('')
  const [history, setHistory] = useState<ModifyChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const selectedProvider: AIProvider | null = useMemo(() => {
    if (providerOverride && keys.some(k => k.provider === providerOverride)) return providerOverride
    return defaultKey?.provider ?? null
  }, [providerOverride, defaultKey, keys])

  const selectedKey = selectedProvider ? keys.find(k => k.provider === selectedProvider) : undefined

  // Reset chat when the user switches scenarios — the history was tied to the
  // previous canvas and would be misleading against a different one.
  useEffect(() => {
    setHistory([])
    setError(null)
    setInstruction('')
  }, [currentScenarioId])

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    abortRef.current?.abort()
    setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [history.length, busy])

  const handleSend = async () => {
    if (!selectedKey || !instruction.trim() || busy) return
    if (nodes.length === 0) {
      setError('Open a scenario first — modify needs an existing canvas to edit.')
      return
    }

    const userTurn: ModifyChatTurn = { role: 'user', text: instruction.trim() }
    setHistory(prev => [...prev, userTurn])
    setInstruction('')
    setError(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const snapshot = currentCanvasToProposedJson(nodes, edges, episode)
      const result = await modifyScenarioFromInstruction(
        selectedKey,
        snapshot,
        history,
        userTurn.text,
        { signal: controller.signal },
      )

      loadScenario(result.flowNodes, result.flowEdges, {
        name: result.name?.trim() || 'Modified scenario',
        description: result.description?.trim() || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      if (result.episode) setEpisode(result.episode)

      organizeLayout()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitView({ padding: 0.2, duration: 400, maxZoom: 1 })
        })
      })

      const summary = summarizeChange(result, nodes.length, edges.length)
      setHistory(prev => [...prev, { role: 'assistant', text: summary }])
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled.
      } else if (err instanceof AIRequestError) {
        setError(`${AI_PROVIDER_META[err.provider].label}: ${err.message}`)
        setHistory(prev => prev.slice(0, -1))
      } else {
        setError(err instanceof Error ? err.message : String(err))
        setHistory(prev => prev.slice(0, -1))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const handleCancelInFlight = () => {
    abortRef.current?.abort()
    setBusy(false)
    setHistory(prev => prev.slice(0, -1))
  }

  const noKeys = hydrated && keys.length === 0

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex h-[min(640px,85dvh)] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-gray-200 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Sparkles className="h-4 w-4 text-violet-500" />
            Modify with AI
          </DialogTitle>
          <DialogDescription className="text-[11px] text-gray-500">
            Describe how to change the current scenario. The canvas updates with each reply — keep iterating in plain English.
          </DialogDescription>
        </DialogHeader>

        {noKeys ? (
          <div className="flex flex-1 items-center justify-center p-4">
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
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2 text-[11px]">
              <div className="flex items-center gap-1.5 text-emerald-800">
                <ShieldCheck className="h-3 w-3 text-emerald-600" />
                <span>
                  Sent direct to {selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'provider'}.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {keys.map(k => {
                  const meta = AI_PROVIDER_META[k.provider]
                  const active = selectedProvider === k.provider
                  return (
                    <button
                      key={k.provider}
                      onClick={() => setProviderOverride(k.provider)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors',
                        active
                          ? 'border-violet-300 bg-violet-50 text-violet-900'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                      )}
                      type="button"
                    >
                      <span>{meta.icon}</span>
                      <span>{meta.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {history.length === 0 && !busy ? (
                <div className="space-y-3 py-2">
                  <p className="text-[12px] text-gray-500">
                    Try one of these, or describe your own change:
                  </p>
                  <div className="space-y-1.5">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setInstruction(s)}
                        className="block w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-left text-[11.5px] text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <ul className="space-y-3">
                  {history.map((turn, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={cn(
                        'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                        turn.role === 'user' ? 'bg-slate-200 text-slate-700' : 'bg-violet-100 text-violet-700',
                      )}>
                        {turn.role === 'user' ? <User className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                          {turn.role === 'user' ? 'You' : selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'AI'}
                        </div>
                        <div className={cn(
                          'mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed',
                          turn.role === 'user' ? 'text-gray-900' : 'text-gray-700',
                        )}>
                          {turn.text}
                        </div>
                      </div>
                    </li>
                  ))}
                  {busy && (
                    <li className="flex gap-2">
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                      <div className="text-[12px] text-gray-500">
                        Revising the scenario…
                      </div>
                    </li>
                  )}
                  <div ref={messagesEndRef} />
                </ul>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-1.5 border-t border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{error}</span>
              </div>
            )}

            <div className="border-t border-gray-200 px-3 py-2">
              <Textarea
                ref={textareaRef}
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                placeholder="Describe a change… (⌘/Ctrl + Enter to send)"
                className="min-h-[64px] resize-none text-xs"
                disabled={busy}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleSend()
                  }
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[10px] text-gray-400">
                  {history.length > 0 ? `${Math.ceil(history.length / 2)} turn${history.length > 1 ? 's' : ''}` : 'New conversation'}
                </p>
                <div className="flex items-center gap-2">
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
                      onClick={handleSend}
                      disabled={!selectedKey || !instruction.trim() || nodes.length === 0}
                      type="button"
                    >
                      <Send className="h-3 w-3" />
                      Send
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function summarizeChange(
  result: { flowNodes: { id: string }[]; flowEdges: { id: string }[]; reasoning?: string; description?: string },
  prevNodeCount: number,
  prevEdgeCount: number,
): string {
  if (result.reasoning?.trim()) return result.reasoning.trim()
  const dn = result.flowNodes.length - prevNodeCount
  const de = result.flowEdges.length - prevEdgeCount
  const parts: string[] = []
  if (dn > 0) parts.push(`+${dn} node${dn === 1 ? '' : 's'}`)
  else if (dn < 0) parts.push(`${dn} node${dn === -1 ? '' : 's'}`)
  if (de > 0) parts.push(`+${de} edge${de === 1 ? '' : 's'}`)
  else if (de < 0) parts.push(`${de} edge${de === -1 ? '' : 's'}`)
  if (parts.length === 0) {
    return result.description?.trim() || 'Updated the scenario.'
  }
  return `Updated (${parts.join(', ')}). ${result.description?.trim() ?? ''}`.trim()
}
