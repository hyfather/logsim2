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
        'group/node relative flex min-h-[96px] min-w-[220px] cursor-pointer overflow-visible rounded-[22px] border-2 bg-[linear-gradient(135deg,rgba(255,255,255,0.99),rgba(240,253,244,0.92))] px-3.5 py-3 transition-all',
        selected
          ? 'shadow-[0_30px_60px_-28px_rgba(37,99,235,0.35)]'
          : 'shadow-[0_24px_52px_-36px_rgba(15,23,42,0.5)] hover:shadow-[0_30px_60px_-34px_rgba(15,23,42,0.55)]',
      )}
      style={{ borderColor: selected ? '#3b82f6' : '#16a34a' }}
      title={hoverText}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <TileResizeControls
        selected={selected}
        minWidth={220}
        minHeight={96}
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
      <div className="flex w-full items-center gap-3 pr-8">
        <NodeEmojiButton
          nodeId={id}
          emoji={emoji}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200/80 bg-white text-center text-2xl leading-none shadow-[0_14px_28px_-22px_rgba(15,23,42,0.72)]"
        />
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <input
              autoFocus
              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-base font-semibold text-slate-900 shadow-sm"
              value={editLabel}
              onChange={e => setEditLabel(e.target.value)}
              onKeyDown={handleLabelKeyDown}
              onBlur={handleLabelBlur}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <div className="flex items-center gap-2">
              <div className="truncate text-[16px] font-semibold leading-tight tracking-[-0.015em] text-slate-950">
                {node.label}
              </div>
              {node.serviceType && (
                <div className="shrink-0 rounded-full bg-slate-900/[0.06] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  {node.serviceType}
                </div>
              )}
            </div>
          )}
          <div className="mt-0.5 truncate font-mono text-[12px] text-slate-600">{address}</div>
          <div className="mt-1 truncate font-mono text-[10.5px] text-slate-400">{node.channel}</div>
        </div>
      </div>

      {selectedNodeId === id && configPanelOpen && <NodeInspector nodeData={node} />}

      <NodeAnchors nodeId={id} selected={selected} accentColor={selected ? '#3b82f6' : '#16a34a'} />
    </div>
  )
}
