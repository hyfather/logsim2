'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, X } from 'lucide-react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { getRegistryEntry } from '@/registry/nodeRegistry'
import type { ConfigField, ScenarioNode } from '@/types/nodes'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getNodeAddress } from '@/lib/network'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'

function groupBySection(fields: ConfigField[]): Record<string, ConfigField[]> {
  const groups: Record<string, ConfigField[]> = {}
  for (const field of fields) {
    const section = field.section || 'General'
    if (!groups[section]) groups[section] = []
    groups[section].push(field)
  }
  return groups
}

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: ConfigField
  value: unknown
  onChange: (key: string, value: unknown) => void
}) {
  const handleChange = useCallback((val: unknown) => {
    onChange(field.key, val)
  }, [field.key, onChange])

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
          className="h-7 text-xs"
        />
      )

    case 'boolean':
      return <Switch checked={Boolean(value)} onCheckedChange={handleChange} />

    case 'select':
      return (
        <Select value={String(value ?? '')} onValueChange={handleChange}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map(opt => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                {opt.label}
              </SelectItem>
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
          <span className="w-12 text-right font-mono text-xs text-gray-500">
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
      return (
        <Input
          value={String(value ?? '')}
          onChange={e => handleChange(e.target.value)}
          className="h-7 text-xs"
        />
      )
  }
}

export function NodeInspector({ nodeData }: { nodeData: ScenarioNode }) {
  const { nodes, updateNode, deleteNode, renameNode } = useScenarioStore()
  const { selectNode, setConfigPanelOpen, configPanelAnchor, setConfigPanelAnchor } = useUIStore()
  const [labelDraft, setLabelDraft] = useState(nodeData.label)
  const [mounted, setMounted] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const allNodes = nodes.map(node => node.data)
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  const left = Math.max(12, Math.min((configPanelAnchor?.x ?? 120), viewportWidth - 304))
  const top = Math.max(12, Math.min((configPanelAnchor?.y ?? 120), viewportHeight - 132))
  const panelMaxHeight = Math.max(280, viewportHeight - top - 12)

  const configSchema = useMemo(() => {
    const entry = getRegistryEntry(nodeData.type, nodeData.serviceType)
    return entry?.configSchema || []
  }, [nodeData.type, nodeData.serviceType])

  const configValues = useMemo(() => {
    return (nodeData.config as Record<string, unknown>) || {}
  }, [nodeData.config])

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    setLabelDraft(nodeData.label)
  }, [nodeData.label, nodeData.id])

  useEffect(() => {
    if (!mounted) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (panelRef.current?.contains(target)) return

      // Radix Select/Popover portals render outside the panel — don't close for those
      if (target?.closest('[data-radix-popper-content-wrapper], [role="listbox"], [role="option"]')) return

      setConfigPanelOpen(false)
      setConfigPanelAnchor(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [mounted, setConfigPanelAnchor, setConfigPanelOpen])

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
    setConfigPanelOpen(false)
    setConfigPanelAnchor(null)
  }, [deleteNode, nodeData.id, selectNode, setConfigPanelAnchor, setConfigPanelOpen])

  const sections = groupBySection(configSchema)

  if (!mounted || typeof document === 'undefined') return null

  const desktopStyle = { left, top, maxHeight: panelMaxHeight }
  const mobileStyle = { maxHeight: '85dvh' }

  return createPortal(
    <div
      ref={panelRef}
      className={cn(
        'nodrag nopan fixed z-[1000] flex flex-col overflow-hidden border border-gray-200 bg-white shadow-2xl',
        isMobile
          ? 'inset-x-0 bottom-0 rounded-t-xl'
          : 'w-72 rounded-xl',
      )}
      style={isMobile ? mobileStyle : desktopStyle}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <div className="flex items-start justify-between border-b border-gray-200 px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold text-gray-800">{nodeData.label}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{nodeData.channel}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-gray-600">
            {getNodeAddress(nodeData, allNodes)}
          </div>
        </div>
        <div className="ml-2 flex items-center gap-1">
          <Badge variant="outline" className="px-1 text-[9px]">
            {nodeData.type.replace('_', ' ')}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
            onClick={handleDelete}
            title="Delete node"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-gray-400 hover:text-gray-700"
            onClick={(e) => {
              e.stopPropagation()
              setConfigPanelOpen(false)
              setConfigPanelAnchor(null)
            }}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <div>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">Identity</div>
          <div className="space-y-2">
            <div>
              <Label className="mb-1 block text-xs text-gray-600">Display name</Label>
              <Input
                value={labelDraft}
                onChange={e => setLabelDraft(e.target.value)}
                onBlur={commitLabel}
                onKeyDown={e => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="h-7 text-xs"
              />
            </div>

            {(nodeData.type === 'vpc' || nodeData.type === 'subnet') && (
              <div>
                <Label className="mb-1 block text-xs text-gray-600">CIDR</Label>
                <Input
                  value={String((nodeData.config as { cidr?: string }).cidr ?? '')}
                  onChange={e => handleAddressChange(e.target.value)}
                  placeholder={nodeData.type === 'vpc' ? 'e.g. 10.0.0.0/16' : 'e.g. 10.0.1.0/24'}
                  className="h-7 font-mono text-xs"
                />
              </div>
            )}

            {(nodeData.type === 'virtual_server' || nodeData.type === 'service') && (
              <div>
                <Label className="mb-1 block text-xs text-gray-600">Private IP</Label>
                <Input
                  value={nodeData.type === 'service'
                    ? (nodeData.privateIp?.trim() || getNodeAddress(nodeData, allNodes))
                    : String((nodeData.config as { privateIp?: string }).privateIp ?? '')}
                  onChange={e => handleAddressChange(e.target.value)}
                  placeholder="e.g. 10.0.1.25"
                  className="h-7 font-mono text-xs"
                />
                <p className="mt-0.5 text-[9px] text-gray-400">
                  Resolved address: {getNodeAddress(nodeData, allNodes)}
                </p>
              </div>
            )}
          </div>
        </div>

        {Object.entries(sections).map(([section, fields]) => (
          <div key={section}>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">{section}</div>
            <div className="space-y-2">
              {fields.map(field => (
                <div key={field.key}>
                  <Label className="mb-1 block text-xs text-gray-600">{field.label}</Label>
                  <FieldRenderer
                    field={field}
                    value={configValues[field.key] ?? field.defaultValue}
                    onChange={handleConfigChange}
                  />
                  {field.description && (
                    <p className="mt-0.5 text-[9px] text-gray-400">{field.description}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}
