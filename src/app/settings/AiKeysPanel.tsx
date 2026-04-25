'use client'
import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useAIKeysStore } from '@/store/useAIKeysStore'
import { AI_PROVIDER_META, type AIProvider } from '@/types/aiKeys'
import { pingProvider } from '@/lib/aiClient'

type TestState = 'idle' | 'testing' | 'ok' | 'error'

const PROVIDER_ORDER: AIProvider[] = ['anthropic', 'openai', 'gemini']

export function AiKeysPanel() {
  const { keys, hydrated } = useAIKeysStore()
  const defaultProvider = keys.find(k => k.isDefault)?.provider

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

      <div className="space-y-3">
        {PROVIDER_ORDER.map(provider => (
          <ProviderCard
            key={provider}
            provider={provider}
            hasAnyKey={hydrated && keys.length > 0}
            isDefault={defaultProvider === provider}
          />
        ))}
      </div>
    </div>
  )
}

function ProviderCard({
  provider,
  hasAnyKey,
  isDefault,
}: {
  provider: AIProvider
  hasAnyKey: boolean
  isDefault: boolean
}) {
  const meta = AI_PROVIDER_META[provider]
  const stored = useAIKeysStore(s => s.keys.find(k => k.provider === provider))
  const upsertKey = useAIKeysStore(s => s.upsertKey)
  const removeKey = useAIKeysStore(s => s.removeKey)
  const setDefault = useAIKeysStore(s => s.setDefault)

  const [apiKey, setApiKey] = useState(stored?.apiKey ?? '')
  const [model, setModel] = useState(stored?.model ?? meta.defaultModel)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testError, setTestError] = useState('')
  const [showKey, setShowKey] = useState(false)

  // Sync from store changes (e.g. after save).
  useEffect(() => {
    setApiKey(stored?.apiKey ?? '')
    setModel(stored?.model ?? meta.defaultModel)
    setTestState('idle')
    setTestError('')
  }, [stored?.apiKey, stored?.model, meta.defaultModel])

  const dirty = useMemo(() => {
    if (!stored) return apiKey.trim().length > 0
    return apiKey.trim() !== stored.apiKey || model.trim() !== stored.model
  }, [apiKey, model, stored])

  const isValid = apiKey.trim().length > 0 && model.trim().length > 0

  const handleSave = () => {
    if (!isValid) return
    upsertKey({ provider, apiKey, model })
  }

  const handleRemove = () => {
    if (!confirm(`Remove the saved ${meta.label} key from this browser?`)) return
    removeKey(provider)
  }

  const handleTest = async () => {
    if (!isValid) return
    setTestState('testing')
    setTestError('')
    try {
      await pingProvider({
        provider,
        apiKey: apiKey.trim(),
        model: model.trim(),
        isDefault: false,
        createdAt: '',
        updatedAt: '',
      })
      setTestState('ok')
    } catch (err) {
      setTestState('error')
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none">{meta.icon}</span>
            <h3 className="text-sm font-semibold text-gray-900">{meta.label}</h3>
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
          <p className="mt-0.5 text-[11px] text-gray-500">{meta.description}</p>
        </div>
        <a
          href={meta.consoleUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-50"
        >
          Get key <ExternalLink className="h-3 w-3" />
        </a>
      </header>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-gray-700">API key</Label>
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
          <Input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={meta.defaultModel}
            className="h-8 text-xs font-mono"
            list={`models-${provider}`}
          />
          <datalist id={`models-${provider}`}>
            {meta.modelExamples.map(m => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="text-[10px] text-gray-400">
            Suggestions: {meta.modelExamples.join(', ')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 text-[11px]"
          onClick={handleSave}
          disabled={!isValid || !dirty}
        >
          {stored ? 'Save changes' : 'Save key'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={handleTest}
          disabled={!isValid || testState === 'testing'}
        >
          {testState === 'testing' ? 'Testing…' : 'Test'}
        </Button>
        {stored && !isDefault && hasAnyKey && (
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

      {testState !== 'idle' && (
        <div
          className={cn(
            'rounded-md px-3 py-1.5 text-[11px]',
            testState === 'testing' && 'bg-blue-50 text-blue-700',
            testState === 'ok' && 'bg-green-50 text-green-700',
            testState === 'error' && 'bg-red-50 text-red-700',
          )}
        >
          {testState === 'testing' && '⏳ Sending a tiny request to verify the key…'}
          {testState === 'ok' && '✓ Key works — provider responded successfully.'}
          {testState === 'error' && `✗ ${testError}`}
        </div>
      )}
    </section>
  )
}
