'use client'
import React from 'react'
import type { NodeProps } from '@xyflow/react'
import type { ScenarioFlowNode } from '@/types/flow'
import { BaseNode } from './BaseNode'

export function SubnetNode({ id, data, selected }: NodeProps<ScenarioFlowNode>) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      borderColor="#cbd5e1"
      borderStyle="solid"
      isContainer
      minWidth={200}
      minHeight={140}
    />
  )
}
