'use client'
import React, { useCallback, useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useScenarioStore } from '@/store/useScenarioStore'
import type { NodeType, ServiceType } from '@/types/nodes'
import { cn } from '@/lib/utils'
import { getDefaultConfig, getDefaultLabel } from '@/registry/nodeRegistry'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

interface PaletteItem {
  type: NodeType
  serviceType?: ServiceType
  label: string
  icon: string
  description: string
}

const PALETTE_ITEMS: { category: string; items: PaletteItem[] }[] = [
  {
    category: 'Network',
    items: [
      { type: 'vpc', label: 'VPC', icon: '🌐', description: 'Virtual Private Cloud' },
      { type: 'subnet', label: 'Subnet', icon: '🔲', description: 'Network subnet' },
    ],
  },
  {
    category: 'Compute',
    items: [
      { type: 'virtual_server', label: 'Virtual Server', icon: '💻', description: 'EC2 / VM instance' },
    ],
  },
  {
    category: 'Services',
    items: [
      { type: 'service', serviceType: 'nodejs', label: 'Node.js', icon: '🟩', description: 'Node.js/Express service' },
      { type: 'service', serviceType: 'golang', label: 'Go', icon: '🐹', description: 'Go service (Gin/Echo)' },
      { type: 'service', serviceType: 'postgres', label: 'PostgreSQL', icon: '🐘', description: 'PostgreSQL database' },
      { type: 'service', serviceType: 'mysql', label: 'MySQL', icon: '🐬', description: 'MySQL database' },
      { type: 'service', serviceType: 'redis', label: 'Redis', icon: '🔴', description: 'Redis cache/store' },
      { type: 'service', serviceType: 'nginx', label: 'Nginx', icon: '🌿', description: 'Nginx web server' },
      { type: 'service', serviceType: 'custom', label: 'Custom', icon: '⚙️', description: 'Custom service' },
    ],
  },
]

function PaletteItemCard({ item, onAdd }: { item: PaletteItem; onAdd: () => void }) {
  const onDragStart = useCallback((event: React.DragEvent) => {
    event.dataTransfer.setData(
      'application/logsim-node',
      JSON.stringify({ type: item.type, serviceType: item.serviceType })
    )
    event.dataTransfer.effectAllowed = 'move'
  }, [item])

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onAdd}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded border select-none',
        'cursor-pointer transition-colors',
        'border-gray-200 bg-white hover:bg-blue-50 hover:border-blue-200 active:bg-blue-100',
      )}
      title={item.description}
    >
      <span className="text-base leading-none">{item.icon}</span>
      <span className="text-xs font-medium text-gray-700">{item.label}</span>
    </div>
  )
}

export function Palette() {
  const isMobile = useIsMobile()
  // Default the palette to closed on mobile so it doesn't cover the canvas.
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (isMobile) setOpen(false)
  }, [isMobile])
  const { screenToFlowPosition } = useReactFlow()
  const { addNode, nodes } = useScenarioStore()

  const handleAddItem = useCallback((item: PaletteItem) => {
    const canvasEl = document.querySelector('.react-flow')
    const rect = canvasEl?.getBoundingClientRect()
    const centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
    const centerY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2

    const pos = screenToFlowPosition({ x: centerX, y: centerY })
    const size = DEFAULT_NODE_SIZES[item.type] || { width: 200, height: 80 }

    addNode({
      type: item.type,
      serviceType: item.serviceType,
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
      size,
      parentId: null,
      label: getDefaultLabel(item.type, nodes.map(n => n.data), item.serviceType),
      config: getDefaultConfig(item.type, item.serviceType),
      provider: item.type === 'vpc' ? 'aws' : null,
    })
  }, [screenToFlowPosition, addNode, nodes])

  if (!open) {
    return (
      <div className="absolute left-3 top-3 z-10 flex flex-col items-center rounded-lg border border-gray-200 bg-white/95 shadow-md backdrop-blur-sm">
        <button
          onClick={() => setOpen(true)}
          title="Open palette"
          className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="absolute left-3 top-3 bottom-3 z-10 flex w-40 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white/95 shadow-md backdrop-blur-sm sm:w-44">
      <div className="px-2.5 py-2 border-b border-gray-200 flex items-center justify-between shrink-0">
        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Add Node</h2>
        <button
          onClick={() => setOpen(false)}
          title="Collapse palette"
          className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="p-2 flex flex-col gap-3 flex-1 overflow-y-auto">
        {PALETTE_ITEMS.map(group => (
          <div key={group.category}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5 px-0.5">
              {group.category}
            </div>
            <div className="flex flex-col gap-1">
              {group.items.map(item => (
                <PaletteItemCard
                  key={`${item.type}-${item.serviceType || ''}`}
                  item={item}
                  onAdd={() => handleAddItem(item)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-2.5 py-2 border-t border-gray-200">
        <p className="text-[9px] text-gray-400 leading-relaxed">
          Click to add · Drag to position
        </p>
      </div>
    </div>
  )
}
