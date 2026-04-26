'use client'
import React, { useState, useCallback } from 'react'
import { Settings } from 'lucide-react'
import type { OnResizeEnd } from '@xyflow/react'
import type { ScenarioNode } from '@/types/nodes'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { cn } from '@/lib/utils'
import { getNodeAddress, getNodeHoverDetails } from '@/lib/network'
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
  const { selectNode, setLogPanelOpen } = useUIStore()
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
    setLogPanelOpen(true)
  }, [id, selectNode, setLogPanelOpen])

  const handleSettingsClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    selectNode(id)
    setLogPanelOpen(true)
  }, [id, selectNode, setLogPanelOpen])

  const borderStyleStr = borderStyle === 'dashed' ? '1.5px dashed' : '1.5px solid'

  return (
    <div
      className={cn(
        'group/node relative overflow-visible rounded-md transition-shadow',
        selected ? 'shadow-[0_18px_40px_-24px_rgba(37,99,235,0.3)]' : 'shadow-[0_14px_32px_-28px_rgba(15,23,42,0.35)]',
        isContainer ? 'bg-white/[0.55]' : 'bg-white',
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

      <div
        className={cn(
          'absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-2 rounded-t-[4px] border-b border-slate-200/70 bg-white/95 px-2',
          isContainer ? 'backdrop-blur-sm' : '',
        )}
        onDoubleClick={handleDoubleClick}
      >
        <NodeEmojiButton
          nodeId={id}
          emoji={emoji}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-center text-[15px] leading-none hover:bg-slate-100"
        />
        {isEditing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 text-[13px] font-semibold text-slate-800 shadow-sm"
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            onKeyDown={handleLabelKeyDown}
            onBlur={handleLabelBlur}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
            {data.label}
          </span>
        )}
        {address && (
          <span className="shrink-0 truncate rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
            {address}
          </span>
        )}
        <button
          type="button"
          className="nodrag nopan flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          onClick={handleSettingsClick}
          title="Edit node settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>

      {children}

      <NodeAnchors nodeId={id} selected={selected} accentColor={selected ? '#3b82f6' : borderColor} />
    </div>
  )
}
