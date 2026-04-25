'use client'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { NodeChange, EdgeChange, Connection as FlowConnection } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { ScenarioNode } from '@/types/nodes'
import type { Connection } from '@/types/connections'
import type { ScenarioFlowNode, ConnectionFlowEdge } from '@/types/flow'
import type { ScenarioMetadata } from '@/types/scenario'
import { generateId } from '@/lib/id'
import { recomputeAllChannels, computeChannel } from '@/engine/channels/ChannelManager'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'
import { getDefaultConfig, getDefaultLabel } from '@/registry/nodeRegistry'
import { asFlowEdgeData, asFlowNodeData } from '@/lib/flow-data'
import { getDefaultNodeEmoji } from '@/lib/nodeAppearance'
import { organizeFlow } from '@/lib/canvasLayout'

export type FlowNode = ScenarioFlowNode
export type FlowEdge = ConnectionFlowEdge

interface ScenarioState {
  metadata: ScenarioMetadata
  nodes: FlowNode[]
  edges: FlowEdge[]
  // Actions
  setMetadata: (metadata: Partial<ScenarioMetadata>) => void
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: FlowConnection) => void
  addNode: (node: Omit<ScenarioNode, 'id' | 'channel'>) => string
  updateNode: (id: string, data: Partial<ScenarioNode>) => void
  deleteNode: (id: string) => void
  deleteEdge: (id: string) => void
  updateEdge: (id: string, data: Partial<Connection>) => void
  renameNode: (id: string, label: string) => void
  reparentNode: (nodeId: string, newParentId: string | null) => void
  loadScenario: (nodes: FlowNode[], edges: FlowEdge[], metadata: ScenarioMetadata) => void
  organizeLayout: () => void
  resetScenario: () => void
}

function toFlowNode(node: ScenarioNode): FlowNode {
  const size = node.size || DEFAULT_NODE_SIZES[node.type] || { width: 200, height: 100 }
  const isContainer = node.type !== 'service'
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    parentId: node.parentId || undefined,
    data: asFlowNodeData(node),
    style: {
      width: size.width,
      height: size.height,
    },
    ...(isContainer ? {
      style: { width: size.width, height: size.height },
    } : {}),
    ...(node.parentId ? { extent: 'parent' as const } : {}),
  }
}

// React Flow requires parent nodes to appear before their children in the array,
// otherwise dragging a parent doesn't propagate to children's handle bounds and
// edges visually disconnect.
function sortNodesByHierarchy(nodes: FlowNode[]): FlowNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const out: FlowNode[] = []
  const visit = (node: FlowNode) => {
    if (seen.has(node.id)) return
    const parentId = node.parentId
    if (parentId && byId.has(parentId)) {
      visit(byId.get(parentId)!)
    }
    seen.add(node.id)
    out.push(node)
  }
  nodes.forEach(visit)
  return out
}

function toFlowEdge(conn: Connection): FlowEdge {
  return {
    id: conn.id,
    source: conn.sourceId,
    target: conn.targetId,
    sourceHandle: conn.sourceHandle,
    targetHandle: conn.targetHandle,
    type: 'connectionEdge',
    data: asFlowEdgeData(conn),
    animated: false,
    reconnectable: true,
    zIndex: 1000,
    label: conn.protocol.toUpperCase(),
  }
}

