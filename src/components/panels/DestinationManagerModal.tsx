'use client'
import React, { useEffect, useState } from 'react'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useDestinationsStore } from '@/store/useDestinationsStore'
import { testHecConnection } from '@/lib/criblForwarder'
import { DESTINATION_TYPE_META } from '@/types/destinations'
import type { CriblHecDestination, DestinationConfig, DestinationType } from '@/types/destinations'

// ── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ id }: { id: string }) {
  const { statuses, errors } = useDestinationsStore()
  const status = statuses[id]
  const error = errors[id]

  if (status === 'error' && error)
    return <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" title={error} />
  if (status === 'sending')
    return <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
  if (status === 'idle')
    return <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
  return <span className="h-2 w-2 rounded-full bg-gray-300 shrink-0" />
}

// ── Cribl HEC form ───────────────────────────────────────────────────────────

interface HecFormProps {
  initial: Partial<CriblHecDestination>
  onSave: (data: Omit<CriblHecDestination, 'id' | 'type'>) => void
  onCancel: () => void
  isEdit: boolean
  destId?: string   // provided when editing, so we can show sent stats
}

type TestState = 'idle' | 'testing' | 'ok' | 'error'

function CriblHecForm({ initial, onSave, onCancel, isEdit, destId }: HecFormProps) {
  const { sentCounts, lastSentAt } = useDestinationsStore()

  const [name, setName]           = useState(initial.name ?? '')
  const [url, setUrl]             = useState(initial.url ?? '')
  const [token, setToken]         = useState(initial.token ?? '')
  const [source, setSource]       = useState(initial.source ?? '')
  const [sourcetype, setSourcetype] = useState(initial.sourcetype ?? '')
  const [batchSize, setBatchSize] = useState(String(initial.batchSize ?? 100))
  const [enabled, setEnabled]     = useState(initial.enabled ?? true)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testError, setTestError] = useState('')

  const isValid = name.trim().length > 0 && url.trim().length > 0 && token.trim().length > 0

  const buildDest = (): Omit<CriblHecDestination, 'id' | 'type'> => ({
    name: name.trim(),
    url: url.trim(),
    token: token.trim(),
    source: source.trim(),
    // Empty string = auto-map per log generator (mysql → mysql:query, …).
    // Setting a value pins every event to the same sourcetype.
    sourcetype: sourcetype.trim(),
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
    <div className="space-y-3">
      {/* Name */}
      <div className="space-y-1">
        <Label className="text-xs font-medium text-gray-700">
          Destination Name <span className="text-red-500">*</span>
        </Label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Production Cribl"
          className="h-7 text-xs"
          autoFocus
        />
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-xs font-medium text-gray-700">Active</p>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable destination" />
      </div>

      {/* HEC URL */}
      <div className="space-y-1">
        <Label className="text-xs font-medium text-gray-700">
          HEC Endpoint URL <span className="text-red-500">*</span>
        </Label>
        <Input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://cribl.example.com:9000/services/collector/event"
          className="h-7 text-xs font-mono"
          autoComplete="off"
        />
        <p className="text-[10px] text-gray-400">Cribl Stream → Sources → Splunk HEC → endpoint URL</p>
      </div>

      {/* HEC Token */}
      <div className="space-y-1">
        <Label className="text-xs font-medium text-gray-700">
          HEC Token <span className="text-red-500">*</span>
        </Label>
        <Input
          value={token}
          onChange={e => setToken(e.target.value)}
          type="password"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          className="h-7 text-xs font-mono"
          autoComplete="off"
        />
      </div>

      {/* Source override + Sourcetype */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs font-medium text-gray-700">Source Override</Label>
          <Input
            value={source}
            onChange={e => setSource(e.target.value)}
            placeholder="(uses log channel)"
            className="h-7 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs font-medium text-gray-700">Sourcetype Override</Label>
          <Input
            value={sourcetype}
            onChange={e => setSourcetype(e.target.value)}
            placeholder="(auto per generator)"
            className="h-7 text-xs font-mono"
          />
        </div>
      </div>

      {/* Batch size */}
      <div className="flex items-center gap-2">
        <Label className="text-xs font-medium text-gray-700 shrink-0">Batch Size</Label>
        <Input
          value={batchSize}
          onChange={e => setBatchSize(e.target.value)}
          type="number"
          min={1}
          max={500}
          className="h-7 text-xs w-20"
        />
        <span className="text-[10px] text-gray-400">events / request (1–500)</span>
      </div>

      {/* Test result */}
      {testState !== 'idle' && (
        <div className={`rounded-md px-3 py-2 text-xs ${
          testState === 'testing' ? 'bg-blue-50 text-blue-700' :
          testState === 'ok'      ? 'bg-green-50 text-green-700' :
                                    'bg-red-50 text-red-700'
        }`}>
          {testState === 'testing' && '⏳ Sending test event…'}
          {testState === 'ok'      && '✓ Connection successful — test event accepted'}
          {testState === 'error'   && `✗ ${testError}`}
        </div>
      )}

      {/* Stats */}
      {isEdit && (sentCount > 0 || lastSent) && (
        <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-[10px] text-gray-500 space-y-0.5">
          <div className="flex justify-between">
            <span>Events forwarded this session</span>
            <span className="font-mono font-medium text-gray-700">{sentCount.toLocaleString()}</span>
          </div>
          {lastSent && (
            <div className="flex justify-between">
              <span>Last sent</span>
              <span className="font-mono">{new Date(lastSent).toLocaleTimeString()}</span>
            </div>
          )}
        </div>
      )}

      {/* Form footer */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-100">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={handleTest}
          disabled={!isValid || testState === 'testing'}
        >
          {testState === 'testing' ? 'Testing…' : 'Test Connection'}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" className="text-xs" onClick={() => onSave(buildDest())} disabled={!isValid}>
            {isEdit ? 'Save Changes' : 'Add Destination'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Destination list card ────────────────────────────────────────────────────

function DestinationCard({
  dest,
  onEdit,
}: {
  dest: DestinationConfig
  onEdit: () => void
}) {
  const { toggleDestination, removeDestination, statuses, errors } = useDestinationsStore()
  const status = statuses[dest.id]
  const error  = errors[dest.id]
  const meta   = DESTINATION_TYPE_META[dest.type]

  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-md border border-gray-200 bg-white px-3 py-2.5">
      <StatusDot id={dest.id} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-gray-900 truncate">{dest.name}</span>
          <span className="shrink-0 rounded px-1 py-0 text-[9px] font-medium bg-gray-100 text-gray-500">
            {meta.icon} {meta.label}
          </span>
        </div>
        <p className="text-[10px] text-gray-400 font-mono truncate mt-0.5">
          {(dest as CriblHecDestination).url}
        </p>
        {status === 'error' && error && (
          <p className="text-[10px] text-red-500 truncate">{error}</p>
        )}
      </div>

      <Switch
        checked={dest.enabled}
        onCheckedChange={() => toggleDestination(dest.id)}
        aria-label={`Toggle ${dest.name}`}
        className="shrink-0"
      />

      <button
        onClick={onEdit}
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        title="Edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={() => removeDestination(dest.id)}
        className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
        title="Remove"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ── Main modal ───────────────────────────────────────────────────────────────

// Which view is shown inside the modal
type ModalView =
  | { mode: 'list' }
  | { mode: 'add'; type: DestinationType }
  | { mode: 'edit'; id: string }

export function DestinationManagerModal() {
  const {
    destinations,
    showManagerModal,
    editingId,
    setShowManagerModal,
    setEditingId,
    addDestination,
    updateDestination,
  } = useDestinationsStore()

  const [view, setView] = useState<ModalView>({ mode: 'list' })

  // Sync external editingId requests (e.g. from the SimulationControls dropdown)
  useEffect(() => {
    if (showManagerModal && editingId !== null) {
      setView({ mode: 'edit', id: editingId })
    } else if (showManagerModal) {
      setView({ mode: 'list' })
    }
  }, [showManagerModal, editingId])

  const handleClose = () => {
    setShowManagerModal(false)
    setEditingId(null)
    setView({ mode: 'list' })
  }

  // ── Renders ──────────────────────────────────────────────────────────────

  const renderTitle = () => {
    if (view.mode === 'add') return `Add Destination — ${DESTINATION_TYPE_META[view.type].label}`
    if (view.mode === 'edit') {
      const dest = destinations.find(d => d.id === (view as { mode: 'edit'; id: string }).id)
      return `Edit — ${dest?.name ?? 'Destination'}`
    }
    return 'Log Destinations'
  }

  const renderList = () => (
    <div className="space-y-2">
      {destinations.length === 0 ? (
        <div className="py-8 text-center text-xs text-gray-400">
          No destinations configured yet.
          <br />
          Add one to start forwarding logs in real time.
        </div>
      ) : (
        destinations.map(dest => (
          <DestinationCard
            key={dest.id}
            dest={dest}
            onEdit={() => setView({ mode: 'edit', id: dest.id })}
          />
        ))
      )}

      <div className="pt-2 flex justify-between items-center border-t border-gray-100">
        <p className="text-[10px] text-gray-400">
          {destinations.filter(d => d.enabled).length} of {destinations.length} active
        </p>
        {/* Only one type for now; when more exist this becomes a dropdown */}
        <Button
          size="sm"
          className="text-xs h-7"
          onClick={() => setView({ mode: 'add', type: 'cribl-hec' })}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Destination
        </Button>
      </div>
    </div>
  )

  const renderForm = () => {
    if (view.mode === 'add') {
      return (
        <CriblHecForm
          initial={{}}
          isEdit={false}
          onCancel={() => setView({ mode: 'list' })}
          onSave={(data) => {
            addDestination({ ...data, type: 'cribl-hec' })
            setView({ mode: 'list' })
          }}
        />
      )
    }

    if (view.mode === 'edit') {
      const dest = destinations.find(d => d.id === view.id) as CriblHecDestination | undefined
      if (!dest) return null
      return (
        <CriblHecForm
          initial={dest}
          isEdit={true}
          destId={dest.id}
          onCancel={() => setView({ mode: 'list' })}
          onSave={(data) => {
            updateDestination(dest.id, data)
            setView({ mode: 'list' })
          }}
        />
      )
    }
  }

  return (
    <Dialog open={showManagerModal} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold flex items-center gap-2">
            {view.mode !== 'list' && (
              <button
                onClick={() => setView({ mode: 'list' })}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                title="Back to list"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {renderTitle()}
          </DialogTitle>
        </DialogHeader>

        <div className="py-1">
          {view.mode === 'list' ? renderList() : renderForm()}
        </div>
      </DialogContent>
    </Dialog>
  )
}
