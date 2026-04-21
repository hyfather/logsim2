'use client'
import React, { useState, useCallback } from 'react'
import { Settings } from 'lucide-react'
import type { OnResizeEnd } from '@xyflow/react'
import type { ScenarioNode } from '@/types/nodes'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { cn } from '@/lib/utils'
import { getNodeAddress, getNodeHoverDetails } from '@/lib/network'
import { NodeInspector } from '@/components/panels/NodeInspector'
import { NodeAnchors } from '@/components/nodes/NodeAnchors'
import { NodeEmojiButton } from '@/components/nodes/NodeEmojiButton'
import { TileResizeControls } from '@/components/nodes/TileResizeControls'
import { getNodeEmoji } from '@/lib/nodeAppearance'

interface BaseNodeProps {
  id: string
  data: ScenarioNode
  selected?: boolean
  children?: React.ReactNode
  borderColor: string
  borderStyle?: 'solid' | 'dashed'
  isContainer?: boolean
  minWidth?: number
  minHeight?: number
}

export function BaseNode({
  id,
  data,
  selected,
  children,
  borderColor,
  borderStyle = 'solid',
  isContainer = false,
  minWidth = 120,
  minHeight = 80,
}: BaseNodeProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(data.label)
  const { nodes, renameNode, updateNode } = useScenarioStore()
  const { selectedNodeId, selectNode, configPanelOpen, setConfigPanelOpen, setConfigPanelAnchor } = useUIStore()
  const address = getNodeAddress(data, nodes.map(node => node.data))
  const hoverText = getNodeHoverDetails(data, nodes.map(node => node.data))
  const emoji = getNodeEmoji(data)

  const handleResizeEnd = useCallback<OnResizeEnd>(
    (_event, params) => {
      updateNode(id, {
        size: { width: params.width, height: params.height },
      })
    },
    [id, updateNode]
  )

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setIsEditing(true)
    setEditLabel(data.label)
  }, [data.label])

  const handleLabelKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      renameNode(id, editLabel)
      setIsEditing(false)
    } else if (e.key === 'Escape') {
      setIsEditing(false)
      setEditLabel(data.label)
    }
  }, [id, editLabel, renameNode, data.label])

  const handleLabelBlur = useCallback(() => {
    renameNode(id, editLabel)
    setIsEditing(false)
  }, [id, editLabel, renameNode])

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    selectNode(id)
  }, [id, selectNode])

  const handleSettingsClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (selectedNodeId === id && configPanelOpen) {
      setConfigPanelOpen(false)
      setConfigPanelAnchor(null)
      return
    }

    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
    selectNode(id)
    setConfigPanelAnchor({ x: rect.right + 10, y: rect.top })
    setConfigPanelOpen(true)
  }, [configPanelOpen, id, selectNode, selectedNodeId, setConfigPanelAnchor, setConfigPanelOpen])

  const borderStyleStr = borderStyle === 'dashed' ? '2px dashed' : '2px solid'

  return (
    <div
      className={cn(
        'group/node relative overflow-visible rounded-[22px] transition-shadow',
        selected ? 'shadow-[0_24px_50px_-24px_rgba(37,99,235,0.35)]' : 'shadow-[0_20px_45px_-32px_rgba(15,23,42,0.45)]',
        isContainer ? 'bg-white/[0.42] backdrop-blur-[1px]' : 'bg-[linear-gradient(135deg,rgba(255,255,255,0.98),rgba(248,250,252,0.96))]',
      )}
      style={{
        border: `${borderStyleStr} ${selected ? '#3b82f6' : borderColor}`,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
      title={hoverText}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <TileResizeControls
        selected={selected}
        minWidth={minWidth}
        minHeight={minHeight}
        onResizeEnd={handleResizeEnd}
      />
      <button
        type="button"
        className="nodrag nopan absolute right-2.5 top-2.5 z-10 rounded-full border border-white/80 bg-white/[0.92] p-1.5 text-slate-500 shadow-[0_10px_24px_-16px_rgba(15,23,42,0.65)] backdrop-blur transition-all hover:border-slate-200 hover:text-slate-700"
        onClick={handleSettingsClick}
        title="Edit node settings"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      <div
        className="absolute left-3 top-2.5 right-12 z-10 flex items-center gap-1"
        onDoubleClick={handleDoubleClick}
      >
        {isEditing ? (
          <input
            autoFocus
            className="w-40 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm font-semibold text-slate-800 shadow-sm"
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            onKeyDown={handleLabelKeyDown}
            onBlur={handleLabelBlur}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="max-w-full truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
            {data.label}
          </span>
        )}
      </div>

      <NodeEmojiButton
        nodeId={id}
        emoji={emoji}
        className="absolute left-3 top-[34px] z-10 flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200/80 bg-white text-center text-[22px] leading-none shadow-[0_14px_28px_-22px_rgba(15,23,42,0.72)]"
      />

      <div className="absolute bottom-2.5 left-3 right-3 z-10">
        <span className="block max-w-[220px] truncate font-mono text-[11px] text-slate-600">
          {address}
        </span>
        <span className="block max-w-[220px] truncate font-mono text-[10px] text-slate-400">
          {data.channel}
        </span>
      </div>

      {children}

      {selectedNodeId === id && configPanelOpen && <NodeInspector nodeData={data} />}

      <NodeAnchors nodeId={id} selected={selected} accentColor={selected ? '#3b82f6' : borderColor} />
    </div>
  )
}