const defaultMetadata: ScenarioMetadata = {
  name: 'My Scenario',
  description: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

export const useScenarioStore = create<ScenarioState>()(
  subscribeWithSelector((set, get) => ({
    metadata: defaultMetadata,
    nodes: [],
    edges: [],

    setMetadata: (meta) => {
      set(state => ({
        metadata: { ...state.metadata, ...meta, updatedAt: new Date().toISOString() },
      }))
    },

    onNodesChange: (changes) => {
      set(state => ({ nodes: applyNodeChanges(changes, state.nodes) as FlowNode[] }))
    },

    onEdgesChange: (changes) => {
      set(state => ({ edges: applyEdgeChanges(changes, state.edges) as FlowEdge[] }))
    },

    onConnect: (connection) => {
      const { nodes } = get()
      const srcNode = nodes.find(n => n.id === connection.source)
      const tgtNode = nodes.find(n => n.id === connection.target)

      // Check topology warning (cross-VPC)
      let topologyWarning = false
      if (srcNode && tgtNode) {
        const srcVpc = getAncestorVpc(srcNode.id, nodes)
        const tgtVpc = getAncestorVpc(tgtNode.id, nodes)
        topologyWarning = !!(srcVpc && tgtVpc && srcVpc !== tgtVpc)
      }

      const newConn: Connection = {
        id: generateId(),
        sourceId: connection.source || '',
        targetId: connection.target || '',
        sourceHandle: (connection.sourceHandle as Connection['sourceHandle']) || undefined,
        targetHandle: (connection.targetHandle as Connection['targetHandle']) || undefined,
        protocol: 'tcp',
        port: (tgtNode?.data?.config as Record<string, unknown> | undefined)?.port as number | undefined ?? 80,
        topologyWarning,
        trafficPattern: 'steady',
        trafficRate: 10,
        config: {},
      }

      set(state => ({
        edges: addEdge(toFlowEdge(newConn), state.edges) as FlowEdge[],
      }))
    },

    addNode: (nodeData) => {
      const id = generateId()
      const { nodes } = get()

      const existing = nodes.map(n => n.data)
      const scNode: ScenarioNode = {
        ...nodeData,
        id,
        channel: '',
        emoji: nodeData.emoji || getDefaultNodeEmoji(nodeData.type, nodeData.serviceType),
        label: nodeData.label || getDefaultLabel(nodeData.type, existing, nodeData.serviceType),
        config: nodeData.config || getDefaultConfig(nodeData.type, nodeData.serviceType),
      }

      // Build allNodes for channel computation
      const allScNodes: ScenarioNode[] = nodes.map(n => n.data)
      scNode.channel = computeChannel(scNode, [...allScNodes, scNode])

      const flowNode = toFlowNode(scNode)
      set(state => ({ nodes: sortNodesByHierarchy([...state.nodes, flowNode]) }))

      return id
    },

    updateNode: (id, data) => {
      set(state => {
        const updated = state.nodes.map(n => {
          if (n.id !== id) return n
          const newData = { ...n.data, ...data } as ScenarioNode
          const next: FlowNode = { ...n, data: asFlowNodeData(newData) }
          if (data.size) {
            next.style = {
              ...n.style,
              width: data.size.width,
              height: data.size.height,
            }
          }
          return next
        })
        return { nodes: updated }
      })
    },

    deleteNode: (id) => {
      set(state => {
        // Also delete children
        const toDelete = new Set<string>()
        const collectChildren = (nodeId: string) => {
          toDelete.add(nodeId)
          state.nodes.forEach(n => {
            if (n.data.parentId === nodeId) collectChildren(n.id)
          })
        }
        collectChildren(id)
        return {
          nodes: state.nodes.filter(n => !toDelete.has(n.id)),
          edges: state.edges.filter(e => !toDelete.has(e.source) && !toDelete.has(e.target)),
        }
      })
    },

    deleteEdge: (id) => {
      set(state => ({ edges: state.edges.filter(e => e.id !== id) }))
    },

    updateEdge: (id, data) => {
      set(state => ({
        edges: state.edges.map(e => {
          if (e.id !== id) return e
          return {
            ...e,
            source: data.sourceId ?? e.source,
            target: data.targetId ?? e.target,
            sourceHandle: data.sourceHandle ?? e.sourceHandle,
            targetHandle: data.targetHandle ?? e.targetHandle,
            zIndex: 1000,
            data: { ...e.data!, ...data },
          }
        }),
      }))
    },

    renameNode: (id, label) => {
      const { nodes } = get()
      const updatedNodes = nodes.map(n => {
        if (n.id !== id) return n
        const newData = { ...n.data, label }
        return { ...n, data: newData }
      })
      // Recompute channels for renamed node and descendants
      const allScNodes: ScenarioNode[] = updatedNodes.map(n => n.data)
      const recomputed = recomputeAllChannels(allScNodes)
      const finalNodes = updatedNodes.map(n => {
        const sc = recomputed.find(sc => sc.id === n.id) ?? n.data
        return { ...n, data: asFlowNodeData(sc) }
      })
      set({ nodes: finalNodes })
    },

    reparentNode: (nodeId, newParentId) => {
      const { nodes } = get()
      const updatedNodes = nodes.map(n => {
        if (n.id !== nodeId) return n
        const newData = { ...n.data, parentId: newParentId }
        return {
          ...n,
          data: newData,
          parentId: newParentId || undefined,
          extent: newParentId ? ('parent' as const) : undefined,
        }
      })
      const allScNodes: ScenarioNode[] = updatedNodes.map(n => n.data)
      const recomputed = recomputeAllChannels(allScNodes)
      const finalNodes = updatedNodes.map(n => {
        const sc = recomputed.find(s => s.id === n.id) ?? n.data
        return { ...n, data: asFlowNodeData(sc) }
      })
      set({ nodes: sortNodesByHierarchy(finalNodes) })
    },

    loadScenario: (nodes, edges, metadata) => {
      set({ nodes: sortNodesByHierarchy(nodes), edges, metadata })
    },

    organizeLayout: () => {
      set(state => {
        if (state.nodes.length === 0) return {}
        const { nodes, edges } = organizeFlow(state.nodes, state.edges)
        return { nodes, edges }
      })
    },

    resetScenario: () => {
      set({
        nodes: [],
        edges: [],
        metadata: {
          ...defaultMetadata,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })
    },
  }))
)

function getAncestorVpc(nodeId: string, nodes: FlowNode[]): string | null {
  const node = nodes.find(n => n.id === nodeId)
  if (!node) return null
  if (node.data.type === 'vpc') return nodeId
  if (node.data.parentId) return getAncestorVpc(node.data.parentId, nodes)
  return null
}
