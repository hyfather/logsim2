'use client'
import { create } from 'zustand'
import type { AnchorHandleId } from '@/types/connections'

export interface PendingConnection {
  nodeId: string
  handleId: AnchorHandleId
}

interface UIState {
  selectedNodeId: string | null
  selectedEdgeId: string | null
  pendingConnection: PendingConnection | null
  hoveredConnectionTarget: PendingConnection | null
  configPanelOpen: boolean
  configPanelAnchor: { x: number; y: number } | null
  logPanelWidth: number
  logPanelOpen: boolean
  canvasOpen: boolean
  timelineHeight: number
  timelineCollapsed: boolean
  canvasCollapsed: boolean
  isDraggingFromPalette: boolean
  paletteNodeType: string | null
  modifyPanelOpen: boolean
  newScenarioModalOpen: boolean
  hoveredServiceId: string | null
  // Actions
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  setPendingConnection: (connection: PendingConnection | null) => void
  setHoveredConnectionTarget: (connection: PendingConnection | null) => void
  clearPendingConnection: () => void
  setConfigPanelOpen: (open: boolean) => void
  setConfigPanelAnchor: (anchor: { x: number; y: number } | null) => void
  setLogPanelWidth: (width: number) => void
  setLogPanelOpen: (open: boolean) => void
  setCanvasOpen: (open: boolean) => void
  setTimelineHeight: (height: number) => void
  setTimelineCollapsed: (collapsed: boolean) => void
  setCanvasCollapsed: (collapsed: boolean) => void
  setDraggingFromPalette: (isDragging: boolean, nodeType?: string) => void
  setModifyPanelOpen: (open: boolean) => void
  setNewScenarioModalOpen: (open: boolean) => void
  setHoveredServiceId: (id: string | null) => void
}

export const useUIStore = create<UIState>()((set) => ({
  selectedNodeId: null,
  selectedEdgeId: null,
  pendingConnection: null,
  hoveredConnectionTarget: null,
  configPanelOpen: false,
  configPanelAnchor: null,
  logPanelWidth: 420,
  logPanelOpen: true,
  canvasOpen: true,
  timelineHeight: 240,
  timelineCollapsed: false,
  canvasCollapsed: false,
  isDraggingFromPalette: false,
  paletteNodeType: null,
  modifyPanelOpen: false,
  newScenarioModalOpen: false,
  hoveredServiceId: null,

  selectNode: (id) => set({
    selectedNodeId: id,
    selectedEdgeId: null,
    pendingConnection: null,
    hoveredConnectionTarget: null,
  }),
  selectEdge: (id) => set({
    selectedEdgeId: id,
    selectedNodeId: null,
    pendingConnection: null,
    hoveredConnectionTarget: null,
  }),
  setPendingConnection: (pendingConnection) => set({ pendingConnection, hoveredConnectionTarget: null }),
  setHoveredConnectionTarget: (hoveredConnectionTarget) => set({ hoveredConnectionTarget }),
  clearPendingConnection: () => set({ pendingConnection: null, hoveredConnectionTarget: null }),
  setConfigPanelOpen: (open) => set({ configPanelOpen: open }),
  setConfigPanelAnchor: (anchor) => set({ configPanelAnchor: anchor }),
  setLogPanelWidth: (width) => set({ logPanelWidth: width }),
  setLogPanelOpen: (open) => set({ logPanelOpen: open }),
  setCanvasOpen: (open) => set({ canvasOpen: open }),
  setTimelineHeight: (height) => set({ timelineHeight: height }),
  setTimelineCollapsed: (collapsed) => set({ timelineCollapsed: collapsed }),
  setCanvasCollapsed: (collapsed) => set({ canvasCollapsed: collapsed }),
  setDraggingFromPalette: (isDragging, nodeType) =>
    set({ isDraggingFromPalette: isDragging, paletteNodeType: nodeType || null }),
  setModifyPanelOpen: (open) => set({ modifyPanelOpen: open }),
  setNewScenarioModalOpen: (open) => set({ newScenarioModalOpen: open }),
  setHoveredServiceId: (id) => set({ hoveredServiceId: id }),
}))
