'use client'
import React from 'react'
import {
  BaseEdge,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react'

export function PendingConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
    offset: 18,
  })

  const markerId = `pending-connection-arrow-${id}`

  return (
    <>
      <defs>
        <marker
          id={markerId}
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,10 L10,5 z" fill="#60a5fa" />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: '#60a5fa',
          strokeWidth: 2.4,
          strokeDasharray: '8 8',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.9,
          pointerEvents: 'none',
          filter: 'drop-shadow(0 0 10px rgba(96,165,250,0.28))',
        }}
        markerEnd={`url(#${markerId})`}
      />
    </>
  )
}
