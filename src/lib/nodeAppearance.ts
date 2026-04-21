import type { ScenarioNode, NodeType, ServiceType } from '@/types/nodes'

const SERVICE_EMOJIS: Record<ServiceType, string> = {
  nodejs: '🟩',
  golang: '🐹',
  postgres: '🐘',
  mysql: '🐬',
  redis: '🔴',
  nginx: '🌿',
  custom: '⚙️',
}

const NODE_EMOJIS: Record<Exclude<NodeType, 'service'>, string> = {
  vpc: '🌐',
  subnet: '🧩',
  virtual_server: '💻',
}

export function getDefaultNodeEmoji(type: NodeType, serviceType?: ServiceType) {
  if (type === 'service') {
    return SERVICE_EMOJIS[serviceType || 'custom']
  }

  return NODE_EMOJIS[type]
}

export function getNodeEmoji(node: Pick<ScenarioNode, 'type' | 'serviceType' | 'emoji'>) {
  return node.emoji || getDefaultNodeEmoji(node.type, node.serviceType)
}
