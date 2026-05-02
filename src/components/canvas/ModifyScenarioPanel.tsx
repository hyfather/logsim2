'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Sparkles, Loader2, AlertCircle, ExternalLink, ShieldCheck, Send, User, X } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioLibraryStore } from '@/store/useScenarioLibraryStore'
import { useModifyChatStore } from '@/store/useModifyChatStore'
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
  'Add a second API instance behind the load balancer',
  'Build a 3-tier web app with a slow DB incident',
]

interface ModifyScenarioPanelProps {
  onClose: () => void
}

export function ModifyScenarioPanel({ onClose }: ModifyScenarioPanelProps) {
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

  const history = useModifyChatStore(s => s.history)
  const instruction = useModifyChatStore(s => s.draft)
  const appendTurn = useModifyChatStore(s => s.appendTurn)
  const popTurn = useModifyChatStore(s => s.popTurn)
  const setInstruction = useModifyChatStore(s => s.setDraft)
  const resetForScenario = useModifyChatStore(s => s.resetForScenario)

  const [providerOverride, setProviderOverride] = useState<AIProvider | null>(null)
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

  // Reset chat when the user switches scenarios — history was tied to the
  // previous canvas and would be misleading against a different one.
  useEffect(() => {
    resetForScenario(currentScenarioId)
  }, [currentScenarioId, resetForScenario])

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 50)
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [history.length, busy])

  const handleSend = async () => {
    if (!selectedKey || !instruction.trim() || busy) return

    const userTurn: ModifyChatTurn = { role: 'user', text: instruction.trim() }
    appendTurn(userTurn)
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

      const prevNodeCount = nodes.length
      const prevEdgeCount = edges.length
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

      const summary = summarizeChange(result, prevNodeCount, prevEdgeCount)
      appendTurn({ role: 'assistant', text: summary })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled.
      } else if (err instanceof AIRequestError) {
        setError(`${AI_PROVIDER_META[err.provider].label}: ${err.message}`)
        popTurn()
      } else {
        setError(err instanceof Error ? err.message : String(err))
        popTurn()
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const handleCancelInFlight = () => {
    abortRef.current?.abort()
    setBusy(false)
    popTurn()
  }

  const noKeys = hydrated && keys.length === 0
  const isEmpty = nodes.length === 0

  return (
    <aside className="flex h-full w-full flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-slate-900">
          <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          <span className="truncate">Modify with AI</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

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
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px]">
            <div className="flex min-w-0 items-center gap-1.5 text-emerald-800">
              <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-600" />
              <span className="truncate">
                Sent direct to {selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'provider'}.
              </span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1">
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
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
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

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {history.length === 0 && !busy ? (
              <div className="space-y-3">
                <p className="text-[12px] text-slate-500">
                  {isEmpty
                    ? 'Describe a scenario to build, or pick a starting point:'
                    : 'Describe a change to the scenario, or try one of these:'}
                </p>
                <div className="space-y-1.5">
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setInstruction(s)}
                      className="block w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-left text-[11.5px] text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
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
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        {turn.role === 'user' ? 'You' : selectedKey ? AI_PROVIDER_META[selectedKey.provider].label : 'AI'}
                      </div>
                      <div className={cn(
                        'mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed',
                        turn.role === 'user' ? 'text-slate-900' : 'text-slate-700',
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
                    <div className="text-[12px] text-slate-500">
                      {isEmpty ? 'Drafting the scenario…' : 'Revising the scenario…'}
                    </div>
                  </li>
                )}
                <div ref={messagesEndRef} />
              </ul>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-1.5 border-t border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}

          <div className="border-t border-slate-200 px-3 py-2">
            <Textarea
              ref={textareaRef}
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder={isEmpty ? 'Describe a scenario to build…' : 'Describe a change…'}
              className="min-h-[60px] resize-none text-xs"
              disabled={busy}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] text-slate-400">
                ⌘/Ctrl + Enter
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
                    disabled={!selectedKey || !instruction.trim()}
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
    </aside>
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
