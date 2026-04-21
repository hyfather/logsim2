'use client'
import React from 'react'
import type { NodeProps } from '@xyflow/react'
import type { ScenarioFlowNode } from '@/types/flow'
import { BaseNode } from './BaseNode'

export function VirtualServerNode({ id, data, selected }: NodeProps<ScenarioFlowNode>) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      borderColor="#dc2626"
      borderStyle="solid"
      isContainer
      minWidth={160}
      minHeight={120}
    />
  )
}
