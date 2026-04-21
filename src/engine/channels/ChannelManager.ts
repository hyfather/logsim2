import type { ScenarioNode } from '@/types/nodes'

function slugify(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_.]/g, '')
}

export function computeChannel(
  node: ScenarioNode,
  allNodes: ScenarioNode[]
): string {
  const parts: string[] = []

  // Build ancestry chain
  const ancestors: ScenarioNode[] = []
  let current: ScenarioNode = node
  while (current.parentId) {
    const parent = allNodes.find(n => n.id === current.parentId)
    if (!parent) break
    ancestors.unshift(parent)
    current = parent
  }

  for (const ancestor of ancestors) {
    parts.push(slugify(ancestor.label || `${ancestor.type}-node`))
  }

  parts.push(slugify(node.label || `${node.type}-node`))

  return parts.join('.')
}

export function recomputeAllChannels(
  nodes: ScenarioNode[]
): ScenarioNode[] {
  return nodes.map(node => ({
    ...node,
    channel: computeChannel(node, nodes),
  }))
}

export function getAllChannels(nodes: ScenarioNode[]): string[] {
  return nodes.map(n => n.channel).filter(Boolean)
}
