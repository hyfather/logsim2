'use client'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, X } from 'lucide-react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { connectionConfigSchema } from '@/registry/nodeRegistry'
import type { ConfigField } from '@/types/nodes'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { Connection } from '@/types/connections'
import { useIsMobile } from '@/hooks/useMediaQuery'
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
  const handleChange = useCallback((val: unknown) => {
    onChange(field.key, val)
  }, [field.key, onChange])

  switch (field.type) {
    case 'string':
      return <Input value={String(value ?? '')} onChange={e => handleChange(e.target.value)} className="h-7 text-xs" />
    case 'number':
      return <Input type="number" value={String(value ?? field.defaultValue ?? 0)} min={field.min} max={field.max} step={field.step} onChange={e => handleChange(Number(e.target.value))} className="h-7 text-xs" />
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
      return <Textarea value={String(value ?? '')} onChange={e => handleChange(e.target.value)} className="h-20 resize-none font-mono text-xs" />
    default:
      return <Input value={String(value ?? '')} onChange={e => handleChange(e.target.value)} className="h-7 text-xs" />
  }
}

export function ConnectionInspector({ connection }: { connection: Connection }) {
  const { nodes, updateEdge, deleteEdge } = useScenarioStore()
  const { setConfigPanelOpen, selectEdge, configPanelAnchor, setConfigPanelAnchor } = useUIStore()
  const [mounted, setMounted] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  const sourceLabel = useMemo(
    () => nodes.find(node => node.id === connection.sourceId)?.data.label || connection.sourceId,
    [nodes, connection.sourceId]
  )
  const targetLabel = useMemo(
    () => nodes.find(node => node.id === connection.targetId)?.data.label || connection.targetId,
    [nodes, connection.targetId]
  )

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    updateEdge(connection.id, { [key]: value } as Partial<Connection>)
  }, [connection.id, updateEdge])

  const handleDelete = useCallback(() => {
    deleteEdge(connection.id)
    setConfigPanelOpen(false)
    setConfigPanelAnchor(null)
    selectEdge(null)
  }, [connection.id, deleteEdge, selectEdge, setConfigPanelAnchor, setConfigPanelOpen])

  useEffect(() => {
    setMounted(true)
  }, [])

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  const left = Math.max(12, Math.min((configPanelAnchor?.x ?? 120), viewportWidth - 304))
  const top = Math.max(12, Math.min((configPanelAnchor?.y ?? 120), viewportHeight - 132))
  const panelMaxHeight = Math.max(240, viewportHeight - top - 12)

  useEffect(() => {
    if (!mounted) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (panelRef.current?.contains(target)) return

      setConfigPanelOpen(false)
      setConfigPanelAnchor(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [mounted, setConfigPanelAnchor, setConfigPanelOpen])

  if (!mounted || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      className={cn(
        'nodrag nopan fixed z-[1100] flex flex-col overflow-hidden border border-gray-200 bg-white shadow-2xl',
        isMobile
          ? 'inset-x-0 bottom-0 rounded-t-xl'
          : 'w-72 rounded-xl',
      )}
      style={isMobile ? { maxHeight: '85dvh' } : { left, top, maxHeight: panelMaxHeight }}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <div className="flex items-start justify-between border-b border-gray-200 px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold text-gray-800">{sourceLabel} {'->'} {targetLabel}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-gray-500">
            {connection.protocol.toUpperCase()}:{connection.port}
          </div>
        </div>
        <div className="ml-2 flex items-center gap-1">
          <Badge variant="outline" className="px-1 text-[9px]">connection</Badge>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600" onClick={handleDelete} title="Delete connection">
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

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {connectionConfigSchema.map(field => (
          <div key={field.key}>
            <Label className="mb-1 block text-xs text-gray-600">{field.label}</Label>
            <FieldRenderer
              field={field}
              value={(connection as unknown as Record<string, unknown>)[field.key] ?? field.defaultValue}
              onChange={handleConfigChange}
            />
            {field.description && <p className="mt-0.5 text-[9px] text-gray-400">{field.description}</p>}
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}
