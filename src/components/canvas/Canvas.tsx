'use client'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  useReactFlow,
  Panel,
  ConnectionLineType,
  ConnectionMode,
  type OnReconnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Sparkles } from 'lucide-react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useUIStore } from '@/store/useUIStore'
import { VpcNode } from '@/components/nodes/VpcNode'
import { SubnetNode } from '@/components/nodes/SubnetNode'
import { VirtualServerNode } from '@/components/nodes/VirtualServerNode'
import { ServiceNode } from '@/components/nodes/ServiceNode'
import { ConnectionEdge } from '@/components/edges/ConnectionEdge'
import { PendingConnectionEdge } from '@/components/edges/PendingConnectionEdge'
import { DescribeScenarioPanel } from '@/components/canvas/DescribeScenarioPanel'
import type { Connection } from '@/types/connections'
import type { NodeType, ServiceType } from '@/types/nodes'
import { getDefaultConfig, getDefaultLabel } from '@/registry/nodeRegistry'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'

const nodeTypes = {
  vpc: VpcNode,
  subnet: SubnetNode,
  virtual_server: VirtualServerNode,
  service: ServiceNode,
}

const edgeTypes = {
  connectionEdge: ConnectionEdge,
  pendingConnectionEdge: PendingConnectionEdge,
}

export function Canvas() {
  const {
    nodes, edges,
    onNodesChange, onEdgesChange, onConnect,
    addNode, updateEdge,
  } = useScenarioStore()
  const { selectNode, selectEdge, pendingConnection, hoveredConnectionTarget, clearPendingConnection } = useUIStore()
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()
  const [describeOpen, setDescribeOpen] = useState(false)

  const renderedEdges = useMemo(() => {
    if (
      !pendingConnection ||
      !hoveredConnectionTarget ||
      pendingConnection.nodeId === hoveredConnectionTarget.nodeId
    ) {
      return edges
    }

    return [
      ...edges,
      {
        id: '__pending-connection__',
        source: pendingConnection.nodeId,
        sourceHandle: pendingConnection.handleId,
        target: hoveredConnectionTarget.nodeId,
        targetHandle: hoveredConnectionTarget.handleId,
        type: 'pendingConnectionEdge' as const,
        selectable: false,
        reconnectable: false,
        focusable: false,
        deletable: false,
        zIndex: 1200,
        data: {},
      },
    ]
  }, [edges, hoveredConnectionTarget, pendingConnection])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const typeData = event.dataTransfer.getData('application/logsim-node')
      if (!typeData) return

      const { type, serviceType } = JSON.parse(typeData) as { type: NodeType; serviceType?: ServiceType }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      // Find if dropped onto a container
      const droppedElements = document.elementsFromPoint(event.clientX, event.clientY)
      let parentId: string | null = null
      for (const el of droppedElements) {
        const nodeEl = el.closest('[data-id]')
        if (nodeEl) {
          const nodeId = nodeEl.getAttribute('data-id')
          if (nodeId) {
            const parentNode = nodes.find(n => n.id === nodeId)
            if (parentNode && parentNode.data.type !== type) {
              parentId = nodeId
              break
            }
          }
        }
      }

      const size = DEFAULT_NODE_SIZES[type] || { width: 200, height: 80 }

      addNode({
        type,
        serviceType,
        position: {
          x: position.x - size.width / 2,
          y: position.y - size.height / 2,
        },
        size,
        parentId,
        label: getDefaultLabel(type, nodes.map(n => n.data), serviceType),
        config: getDefaultConfig(type, serviceType),
        provider: type === 'vpc' ? 'aws' : null,
      })
    },
    [screenToFlowPosition, nodes, addNode]
  )

  const onNodeClick = useCallback((_event: React.MouseEvent, node: { id: string }) => {
    selectNode(node.id)
  }, [selectNode])

  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: { id: string }) => {
    selectEdge(edge.id)
  }, [selectEdge])

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
    clearPendingConnection()
  }, [clearPendingConnection, selectNode, selectEdge])

  const onReconnect = useCallback<OnReconnect>((oldEdge, connection) => {
    if (!connection.source || !connection.target) return

    const srcNode = nodes.find(node => node.id === connection.source)
    const tgtNode = nodes.find(node => node.id === connection.target)
    let topologyWarning = false

    if (srcNode && tgtNode) {
      const getAncestorVpc = (nodeId: string): string | null => {
        const node = nodes.find(candidate => candidate.id === nodeId)
        if (!node) return null
        if (node.data.type === 'vpc') return node.id
        if (node.data.parentId) return getAncestorVpc(node.data.parentId)
        return null
      }

      const srcVpc = getAncestorVpc(srcNode.id)
      const tgtVpc = getAncestorVpc(tgtNode.id)
      topologyWarning = !!(srcVpc && tgtVpc && srcVpc !== tgtVpc)
    }

    updateEdge(oldEdge.id, {
      sourceId: connection.source,
      targetId: connection.target,
      sourceHandle: connection.sourceHandle as Connection['sourceHandle'],
      targetHandle: connection.targetHandle as Connection['targetHandle'],
      topologyWarning,
      bendX: undefined,
      bendY: undefined,
    })
  }, [nodes, updateEdge])

  return (
    <div ref={reactFlowWrapper} className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={renderedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onReconnect={onReconnect}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'connectionEdge', zIndex: 1000, reconnectable: true }}
        connectionMode={ConnectionMode.Loose}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: '#64748b', strokeWidth: 2.25, strokeLinecap: 'round' }}
        edgesReconnectable
        reconnectRadius={18}
        elevateEdgesOnSelect
        zIndexMode="manual"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={4}
        deleteKeyCode={['Delete', 'Backspace']}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#d9e1ec" />
        <Controls className="!bottom-4 !left-4 !rounded-2xl !border !border-white/70 !bg-white/[0.85] !shadow-[0_18px_40px_-24px_rgba(15,23,42,0.5)] !backdrop-blur" />
        {nodes.length === 0 && (
          <Panel position="top-center">
            <div className="mx-3 max-w-[calc(100vw-1.5rem)] rounded-full border border-white/80 bg-white/[0.82] px-3 py-1.5 text-center text-xs text-slate-500 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.45)] backdrop-blur">
              <span className="hidden sm:inline">Drag nodes from palette • Click a border +, then hover another + to preview the arrow • Click to connect</span>
              <span className="sm:hidden">Tap a node, then tap + handles to connect</span>
            </div>
          </Panel>
        )}
        {!describeOpen && (
          <Panel position="top-right">
            <button
              onClick={() => setDescribeOpen(true)}
              type="button"
              title="Describe a scenario in natural language"
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-violet-700 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.45)] backdrop-blur transition-colors hover:bg-violet-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Describe scenario</span>
            </button>
          </Panel>
        )}
      </ReactFlow>
      <DescribeScenarioPanel open={describeOpen} onClose={() => setDescribeOpen(false)} />
    </div>
  )
}
