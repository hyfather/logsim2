import type { ScenarioNode } from '@/types/nodes'

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
    return null
  }
  return parts
}

function parseCidr(cidr: string): { octets: number[]; prefix: number } | null {
  const [ip, prefixStr] = cidr.split('/')
  if (!ip || !prefixStr) return null
  const octets = parseIpv4(ip)
  const prefix = Number(prefixStr)
  if (!octets || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null
  return { octets, prefix }
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function clampHost(value: number): number {
  return (Math.abs(value) % 254) + 1
}

export function deriveIpFromCidr(cidr: string, seed: string): string {
  const parsed = parseCidr(cidr)
  if (!parsed) return ''

  const { octets, prefix } = parsed
  const hash = hashString(seed || cidr)
  const derived = [...octets]

  if (prefix >= 32) {
    return derived.join('.')
  }
  if (prefix >= 24) {
    derived[3] = clampHost(hash)
    return derived.join('.')
  }
  if (prefix >= 16) {
    derived[2] = clampHost(hash >> 8)
    derived[3] = clampHost(hash)
    return derived.join('.')
  }
  if (prefix >= 8) {
    derived[1] = clampHost(hash >> 16)
    derived[2] = clampHost(hash >> 8)
    derived[3] = clampHost(hash)
    return derived.join('.')
  }

  derived[0] = clampHost(hash >> 24)
  derived[1] = clampHost(hash >> 16)
  derived[2] = clampHost(hash >> 8)
  derived[3] = clampHost(hash)
  return derived.join('.')
}

export function derivePrivateIp(seed: string): string {
  const hash = hashString(seed)
  return `10.${clampHost(hash >> 16)}.${clampHost(hash >> 8)}.${clampHost(hash)}`
}

function findAncestor(
  node: ScenarioNode,
  nodes: ScenarioNode[],
  predicate: (candidate: ScenarioNode) => boolean
): ScenarioNode | null {
  let currentParentId = node.parentId
  while (currentParentId) {
    const parent = nodes.find(candidate => candidate.id === currentParentId) || null
    if (!parent) return null
    if (predicate(parent)) return parent
    currentParentId = parent.parentId
  }
  return null
}

export function getNodeIp(node: ScenarioNode, nodes: ScenarioNode[]): string {
  if (node.privateIp?.trim()) return node.privateIp.trim()

  const config = node.config as Record<string, unknown>
  const configuredIp = typeof config.privateIp === 'string' ? config.privateIp.trim() : ''
  if (configuredIp) return configuredIp

  if (node.type === 'service') {
    const parentServer = findAncestor(node, nodes, candidate => candidate.type === 'virtual_server')
    if (parentServer) return getNodeIp(parentServer, nodes)
  }

  const subnet = node.type === 'subnet'
    ? node
    : findAncestor(node, nodes, candidate => candidate.type === 'subnet')
  const subnetCidr = subnet ? String((subnet.config as Record<string, unknown>).cidr ?? '') : ''
  if (subnetCidr) return deriveIpFromCidr(subnetCidr, node.id)

  const vpc = node.type === 'vpc'
    ? node
    : findAncestor(node, nodes, candidate => candidate.type === 'vpc')
  const vpcCidr = vpc ? String((vpc.config as Record<string, unknown>).cidr ?? '') : ''
  if (vpcCidr) return deriveIpFromCidr(vpcCidr, node.id)

  return derivePrivateIp(node.id)
}

export function getNodeAddress(node: ScenarioNode, nodes: ScenarioNode[]): string {
  const config = node.config as Record<string, unknown>

  if (node.type === 'vpc' || node.type === 'subnet') {
    return String(config.cidr ?? '')
  }

  return getNodeIp(node, nodes)
}

export function getNodeHoverDetails(node: ScenarioNode, nodes: ScenarioNode[]): string {
  const addressLabel = node.type === 'vpc' || node.type === 'subnet' ? 'CIDR' : 'IP'
  return `${node.label}\nChannel: ${node.channel}\n${addressLabel}: ${getNodeAddress(node, nodes)}`
}
