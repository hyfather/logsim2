'use client'
import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { AI_PROVIDER_META, type AIProvider } from '@/types/aiKeys'
import { listModels, pickBestModel, pingProvider, sortModelsForDisplay } from '@/lib/aiClient'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }

type Status =
  | { kind: 'idle' }
  | { kind: 'detecting' }
  | { kind: 'ok'; model: string; count: number }
  | { kind: 'error'; message: string }

const PROVIDER_ORDER: AIProvider[] = ['anthropic', 'openai', 'gemini']

export function AiKeysPanel() {
  const { keys, hydrated, upsertKey, removeKey, setDefault } = useAIKeysStore()
  const defaultProvider = keys.find(k => k.isDefault)?.provider

  const [provider, setProvider] = useState<AIProvider>('anthropic')
  // Pick a sensible initial provider once hydrated: default > first stored > anthropic.
  useEffect(() => {
    if (!hydrated) return
    if (defaultProvider) setProvider(defaultProvider)
    else if (keys[0]) setProvider(keys[0].provider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  const stored = keys.find(k => k.provider === provider)
  const meta = AI_PROVIDER_META[provider]
  const isDefault = defaultProvider === provider

  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [models, setModels] = useState<string[]>([])
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' })

  // Sync local input + status when provider/store changes.
  useEffect(() => {
    setApiKey(stored?.apiKey ?? '')
    setShowKey(false)
    setModels([])
    setStatus(stored ? { kind: 'ok', model: stored.model, count: 0 } : { kind: 'idle' })
    setTestState({ kind: 'idle' })
  }, [provider, stored?.apiKey, stored?.model])

  // When a key is already saved, fetch the model list in the background so the
  // dropdown is populated with real options (not just the saved one).
  useEffect(() => {
    if (!stored?.apiKey || models.length > 0) return
    let cancelled = false
    listModels(provider, stored.apiKey)
      .then(ids => {
        if (cancelled) return
        setModels(sortModelsForDisplay(provider, ids))
      })
      .catch(() => { /* leave models empty; user can hit refresh */ })
    return () => { cancelled = true }
  }, [provider, stored?.apiKey, models.length])

  const dirty = apiKey.trim() !== (stored?.apiKey ?? '')
  const canSave = apiKey.trim().length > 0 && (dirty || !stored)

  const detectAndSave = async () => {
    const key = apiKey.trim()
    if (!key) return
    setStatus({ kind: 'detecting' })
    try {
      const ids = await listModels(provider, key)
      const sorted = sortModelsForDisplay(provider, ids)
      const best = pickBestModel(provider, ids) ?? meta.defaultModel
      setModels(sorted)
      upsertKey({ provider, apiKey: key, model: best })
      setStatus({ kind: 'ok', model: best, count: ids.length })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const refresh = async () => {
    if (!stored) return
    setStatus({ kind: 'detecting' })
    try {
      const ids = await listModels(provider, stored.apiKey)
      const sorted = sortModelsForDisplay(provider, ids)
      setModels(sorted)
      // Don't override the user's manual selection — only auto-pick if their
      // saved model is no longer in the available list.
      const target = ids.includes(stored.model) ? stored.model : (pickBestModel(provider, ids) ?? meta.defaultModel)
      if (target !== stored.model) upsertKey({ provider, apiKey: stored.apiKey, model: target })
      setStatus({ kind: 'ok', model: target, count: ids.length })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleSelectModel = (model: string) => {
    if (!stored || model === stored.model) return
    upsertKey({ provider, apiKey: stored.apiKey, model })
    setStatus({ kind: 'ok', model, count: models.length })
    setTestState({ kind: 'idle' })
  }

  const handleTest = async () => {
    if (!stored) return
    setTestState({ kind: 'testing' })
    try {
      await pingProvider(stored)
      setTestState({ kind: 'ok' })
    } catch (err) {
      setTestState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleRemove = () => {
    if (!confirm(`Remove the saved ${meta.label} key from this browser?`)) return
    removeKey(provider)
  }

  const currentModel = stored?.model ?? (status.kind === 'ok' ? status.model : undefined)
  const bestModel = models.length ? pickBestModel(provider, models) : undefined
  // Make sure the saved model is in the dropdown even if filtered out by ranking.
  const dropdownModels = useMemo(() => {
    if (!models.length) return []
    if (currentModel && !models.includes(currentModel)) return [currentModel, ...models]
    return models
  }, [models, currentModel])

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <div className="space-y-1 text-[11px] leading-relaxed">
          <p className="font-semibold">Keys stay in your browser.</p>
          <p>
            API keys are saved only to this browser&rsquo;s <code className="rounded bg-emerald-100 px-1">localStorage</code>{' '}
            and used to call each provider directly from this page. They are never sent to the LogSim
            backend, never written to scenario files, and never leave your machine. Clear your browser
            data to remove them.
          </p>
        </div>
      </div>

      <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Label className="text-[11px] font-medium text-gray-700">Provider</Label>
            <select
              value={provider}
              onChange={e => setProvider(e.target.value as AIProvider)}
              className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs"
            >
              {PROVIDER_ORDER.map(p => {
                const m = AI_PROVIDER_META[p]
                const has = keys.some(k => k.provider === p)
                const isDef = defaultProvider === p
                const suffix = isDef ? ' • default' : has ? ' • saved' : ''
                return (
                  <option key={p} value={p}>
                    {m.icon} {m.label}{suffix}
                  </option>
                )
              })}
            </select>
            <p className="mt-1 text-[11px] text-gray-500">{meta.description}</p>
          </div>
          <a
            href={meta.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-50"
          >
            Get key <ExternalLink className="h-3 w-3" />
          </a>
        </header>

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label className="text-[11px] font-medium text-gray-700">API key</Label>
            {stored && (
              <Badge variant="secondary" className="text-[10px]">
                saved
              </Badge>
            )}
            {isDefault && (
              <Badge className="bg-emerald-600 text-[10px] text-white hover:bg-emerald-600">
                default
              </Badge>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              type={showKey ? 'text' : 'password'}
              placeholder={meta.keyHint}
              className="h-8 flex-1 text-xs font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[11px]"
              onClick={() => setShowKey(s => !s)}
              type="button"
            >
              {showKey ? 'Hide' : 'Show'}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-gray-700">Model</Label>
          <div className="flex items-center gap-2">
            {stored && dropdownModels.length > 0 ? (
              <select
                value={currentModel ?? ''}
                onChange={e => handleSelectModel(e.target.value)}
                className="h-8 flex-1 rounded-md border border-gray-200 bg-white px-2 font-mono text-xs"
              >
                {dropdownModels.map(id => (
                  <option key={id} value={id}>
                    {id}
                    {id === bestModel ? ' — recommended' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex h-8 flex-1 items-center rounded-md border border-gray-200 bg-gray-50 px-3 font-mono text-xs text-gray-700">
                {status.kind === 'detecting'
                  ? 'Detecting available models…'
                  : stored
                    ? currentModel ?? '—'
                    : 'Save your key to detect available models'}
              </div>
            )}
            {stored && (
              <button
                type="button"
                onClick={refresh}
                disabled={status.kind === 'detecting'}
                title="Refresh available models"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', status.kind === 'detecting' && 'animate-spin')} />
              </button>
            )}
          </div>
          <p className="text-[10px] text-gray-400">
            {stored && dropdownModels.length > 0
              ? `${dropdownModels.length} model${dropdownModels.length === 1 ? '' : 's'} available — recommended is auto-selected, change anytime.`
              : 'Auto-selected after saving — the most capable model your key can access.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            className="h-7 text-[11px]"
            onClick={detectAndSave}
            disabled={!canSave || status.kind === 'detecting'}
          >
            {status.kind === 'detecting' ? 'Detecting…' : stored ? 'Save changes' : 'Save key'}
          </Button>
          {stored && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={handleTest}
              disabled={testState.kind === 'testing'}
            >
              {testState.kind === 'testing' ? 'Testing…' : 'Test'}
            </Button>
          )}
          {stored && !isDefault && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => setDefault(provider)}
            >
              Set as default
            </Button>
          )}
          <div className="ml-auto">
            {stored && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={handleRemove}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Remove
              </Button>
            )}
          </div>
        </div>

        {status.kind === 'error' && (
          <div className="rounded-md bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
            ✗ {status.message}
          </div>
        )}
        {status.kind === 'ok' && status.count > 0 && (
          <div className="rounded-md bg-green-50 px-3 py-1.5 text-[11px] text-green-700">
            ✓ Key works — {status.count} model{status.count === 1 ? '' : 's'} available.
          </div>
        )}
        {testState.kind === 'testing' && (
          <div className="rounded-md bg-blue-50 px-3 py-1.5 text-[11px] text-blue-700">
            ⏳ Sending a tiny request to verify {currentModel ?? 'the model'}…
          </div>
        )}
        {testState.kind === 'ok' && (
          <div className="rounded-md bg-green-50 px-3 py-1.5 text-[11px] text-green-700">
            ✓ {currentModel ?? 'Model'} responded successfully.
          </div>
        )}
        {testState.kind === 'error' && (
          <div className="rounded-md bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
            ✗ {testState.message}
          </div>
        )}
      </section>
    </div>
  )
}
