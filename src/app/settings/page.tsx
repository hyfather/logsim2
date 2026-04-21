'use client'
import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { ArrowLeft, Plus, Trash2, Zap, Server, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { testHecConnection } from '@/lib/criblForwarder'
import { DESTINATION_TYPE_META } from '@/types/destinations'
import type { CriblHecDestination, DestinationConfig, DestinationType } from '@/types/destinations'

type TestState = 'idle' | 'testing' | 'ok' | 'error'

type SelectionState =
  | { kind: 'none' }
  | { kind: 'new'; type: DestinationType }
  | { kind: 'edit'; id: string }

// ── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ id, size = 'sm' }: { id: string; size?: 'sm' | 'md' }) {
  const { statuses, errors } = useDestinationsStore()
  const status = statuses[id]
  const error = errors[id]
  const sz = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2'

  if (status === 'error' && error)
    return <span className={cn(sz, 'rounded-full bg-red-500 shrink-0')} title={error} />
  if (status === 'sending')
    return <span className={cn(sz, 'rounded-full bg-blue-500 animate-pulse shrink-0')} />
  if (status === 'idle')
    return <span className={cn(sz, 'rounded-full bg-green-500 shrink-0')} />
  return <span className={cn(sz, 'rounded-full bg-gray-300 shrink-0')} />
}

// ── Left rail: destinations list ─────────────────────────────────────────────

function DestinationsList({
  destinations,
  selection,
  onSelect,
  onNew,
}: {
  destinations: DestinationConfig[]
  selection: SelectionState
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-400">
          Destinations
        </span>
        <span className="text-[10px] text-gray-400">
          {destinations.filter(d => d.enabled).length}/{destinations.length} active
        </span>
      </div>

      {destinations.length === 0 && (
        <div className="rounded-md border border-dashed border-gray-200 px-3 py-6 text-center text-[11px] text-gray-400">
          No destinations yet.
        </div>
      )}

      {destinations.map(dest => {
        const meta = DESTINATION_TYPE_META[dest.type]
        const active = selection.kind === 'edit' && selection.id === dest.id
        return (
          <button
            key={dest.id}
            onClick={() => onSelect(dest.id)}
            className={cn(
              'group flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
              active
                ? 'bg-blue-50 ring-1 ring-blue-200'
                : 'hover:bg-gray-50'
            )}
          >
            <StatusDot id={dest.id} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={cn('truncate text-xs font-medium', active ? 'text-blue-900' : 'text-gray-800')}>
                  {dest.name || '(unnamed)'}
                </span>
                {!dest.enabled && (
                  <span className="rounded bg-gray-100 px-1 text-[9px] font-medium text-gray-500">
                    off
                  </span>
                )}
              </div>
              <div className="truncate text-[10px] text-gray-400">
                {meta.icon} {meta.label}
              </div>
            </div>
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-opacity',
                active ? 'text-blue-500 opacity-100' : 'text-gray-300 opacity-0 group-hover:opacity-100'
              )}
            />
          </button>
        )
      })}

      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 justify-start gap-2 text-xs"
        onClick={onNew}
      >
        <Plus className="h-3.5 w-3.5" />
        New destination
      </Button>
    </div>
  )
}

// ── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <header>
        <h3 className="text-xs font-semibold text-gray-900">{title}</h3>
        {description && <p className="mt-0.5 text-[11px] text-gray-500">{description}</p>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function FieldRow({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] font-medium text-gray-700">
        {label} {required && <span className="text-red-500">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[10px] text-gray-400">{hint}</p>}
    </div>
  )
}

// ── Cribl HEC form ───────────────────────────────────────────────────────────

interface CriblHecFormProps {
  initial: Partial<CriblHecDestination>
  isEdit: boolean
  destId?: string
  onSave: (data: Omit<CriblHecDestination, 'id' | 'type'>) => void
  onDelete?: () => void
  onCancel: () => void
}

function CriblHecForm({ initial, isEdit, destId, onSave, onDelete, onCancel }: CriblHecFormProps) {
  const { sentCounts, lastSentAt } = useDestinationsStore()

  const [name, setName]             = useState(initial.name ?? '')
  const [enabled, setEnabled]       = useState(initial.enabled ?? true)
  const [url, setUrl]               = useState(initial.url ?? '')
  const [token, setToken]           = useState(initial.token ?? '')
  const [source, setSource]         = useState(initial.source ?? '')
  const [sourcetype, setSourcetype] = useState(initial.sourcetype ?? 'logsim:json')
  const [batchSize, setBatchSize]   = useState(String(initial.batchSize ?? 100))
  const [testState, setTestState]   = useState<TestState>('idle')
  const [testError, setTestError]   = useState('')

  // Reset local state when switching between destinations
  useEffect(() => {
    setName(initial.name ?? '')
    setEnabled(initial.enabled ?? true)
    setUrl(initial.url ?? '')
    setToken(initial.token ?? '')
    setSource(initial.source ?? '')
    setSourcetype(initial.sourcetype ?? 'logsim:json')
    setBatchSize(String(initial.batchSize ?? 100))
    setTestState('idle')
    setTestError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destId, isEdit])

  const isValid = name.trim().length > 0 && url.trim().length > 0 && token.trim().length > 0

  const buildDest = (): Omit<CriblHecDestination, 'id' | 'type'> => ({
    name: name.trim(),
    url: url.trim(),
    token: token.trim(),
    source: source.trim(),
    sourcetype: sourcetype.trim() || 'logsim:json',
    batchSize: Math.max(1, Math.min(500, parseInt(batchSize, 10) || 100)),
    enabled,
  })

  const handleTest = async () => {
    if (!isValid) return
    setTestState('testing')
    setTestError('')
    try {
      await testHecConnection({ ...buildDest(), id: destId ?? '__test__', type: 'cribl-hec' })
      setTestState('ok')
    } catch (err) {
      setTestState('error')
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  const sentCount = destId ? (sentCounts[destId] ?? 0) : 0
  const lastSent  = destId ? lastSentAt[destId] : undefined

  return (
    <div className="space-y-4">
      {/* Title strip */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            <h2 className="truncate text-base font-semibold text-gray-900">
              {isEdit ? (name || '(unnamed destination)') : 'New Cribl Stream HEC destination'}
            </h2>
            <Badge variant="secondary" className="text-[10px]">
              {DESTINATION_TYPE_META['cribl-hec'].label}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            {DESTINATION_TYPE_META['cribl-hec'].description}
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5">
          <span className="text-[11px] font-medium text-gray-600">Active</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable destination" />
        </div>
      </div>

      {/* General */}
      <Section title="General" description="How this destination appears in menus and logs.">
        <FieldRow label="Name" required>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Production Cribl"
            className="h-8 text-xs"
            autoFocus={!isEdit}
          />
        </FieldRow>
      </Section>

      {/* Connection */}
      <Section title="Connection" description="Where to send events. Cribl Stream → Sources → Splunk HEC.">
        <FieldRow label="HEC endpoint URL" required>
          <Input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://cribl.example.com:9000/services/collector/event"
            className="h-8 text-xs font-mono"
            autoComplete="off"
          />
        </FieldRow>

        <FieldRow label="HEC token" required>
          <Input
            value={token}
            onChange={e => setToken(e.target.value)}
            type="password"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="h-8 text-xs font-mono"
            autoComplete="off"
          />
        </FieldRow>

        <div className="flex items-center justify-between gap-3 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={handleTest}
            disabled={!isValid || testState === 'testing'}
          >
            {testState === 'testing' ? 'Testing…' : 'Test connection'}
          </Button>
          {testState !== 'idle' && (
            <div className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-[11px]',
              testState === 'testing' && 'bg-blue-50 text-blue-700',
              testState === 'ok'      && 'bg-green-50 text-green-700',
              testState === 'error'   && 'bg-red-50 text-red-700',
            )}>
              {testState === 'testing' && '⏳ Sending test event…'}
              {testState === 'ok'      && '✓ Connection successful — test event accepted'}
              {testState === 'error'   && `✗ ${testError}`}
            </div>
          )}
        </div>
      </Section>

      {/* Event metadata */}
      <Section title="Event metadata" description="Optional overrides applied to every forwarded event.">
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Source override" hint="Blank = use the log's channel">
            <Input
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="(use channel)"
              className="h-8 text-xs font-mono"
            />
          </FieldRow>
          <FieldRow label="Sourcetype">
            <Input
              value={sourcetype}
              onChange={e => setSourcetype(e.target.value)}
              placeholder="logsim:json"
              className="h-8 text-xs font-mono"
            />
          </FieldRow>
        </div>
      </Section>

      {/* Delivery */}
      <Section title="Delivery" description="How events are batched before being sent.">
        <FieldRow label="Batch size" hint="Events per HTTP request (1–500)">
          <div className="flex items-center gap-2">
            <Input
              value={batchSize}
              onChange={e => setBatchSize(e.target.value)}
              type="number"
              min={1}
              max={500}
              className="h-8 w-24 text-xs"
            />
            <span className="text-[10px] text-gray-400">events / request</span>
          </div>
        </FieldRow>
      </Section>

      {/* Stats */}
      {isEdit && (sentCount > 0 || lastSent) && (
        <Section title="Activity">
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <div className="text-gray-500">Forwarded this session</div>
              <div className="font-mono font-medium text-gray-800">{sentCount.toLocaleString()}</div>
            </div>
            {lastSent && (
              <div>
                <div className="text-gray-500">Last sent</div>
                <div className="font-mono text-gray-800">{new Date(lastSent).toLocaleString()}</div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Footer */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-between border-t border-gray-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div>
          {isEdit && onDelete && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={onDelete}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => onSave(buildDest())}
            disabled={!isValid}
          >
            {isEdit ? 'Save changes' : 'Create destination'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyDetail({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-lg border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <Server className="mb-3 h-8 w-8 text-gray-300" />
      <h3 className="text-sm font-semibold text-gray-700">No destination selected</h3>
      <p className="mt-1 max-w-sm text-[11px] text-gray-500">
        Pick a destination from the left to edit its settings, or create a new one to start
        forwarding logs from the simulator.
      </p>
      <Button size="sm" className="mt-4 h-8 text-xs" onClick={onNew}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        New destination
      </Button>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const {
    destinations,
    addDestination,
    updateDestination,
    removeDestination,
  } = useDestinationsStore()

  const initialId = searchParams.get('destination')

  const [selection, setSelection] = useState<SelectionState>(() => {
    if (initialId && initialId === 'new') return { kind: 'new', type: 'cribl-hec' }
    if (initialId) return { kind: 'edit', id: initialId }
    return { kind: 'none' }
  })

  // If URL param changes externally, honour it.
  useEffect(() => {
    if (!initialId) return
    if (initialId === 'new') setSelection({ kind: 'new', type: 'cribl-hec' })
    else setSelection({ kind: 'edit', id: initialId })
  }, [initialId])

  // If a selected destination disappears (deleted), fall back to none.
  useEffect(() => {
    if (selection.kind === 'edit' && !destinations.find(d => d.id === selection.id)) {
      setSelection({ kind: 'none' })
    }
  }, [destinations, selection])

  const selected = useMemo(() => {
    if (selection.kind !== 'edit') return null
    return destinations.find(d => d.id === selection.id) as CriblHecDestination | undefined
  }, [destinations, selection])

  const handleNew = () => setSelection({ kind: 'new', type: 'cribl-hec' })

  const handleSaveNew = (data: Omit<CriblHecDestination, 'id' | 'type'>) => {
    const id = addDestination({ ...data, type: 'cribl-hec' })
    setSelection({ kind: 'edit', id })
  }

  const handleSaveEdit = (id: string) => (data: Omit<CriblHecDestination, 'id' | 'type'>) => {
    updateDestination(id, data)
  }

  const handleDelete = (id: string) => () => {
    if (!confirm('Delete this destination? This cannot be undone.')) return
    removeDestination(id)
    setSelection({ kind: 'none' })
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-gray-50">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2.5">
        <Link
          href="/editor"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to editor
        </Link>
        <div className="h-4 w-px bg-gray-200" />
        <h1 className="text-sm font-semibold text-gray-900">Settings</h1>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Category rail */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-gray-200 bg-white">
          <nav className="p-2">
            <div className="rounded-md bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">
              Log destinations
            </div>
          </nav>
        </aside>

        {/* Content */}
        <main className="flex flex-1 overflow-hidden">
          {/* Destinations list */}
          <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-200 bg-white p-3">
            <DestinationsList
              destinations={destinations}
              selection={selection}
              onSelect={(id) => setSelection({ kind: 'edit', id })}
              onNew={handleNew}
            />
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl p-6">
              {selection.kind === 'none' && <EmptyDetail onNew={handleNew} />}

              {selection.kind === 'new' && (
                <CriblHecForm
                  initial={{}}
                  isEdit={false}
                  onCancel={() => {
                    if (router.back) router.back()
                    setSelection({ kind: 'none' })
                  }}
                  onSave={handleSaveNew}
                />
              )}

              {selection.kind === 'edit' && selected && (
                <CriblHecForm
                  key={selected.id}
                  initial={selected}
                  isEdit={true}
                  destId={selected.id}
                  onCancel={() => setSelection({ kind: 'none' })}
                  onSave={handleSaveEdit(selected.id)}
                  onDelete={handleDelete(selected.id)}
                />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
