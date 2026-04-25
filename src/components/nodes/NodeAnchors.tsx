'use client'
import React, { useCallback } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { AnchorHandleId } from '@/types/connections'
import { cn } from '@/lib/utils'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'

const ANCHORS: Array<{ id: AnchorHandleId; position: Position; handleOffsetClass: string; buttonClass: string }> = [
  { id: 'top', position: Position.Top, handleOffsetClass: '!-top-1.5', buttonClass: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2' },
  { id: 'right', position: Position.Right, handleOffsetClass: '!-right-1.5', buttonClass: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2' },
  { id: 'bottom', position: Position.Bottom, handleOffsetClass: '!-bottom-1.5', buttonClass: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2' },
  { id: 'left', position: Position.Left, handleOffsetClass: '!-left-1.5', buttonClass: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2' },
]

export function NodeAnchors({
  nodeId,
  selected,
  accentColor,
}: {
  nodeId: string
  selected?: boolean
  accentColor: string
}) {
  const { onConnect } = useScenarioStore()
  const {
    pendingConnection,
    hoveredConnectionTarget,
    setPendingConnection,
    setHoveredConnectionTarget,
    clearPendingConnection,
  } = useUIStore()

  const handleAnchorClick = useCallback((handleId: AnchorHandleId) => {
    if (!pendingConnection) {
      setPendingConnection({ nodeId, handleId })
      return
    }

    if (pendingConnection.nodeId === nodeId) {
      if (pendingConnection.handleId === handleId) {
        clearPendingConnection()
      } else {
        setPendingConnection({ nodeId, handleId })
      }
      return
    }

    onConnect({
      source: pendingConnection.nodeId,
      sourceHandle: pendingConnection.handleId,
      target: nodeId,
      targetHandle: handleId,
    })
    clearPendingConnection()
  }, [clearPendingConnection, nodeId, onConnect, pendingConnection, setPendingConnection])

  return (
    <>
      {ANCHORS.map(anchor => {
        const isSource = pendingConnection?.nodeId === nodeId && pendingConnection.handleId === anchor.id
        const isWaitingForTarget = Boolean(pendingConnection) && !isSource
        const isHoverTarget = hoveredConnectionTarget?.nodeId === nodeId && hoveredConnectionTarget.handleId === anchor.id

        return (
          <React.Fragment key={anchor.id}>
            <Handle
              id={anchor.id}
              type="source"
              position={anchor.position}
              isConnectableStart
              isConnectableEnd
              className={cn(
                '!pointer-events-none !h-3 !w-3 !rounded-full !border-[2.5px] !border-transparent !bg-transparent !opacity-0',
                anchor.handleOffsetClass,
              )}
            />
            <button
              type="button"
              className={cn(
                'nodrag nopan absolute z-20 flex h-7 w-7 items-center justify-center rounded-full border bg-white text-base font-semibold leading-none shadow-[0_10px_24px_-18px_rgba(15,23,42,0.75)] transition-all sm:h-5.5 sm:w-5.5 sm:text-[13px]',
                anchor.buttonClass,
                selected || pendingConnection
                  ? 'opacity-100 scale-100'
                  : 'opacity-0 scale-90 group-hover/node:opacity-100 group-hover/node:scale-100',
                isSource
                  ? 'border-blue-400 bg-blue-50 text-blue-600'
                  : isHoverTarget
                  ? 'scale-110 border-sky-400 bg-sky-50 text-sky-700'
                  : isWaitingForTarget
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                  : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700',
              )}
              style={{
                boxShadow: isSource ? `0 0 0 2px ${accentColor}33` : undefined,
              }}
              title={
                isSource
                  ? 'Cancel connection'
                  : pendingConnection
                  ? 'Connect here'
                  : 'Create connection'
              }
              onClick={e => {
                e.stopPropagation()
                handleAnchorClick(anchor.id)
              }}
              onTouchEnd={e => {
                e.preventDefault()
                e.stopPropagation()
                handleAnchorClick(anchor.id)
              }}
              onMouseEnter={() => {
                if (!pendingConnection || pendingConnection.nodeId === nodeId) return
                setHoveredConnectionTarget({ nodeId, handleId: anchor.id })
              }}
              onMouseLeave={() => {
                if (hoveredConnectionTarget?.nodeId === nodeId && hoveredConnectionTarget.handleId === anchor.id) {
                  setHoveredConnectionTarget(null)
                }
              }}
              onMouseDown={e => {
                e.stopPropagation()
              }}
              onPointerDown={e => {
                e.stopPropagation()
              }}
            >
              +
            </button>
          </React.Fragment>
        )
      })}
    </>
  )
}
