'use client'
import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { getRegistryEntry, connectionConfigSchema } from '@/registry/nodeRegistry'
import type { ConfigField } from '@/types/nodes'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getNodeAddress } from '@/lib/network'

function groupBySection(fields: ConfigField[]): Record<string, ConfigField[]> {
  const groups: Record<string, ConfigField[]> = {}
  for (const field of fields) {
    const section = field.section || 'General'
    if (!groups[section]) groups[section] = []
    groups[section].push(field)
  }
  return groups
}

interface FieldRendererProps {
  field: ConfigField
  value: unknown
  onChange: (key: string, value: unknown) => void
}

function FieldRenderer({ field, value, onChange }: FieldRendererProps) {
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
      return (
        <Switch
          checked={Boolean(value)}
          onCheckedChange={handleChange}
        />
      )

    case 'select':
      return (
        <Select
          value={String(value ?? '')}
          onValueChange={handleChange}
        >
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
          <span className="text-xs w-12 text-right text-gray-500 font-mono">
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
          className="font-mono text-xs h-20 resize-none"
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

export function ConfigPanel() {
  const { nodes, edges, updateNode, updateEdge, deleteNode, deleteEdge, renameNode } = useScenarioStore()
  const { selectedNodeId, selectedEdgeId, setConfigPanelOpen } = useUIStore()
  const [labelDraft, setLabelDraft] = useState('')

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)

  const nodeData = selectedNode?.data
  const edgeData = selectedEdge?.data

  const configSchema = useMemo(() => {
    if (nodeData) {
      const entry = getRegistryEntry(nodeData.type, nodeData.serviceType)
      return entry?.configSchema || []
    }
    if (edgeData) {
      return connectionConfigSchema
    }
    return []
  }, [nodeData, edgeData])

  const configValues = useMemo(() => {
    if (nodeData) return (nodeData.config as Record<string, unknown>) || {}
    if (edgeData) return edgeData as unknown as Record<string, unknown>
    return {}
  }, [nodeData, edgeData])

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    if (selectedNodeId && nodeData) {
      const newConfig = { ...(nodeData.config as Record<string, unknown>), [key]: value }
      updateNode(selectedNodeId, { config: newConfig })
    } else if (selectedEdgeId && edgeData) {
      updateEdge(selectedEdgeId, { [key]: value } as Record<string, unknown>)
    }
  }, [selectedNodeId, selectedEdgeId, nodeData, edgeData, updateNode, updateEdge])

  const handleDelete = useCallback(() => {
    if (selectedNodeId) {
      deleteNode(selectedNodeId)
      setConfigPanelOpen(false)
    } else if (selectedEdgeId) {
      deleteEdge(selectedEdgeId)
      setConfigPanelOpen(false)
    }
  }, [selectedNodeId, selectedEdgeId, deleteNode, deleteEdge, setConfigPanelOpen])

  useEffect(() => {
    if (nodeData) setLabelDraft(nodeData.label)
  }, [nodeData, selectedNodeId])

  const commitLabel = useCallback(() => {
    if (!selectedNodeId || !nodeData) return
    const next = labelDraft.trim() || nodeData.label
    if (next !== nodeData.label) renameNode(selectedNodeId, next)
  }, [selectedNodeId, nodeData, labelDraft, renameNode])

  const handlePrivateIpChange = useCallback(
    (value: string) => {
      if (!selectedNodeId || !nodeData) return
      if (nodeData.type === 'service') {
        updateNode(selectedNodeId, { privateIp: value })
      } else if (nodeData.type === 'virtual_server') {
        const cfg = { ...(nodeData.config as Record<string, unknown>), privateIp: value }
        updateNode(selectedNodeId, { config: cfg })
      }
    },
    [selectedNodeId, nodeData, updateNode]
  )

  const handleAddressChange = useCallback(
    (value: string) => {
      if (!selectedNodeId || !nodeData) return
      if (nodeData.type === 'service') {
        updateNode(selectedNodeId, { privateIp: value })
        return
      }
      if (nodeData.type === 'virtual_server') {
        const cfg = { ...(nodeData.config as Record<string, unknown>), privateIp: value }
        updateNode(selectedNodeId, { config: cfg })
        return
      }
      if (nodeData.type === 'vpc' || nodeData.type === 'subnet') {
        const cfg = { ...(nodeData.config as Record<string, unknown>), cidr: value }
        updateNode(selectedNodeId, { config: cfg })
      }
    },
    [selectedNodeId, nodeData, updateNode]
  )

  if (!nodeData && !edgeData) return null

  const sections = groupBySection(configSchema)

  return (
    <div className="w-64 flex-shrink-0 border-l border-gray-200 bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          {nodeData && (
            <>
              <div className="text-xs font-bold text-gray-800 truncate">{nodeData.label}</div>
              <div className="text-[10px] text-gray-400 font-mono truncate mt-0.5">{nodeData.channel}</div>
              <div className="text-[10px] text-gray-500 font-mono truncate mt-0.5">{getNodeAddress(nodeData, nodes.map(n => n.data))}</div>
            </>
          )}
          {edgeData && (
            <div className="text-xs font-bold text-gray-800">Connection</div>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2">
          {nodeData && (
            <Badge variant="outline" className="text-[9px] px-1">
              {nodeData.type.replace('_', ' ')}
            </Badge>
          )}
          {(nodeData || edgeData) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
              title={nodeData ? 'Delete node' : 'Delete connection'}
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 text-gray-400 hover:text-gray-600"
            onClick={() => setConfigPanelOpen(false)}
          >
            ✕
          </Button>
        </div>
      </div>

      {/* Config form */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {nodeData && (
          <div>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
              Identity
            </div>
            <div className="space-y-2">
              <div>
                <Label className="text-xs text-gray-600 mb-1 block">Display name</Label>
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
                  <Label className="text-xs text-gray-600 mb-1 block">CIDR</Label>
                  <Input
                    value={String((nodeData.config as { cidr?: string }).cidr ?? '')}
                    onChange={e => handleAddressChange(e.target.value)}
                    placeholder={nodeData.type === 'vpc' ? 'e.g. 10.0.0.0/16' : 'e.g. 10.0.1.0/24'}
                    className="h-7 text-xs font-mono"
                  />
                </div>
              )}
              {(nodeData.type === 'virtual_server' || nodeData.type === 'service') && (
                <div>
                  <Label className="text-xs text-gray-600 mb-1 block">Private IP</Label>
                  <Input
                    value={nodeData.type === 'service'
                      ? (nodeData.privateIp ?? '')
                      : String((nodeData.config as { privateIp?: string }).privateIp ?? '')}
                    onChange={e => handleAddressChange(e.target.value)}
                    placeholder={nodeData.type === 'service' ? 'inherits from host if blank' : 'auto from subnet or VPC CIDR'}
                    className="h-7 text-xs font-mono"
                  />
                  <p className="text-[9px] text-gray-400 mt-0.5">
                    Resolved address: {getNodeAddress(nodeData, nodes.map(n => n.data))}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {Object.entries(sections).map(([section, fields]) => (
          <div key={section}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
              {section}
            </div>
            <div className="space-y-2">
              {fields.map(field => (
                <div key={field.key}>
                  <Label className="text-xs text-gray-600 mb-1 block">
                    {field.label}
                  </Label>
                  <FieldRenderer
                    field={field}
                    value={configValues[field.key] ?? field.defaultValue}
                    onChange={handleConfigChange}
                  />
                  {field.description && (
                    <p className="text-[9px] text-gray-400 mt-0.5">{field.description}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {edgeData?.topologyWarning && (
          <div className="p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-700">
            ⚠ Cross-VPC connection — topology warning
          </div>
        )}
      </div>
    </div>
  )
}
