'use client'
import React from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { VpcNode } from '@/components/nodes/VpcNode'
import { SubnetNode } from '@/components/nodes/SubnetNode'
import { VirtualServerNode } from '@/components/nodes/VirtualServerNode'
import { ServiceNode } from '@/components/nodes/ServiceNode'
import { ConnectionEdge } from '@/components/edges/ConnectionEdge'
import type { SegmentCanvasSnapshot } from '@/types/episode'

const nodeTypes = {
  vpc: VpcNode,
  subnet: SubnetNode,
  virtual_server: VirtualServerNode,
  service: ServiceNode,
}
const edgeTypes = {
  connectionEdge: ConnectionEdge,
}

export function SegmentCanvasPreview({ snapshot }: { snapshot: SegmentCanvasSnapshot }) {
  return (
    <ReactFlowProvider>
      <div className="relative h-full w-full">
        <ReactFlow
          nodes={snapshot.nodes}
          edges={snapshot.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#e2e8f0" />
        </ReactFlow>
        <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-white/85 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-500 shadow-sm">
          Preview
        </div>
      </div>
    </ReactFlowProvider>
  )
}
