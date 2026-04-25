'use client'
import React, { useCallback, useMemo, useState } from 'react'
import {
  type EdgeProps,
  EdgeLabelRenderer,
  BaseEdge,
  useReactFlow,
  Position,
  getSmoothStepPath,
} from '@xyflow/react'
import { Trash2, ChevronDown } from 'lucide-react'
import type { ConnectionFlowEdge } from '@/types/flow'
import type { Connection } from '@/types/connections'
import { useUIStore } from '@/store/useUIStore'
import { useSimulationStore } from '@/store/useSimulationStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { useEffect, useRef } from 'react'

function buildSmoothOrthogonalPath({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, bendX, bendY,
}: {
  sourceX: number; sourceY: number; targetX: number; targetY: number
  sourcePosition?: Position; targetPosition?: Position; bendX?: number; bendY?: number
}) {
  const controlX = bendX ?? (sourceX + targetX) / 2
  const controlY = bendY ?? (sourceY + targetY) / 2
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    centerX: controlX, centerY: controlY,
    borderRadius: 14, offset: 18,
  })
  return { path, labelX, labelY, controlX, controlY }
}

function InlinePanel({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const { updateEdge, deleteEdge } = useScenarioStore()
  const { selectEdge } = useUIStore()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  const update = useCallback((patch: Partial<Connection>) => {
    updateEdge(connection.id, patch)
  }, [connection.id, updateEdge])

  const handleDelete = useCallback(() => {
    deleteEdge(connection.id)
    selectEdge(null)
    onClose()
  }, [connection.id, deleteEdge, onClose, selectEdge])

  return (
    <div
      ref={panelRef}
      className="nodrag nopan absolute left-1/2 top-[calc(100%+6px)] z-50 w-52 -translate-x-1/2 overflow-hidden rounded-md border border-gray-200 bg-white shadow-xl"
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="space-y-3 p-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <p className="mb-1 text-[10px] font-medium text-gray-500">Protocol</p>
            <Select value={connection.protocol} onValueChange={v => update({ protocol: v as Connection['protocol'] })}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['tcp', 'udp', 'http', 'https', 'grpc', 'icmp'].map(p => (
                  <SelectItem key={p} value={p} className="text-xs">{p.toUpperCase()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-20">
            <p className="mb-1 text-[10px] font-medium text-gray-500">Port</p>
            <Input
              type="number"
              min={1}
              max={65535}
              value={connection.port}
              onChange={e => update({ port: Number(e.target.value) })}
              className="h-7 text-xs"
            />
          </div>
        </div>

        <div>
          <p className="mb-1 text-[10px] font-medium text-gray-500">Traffic Pattern</p>
          <Select value={connection.trafficPattern ?? 'steady'} onValueChange={v => update({ trafficPattern: v as Connection['trafficPattern'] })}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[['steady', 'Steady'], ['bursty', 'Bursty'], ['diurnal', 'Diurnal'], ['incident', 'Incident']].map(([v, l]) => (
                <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-medium text-gray-500">Traffic Rate</p>
            <span className="font-mono text-[10px] text-gray-400">{connection.trafficRate ?? 10} req/s</span>
          </div>
          <Slider
            value={[connection.trafficRate ?? 10]}
            min={0} max={1000} step={1}
            onValueChange={([v]) => update({ trafficRate: v })}
          />
        </div>

        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-100 py-1.5 text-[11px] font-medium text-red-500 transition-colors hover:bg-red-50"
          onClick={handleDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete connection
        </button>
      </div>
    </div>
  )
}

export function ConnectionEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected,
}: EdgeProps<ConnectionFlowEdge>) {
  const conn = data as Connection | undefined
  const { selectEdge } = useUIStore()
  const { updateEdge } = useScenarioStore()
  const { screenToFlowPosition } = useReactFlow()
  const activity = useSimulationStore(state => state.activeConnections[id])
  const status = useSimulationStore(state => state.status)
  const speed = useSimulationStore(state => state.speed)
  const [panelOpen, setPanelOpen] = useState(false)

  const { path, labelX, labelY, controlX, controlY } = useMemo(
    () => buildSmoothOrthogonalPath({
      sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
      bendX: conn?.bendX, bendY: conn?.bendY,
    }),
    [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, conn?.bendX, conn?.bendY]
  )

  // Close panel when edge is deselected
  useEffect(() => {
    if (!selected) setPanelOpen(false)
  }, [selected])

  const handleEdgeClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    selectEdge(id)
  }, [id, selectEdge])

  const handleBadgeClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    selectEdge(id)
    setPanelOpen(prev => !prev)
  }, [id, selectEdge])

  const handleJointDrag = useCallback((e: React.MouseEvent<SVGCircleElement>) => {
    e.stopPropagation()
    const onMove = (moveEvent: MouseEvent) => {
      const point = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })
      updateEdge(id, { bendX: point.x, bendY: point.y })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [id, screenToFlowPosition, updateEdge])

  const hasWarning = conn?.topologyWarning
  const isActive = Boolean(activity && activity.requestCount > 0)
  const isRunning = status === 'running'
  const runDuration = Math.max(0.32, 1.8 / Math.max(speed, 1))
  const glowDuration = Math.max(0.45, runDuration * 1.35)
  const shouldAnimate = isActive && isRunning
  const strokeWidth = selected ? 2.75 : 2.35
  const stroke = selected ? '#2563eb' : hasWarning ? '#f59e0b' : '#64748b'
  const activeStroke = selected ? '#2563eb' : '#0f766e'
  const markerId = `connection-arrow-${id}`
  const markerWidth = Number((strokeWidth * 3.8).toFixed(2))
  const markerHeight = Number((strokeWidth * 3.1).toFixed(2))
  const markerRefX = Number((markerWidth - 1.5).toFixed(2))
  const markerRefY = Number((markerHeight / 2).toFixed(2))
  const labelText = `${conn?.protocol?.toUpperCase() || 'TCP'}:${conn?.port ?? 80}`

  return (
    <>
      <defs>
        <marker
          id={markerId}
          markerWidth={markerWidth}
          markerHeight={markerHeight}
          refX={markerRefX}
          refY={markerRefY}
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d={`M0,0 L0,${markerHeight} L${markerWidth},${markerHeight / 2} z`} fill={stroke} />
        </marker>
      </defs>

      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth,
          cursor: 'pointer',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          filter: selected ? 'drop-shadow(0 6px 10px rgba(37,99,235,0.18))' : undefined,
        }}
        markerEnd={`url(#${markerId})`}
        onClick={handleEdgeClick}
      />

      {shouldAnimate && (
        <>
          <path
            d={path} fill="none" stroke={activeStroke}
            strokeWidth={selected ? 4.5 : 3.5} strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray="4 18"
            className="connection-flow-path connection-flow-path--teal"
            style={{ pointerEvents: 'none', animationDuration: `${runDuration}s`, animationIterationCount: 'infinite' }}
          />
          <path
            d={path} fill="none" stroke="#93c5fd"
            strokeWidth={selected ? 6 : 5} strokeLinecap="round" strokeLinejoin="round"
            opacity="0.22"
            className="connection-flow-path connection-flow-path--glow"
            style={{ pointerEvents: 'none', animationDuration: `${glowDuration}s`, animationIterationCount: 'infinite' }}
          />
          <circle r="4.5" fill="#0ea5e9" opacity="0.95" style={{ pointerEvents: 'none', filter: 'drop-shadow(0 0 6px rgba(14,165,233,0.55))' }}>
            <animateMotion dur={`${runDuration}s`} repeatCount="indefinite" rotate="auto" path={path} />
          </circle>
        </>
      )}

      {selected && (
        <>
          <circle cx={sourceX} cy={sourceY} r="6" fill="#ffffff" stroke="#2563eb" strokeWidth={2} opacity="0.9" style={{ pointerEvents: 'none' }} />
          <circle cx={targetX} cy={targetY} r="6" fill="#ffffff" stroke="#2563eb" strokeWidth={2} opacity="0.9" style={{ pointerEvents: 'none' }} />
          {/* Bend handle — only shown when not at midpoint */}
          {(conn?.bendX != null || conn?.bendY != null) && (
            <>
              <circle cx={controlX} cy={controlY} r="14" fill="rgba(255,255,255,0.7)" stroke="rgba(148,163,184,0.3)" strokeWidth={1} className="cursor-move" onMouseDown={handleJointDrag} />
              <circle cx={controlX} cy={controlY} r="5" fill="#94a3b8" stroke="#ffffff" strokeWidth={1.5} className="cursor-move" onMouseDown={handleJointDrag} style={{ pointerEvents: 'none' }} />
            </>
          )}
        </>
      )}

      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            zIndex: 1100,
          }}
          className="nopan"
        >
          {/* Floating toolbar */}
          <div className={cn(
            'flex items-center rounded-md border shadow-sm transition-all',
            selected
              ? 'border-blue-300 bg-blue-50 shadow-[0_2px_8px_rgba(37,99,235,0.18)]'
              : hasWarning
              ? 'border-yellow-300 bg-yellow-50'
              : isActive
              ? 'border-cyan-300 bg-cyan-50'
              : 'border-slate-300 bg-white',
          )}>
            <button
              type="button"
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors',
                selected ? 'text-blue-700 hover:bg-blue-100' : hasWarning ? 'text-yellow-700' : isActive ? 'text-cyan-800' : 'text-slate-600 hover:bg-slate-50',
              )}
              onClick={handleBadgeClick}
            >
              {hasWarning && <span className="mr-0.5">⚠</span>}
              {labelText}
              {isActive && <span className="text-[9px] font-bold text-cyan-700 ml-0.5">{activity.requestCount} req</span>}
              {selected && <ChevronDown className={cn('h-3 w-3 ml-0.5 transition-transform text-blue-400', panelOpen && 'rotate-180')} />}
            </button>
          </div>

          {/* Inline settings panel */}
          {selected && panelOpen && conn && (
            <InlinePanel connection={conn} onClose={() => setPanelOpen(false)} />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
