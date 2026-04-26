'use client'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { getRegistryEntry } from '@/registry/nodeRegistry'
import { getNodeAddress } from '@/lib/network'
import { getNodeEmoji } from '@/lib/nodeAppearance'
import type { ConfigField, ScenarioNode } from '@/types/nodes'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: ConfigField
  value: unknown
  onChange: (key: string, value: unknown) => void
}) {
  const handleChange = useCallback((val: unknown) => onChange(field.key, val), [field.key, onChange])
  switch (field.type) {
    case 'string':
      return (
        <Input
          value={String(value ?? '')}
          onChange={e => handleChange(e.target.value)}
          placeholder={field.placeholder}
          className="h-7 text-xs"
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          value={String(value ?? field.defaultValue ?? 0)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={e => handleChange(Number(e.target.value))}
          className="h-7 font-mono text-xs"
        />
      )
    case 'boolean':
      return <Switch checked={Boolean(value)} onCheckedChange={handleChange} />
    case 'select':
      return (
        <Select value={String(value ?? '')} onValueChange={handleChange}>
          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Select…" /></SelectTrigger>
          <SelectContent>
            {field.options?.map(opt => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'slider': {
      const numVal = Number(value ?? field.defaultValue ?? 0)
      return (
        <div className="flex items-center gap-2">
          <Slider
            value={[numVal]}
            min={field.min ?? 0}
            max={field.max ?? 100}
            step={field.step ?? 1}
            onValueChange={([v]) => handleChange(v)}
            className="flex-1"
          />
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-slate-500">
            {numVal.toFixed(field.step && field.step < 1 ? 2 : 0)}
          </span>
        </div>
      )
    }
    case 'code':
      return (
        <Textarea
          value={String(value ?? '')}
          onChange={e => handleChange(e.target.value)}
          className="h-20 resize-none font-mono text-xs"
          placeholder={field.placeholder}
        />
      )
    default:
      return <Input value={String(value ?? '')} onChange={e => handleChange(e.target.value)} className="h-7 text-xs" />
  }
}

function groupBySection(fields: ConfigField[]): Record<string, ConfigField[]> {
  const groups: Record<string, ConfigField[]> = {}
  for (const field of fields) {
    const section = field.section || 'General'
    if (!groups[section]) groups[section] = []
    groups[section].push(field)
  }
  return groups
}

export function NodeInspectorPanel({ nodeData }: { nodeData: ScenarioNode }) {
  const { nodes, edges, updateNode, deleteNode, renameNode } = useScenarioStore()
  const { selectNode } = useUIStore()
  const [labelDraft, setLabelDraft] = useState(nodeData.label)
  const allNodes = nodes.map(n => n.data)
  const emoji = getNodeEmoji(nodeData)

  useEffect(() => { setLabelDraft(nodeData.label) }, [nodeData.label, nodeData.id])

  const configSchema = useMemo(() => {
    const entry = getRegistryEntry(nodeData.type, nodeData.serviceType)
    return entry?.configSchema || []
  }, [nodeData.type, nodeData.serviceType])

  const configValues = (nodeData.config as Record<string, unknown>) || {}

  const commitLabel = useCallback(() => {
    const next = labelDraft.trim() || nodeData.label
    if (next !== nodeData.label) renameNode(nodeData.id, next)
  }, [labelDraft, nodeData.id, nodeData.label, renameNode])

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    const newConfig = { ...(nodeData.config as Record<string, unknown>), [key]: value }
    updateNode(nodeData.id, { config: newConfig })
  }, [nodeData.id, nodeData.config, updateNode])

  const handleAddressChange = useCallback((value: string) => {
    if (nodeData.type === 'service') {
      updateNode(nodeData.id, { privateIp: value })
      return
    }
    if (nodeData.type === 'virtual_server') {
      const cfg = { ...(nodeData.config as Record<string, unknown>), privateIp: value }
      updateNode(nodeData.id, { config: cfg })
      return
    }
    if (nodeData.type === 'vpc' || nodeData.type === 'subnet') {
      const cfg = { ...(nodeData.config as Record<string, unknown>), cidr: value }
      updateNode(nodeData.id, { config: cfg })
    }
  }, [nodeData.id, nodeData.type, nodeData.config, updateNode])

  const handleDelete = useCallback(() => {
    deleteNode(nodeData.id)
    selectNode(null)
  }, [deleteNode, nodeData.id, selectNode])

  const sections = groupBySection(configSchema)
  const address = getNodeAddress(nodeData, allNodes)

  // Connections touching this node
  const connections = useMemo(() => {
    const out: Array<{ id: string; direction: '→' | '←'; otherId: string; label: string }> = []
    for (const e of edges) {
      const c = e.data
      if (!c) continue
      if (c.sourceId === nodeData.id) {
        const other = nodes.find(n => n.id === c.targetId)
        out.push({ id: c.id, direction: '→', otherId: other?.data.label ?? c.targetId, label: `${c.protocol.toUpperCase()}:${c.port}` })
      } else if (c.targetId === nodeData.id) {
        const other = nodes.find(n => n.id === c.sourceId)
        out.push({ id: c.id, direction: '←', otherId: other?.data.label ?? c.sourceId, label: `${c.protocol.toUpperCase()}:${c.port}` })
      }
    }
    return out
  }, [edges, nodes, nodeData.id])

  const addressLabel = nodeData.type === 'vpc' || nodeData.type === 'subnet' ? 'CIDR' : 'Address'
  const addressValue =
    nodeData.type === 'vpc' || nodeData.type === 'subnet'
      ? String((nodeData.config as { cidr?: string }).cidr ?? '')
      : nodeData.type === 'service'
        ? (nodeData.privateIp?.trim() || address)
        : String((nodeData.config as { privateIp?: string }).privateIp ?? '')

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3.5 py-3">
        <span className="text-[14px] leading-none">{emoji}</span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-slate-900">{nodeData.label}</span>
        <button
          type="button"
          onClick={() => selectNode(null)}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          title="Close inspector"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Identity */}
        <section className="flex flex-col gap-3 border-b border-slate-200 px-3.5 py-3.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-slate-500">Label</label>
            <Input
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="h-7 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-slate-500">{addressLabel}</label>
            <Input
              value={addressValue}
              onChange={e => handleAddressChange(e.target.value)}
              className="h-7 font-mono text-xs"
            />
          </div>
          {nodeData.channel && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-slate-500">Channel</label>
              <div className="font-mono text-[12px] text-slate-700">{nodeData.channel}</div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-slate-500">Resource</label>
            <div className="text-[12px] capitalize text-slate-700">
              {nodeData.serviceType ?? nodeData.type.replace('_', ' ')}
            </div>
          </div>
        </section>

        {/* Config schema sections (Log generation, etc.) */}
        {Object.entries(sections).map(([section, fields]) => (
          <section key={section} className="flex flex-col gap-3 border-b border-slate-200 px-3.5 py-3.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              {section}
            </div>
            {fields.map(field => (
              <div key={field.key} className="flex flex-col gap-1.5">
                <label className="flex items-center justify-between text-[11px] font-medium text-slate-500">
                  <span>{field.label}</span>
                </label>
                <FieldRenderer
                  field={field}
                  value={configValues[field.key] ?? field.defaultValue}
                  onChange={handleConfigChange}
                />
                {field.description && (
                  <p className="text-[10px] text-slate-400">{field.description}</p>
                )}
              </div>
            ))}
          </section>
        ))}

        {/* Connections */}
        <section className="flex flex-col gap-2 border-b border-slate-200 px-3.5 py-3.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Connections ({connections.length})
          </div>
          {connections.length === 0 ? (
            <div className="text-[11px] text-slate-400">No connections.</div>
          ) : (
            <div>
              {connections.map((c, i) => (
                <div
                  key={c.id}
                  className={cn(
                    'grid items-center gap-2 py-1.5 text-[12px]',
                    i > 0 && 'border-t border-slate-200',
                  )}
                  style={{ gridTemplateColumns: '16px 1fr auto' }}
                >
                  <span className="font-mono text-slate-500">{c.direction}</span>
                  <span className="truncate font-mono text-slate-900">{c.otherId}</span>
                  <span className="font-mono text-slate-500">{c.label}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3.5 py-3.5">
        <button
          type="button"
          onClick={handleDelete}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-red-200 bg-red-50 py-1.5 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete node
        </button>
      </div>
    </div>
  )
}
