'use client'
import React from 'react'
import type { NodeProps } from '@xyflow/react'
import type { ScenarioFlowNode } from '@/types/flow'
import { BaseNode } from './BaseNode'

export function VpcNode({ id, data, selected }: NodeProps<ScenarioFlowNode>) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      borderColor="#000000"
      borderStyle="solid"
      isContainer
      minWidth={320}
      minHeight={220}
    />
  )
}
