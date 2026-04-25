'use client'
import React, { useState, useCallback, useEffect } from 'react'
import { Settings } from 'lucide-react'
import type { OnResizeEnd } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { ScenarioNode } from '@/types/nodes'
import type { ScenarioFlowNode } from '@/types/flow'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { cn } from '@/lib/utils'
import { getNodeAddress, getNodeHoverDetails } from '@/lib/network'
import { NodeInspector } from '@/components/panels/NodeInspector'
import { NodeAnchors } from '@/components/nodes/NodeAnchors'
import { NodeEmojiButton } from '@/components/nodes/NodeEmojiButton'
import { TileResizeControls } from '@/components/nodes/TileResizeControls'
import { getNodeEmoji } from '@/lib/nodeAppearance'

export function ServiceNode({ id, data, selected }: NodeProps<ScenarioFlowNode>) {
  const node = data as ScenarioNode
  const [isEditing, setIsEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(node.label)
  const { nodes, renameNode, updateNode } = useScenarioStore()
  const { selectedNodeId, selectNode, configPanelOpen, setConfigPanelOpen, setConfigPanelAnchor } = useUIStore()

  const emoji = getNodeEmoji(node)
  const allNodes = nodes.map(candidate => candidate.data)
  const address = getNodeAddress(node, allNodes)
  const hoverText = getNodeHoverDetails(node, allNodes)

  useEffect(() => {
    setEditLabel(node.label)
  }, [node.label])

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
    setEditLabel(node.label)
  }, [node.label])

  const handleLabelKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      renameNode(id, editLabel)
      setIsEditing(false)
    } else if (e.key === 'Escape') {
      setIsEditing(false)
      setEditLabel(node.label)
    }
  }, [id, editLabel, renameNode, node.label])

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

  return (
    <div
      className={cn(
        'group/node relative flex min-h-[64px] min-w-[220px] cursor-pointer flex-col overflow-visible rounded-md bg-white transition-all',
        selected
          ? 'shadow-[0_18px_40px_-24px_rgba(37,99,235,0.3)]'
          : 'shadow-[0_14px_32px_-28px_rgba(15,23,42,0.3)] hover:shadow-[0_18px_38px_-26px_rgba(15,23,42,0.4)]',
      )}
      style={{
        border: `1.5px solid ${selected ? '#3b82f6' : '#86efac'}`,
      }}
      title={hoverText}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <TileResizeControls
        selected={selected}
        minWidth={220}
        minHeight={64}
        onResizeEnd={handleResizeEnd}
      />

      {/* Title bar */}
      <div className="flex h-8 items-center gap-2 rounded-t-[4px] border-b border-slate-200/70 bg-white px-2">
        <NodeEmojiButton
          nodeId={id}
          emoji={emoji}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-center text-[15px] leading-none hover:bg-slate-100"
        />
        {isEditing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 text-[13px] font-semibold text-slate-900 shadow-sm"
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            onKeyDown={handleLabelKeyDown}
            onBlur={handleLabelBlur}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.015em] text-slate-950">
            {node.label}
          </span>
        )}
        {node.serviceType && (
          <span className="shrink-0 rounded-sm bg-slate-900/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            {node.serviceType}
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

      {/* Body */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2.5 py-1.5">
        <div className="truncate font-mono text-[11px] text-slate-700">{address}</div>
        <div className="truncate font-mono text-[10px] text-slate-400">{node.channel}</div>
      </div>

      {selectedNodeId === id && configPanelOpen && <NodeInspector nodeData={node} />}

      <NodeAnchors nodeId={id} selected={selected} accentColor={selected ? '#3b82f6' : '#22c55e'} />
    </div>
  )
}
