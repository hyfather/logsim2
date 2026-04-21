'use client'
import React from 'react'
import { NodeResizer } from '@xyflow/react'
import type { OnResizeEnd } from '@xyflow/react'

export function TileResizeControls({
  selected,
  minWidth,
  minHeight,
  onResizeEnd,
}: {
  selected?: boolean
  minWidth: number
  minHeight: number
  onResizeEnd: OnResizeEnd
}) {
  return (
    <NodeResizer
      minWidth={minWidth}
      minHeight={minHeight}
      isVisible={selected}
      lineClassName="!border-transparent"
      lineStyle={{ opacity: 0 }}
      handleClassName="!h-3 !w-3 !rounded-full !border-2 !border-blue-500 !bg-white !shadow-[0_8px_18px_-12px_rgba(37,99,235,0.8)]"
      onResizeEnd={onResizeEnd}
    />
  )
}
