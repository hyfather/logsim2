import type { NodeType, ServiceType, ConfigField, ScenarioNode } from '@/types/nodes'
import type { CustomNodeType } from '@/types/customNodeType'
import {
  defaultVpcConfig,
  defaultSubnetConfig,
  defaultVirtualServerConfig,
  defaultNodejsConfig,
  defaultGolangConfig,
  defaultPostgresConfig,
  defaultMysqlConfig,
  defaultRedisConfig,
  defaultNginxConfig,
  defaultCustomServiceConfig,
} from '@/lib/defaults'
import { getErrorScenarios } from '@/engine/generators/errorTemplates'

export interface NodeRegistryEntry {
  type: NodeType
  serviceType?: ServiceType
  category: 'network' | 'compute' | 'service' | 'storage' | 'security'
  displayName: string
  icon: string // emoji
  configSchema: ConfigField[]
  defaults: Record<string, unknown>
  isContainer: boolean
  allowedParents: string[]
  allowedChildren: string[]
  color: string
  borderStyle: 'solid' | 'dashed'
}

const AWS_REGIONS = [
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'eu-west-1', label: 'Europe (Ireland)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
]

export const vpcConfigSchema: ConfigField[] = [
  { key: 'provider', label: 'Provider', type: 'select', options: [
    { value: 'aws', label: 'AWS' }, { value: 'gcp', label: 'GCP' }, { value: 'azure', label: 'Azure' }
  ], defaultValue: 'aws', section: 'Network' },
  { key: 'cidr', label: 'CIDR Block', type: 'string', defaultValue: '10.0.0.0/16', placeholder: '10.0.0.0/16', section: 'Network' },
  { key: 'region', label: 'Region', type: 'select', options: AWS_REGIONS, defaultValue: 'us-east-1', section: 'Network' },
  { key: 'enableFlowLogs', label: 'Enable Flow Logs', type: 'boolean', defaultValue: true, section: 'Logging' },
  { key: 'flowLogFormat', label: 'Flow Log Format', type: 'select', options: [
    { value: 'aws-default', label: 'AWS Default' }, { value: 'custom', label: 'Custom Fields' }
  ], defaultValue: 'aws-default', section: 'Logging' },
]

export const subnetConfigSchema: ConfigField[] = [
  { key: 'cidr', label: 'CIDR Block', type: 'string', defaultValue: '10.0.1.0/24', placeholder: '10.0.1.0/24', section: 'Network' },
  { key: 'availabilityZone', label: 'Availability Zone', type: 'string', defaultValue: 'us-east-1a', section: 'Network' },
  { key: 'isPublic', label: 'Public Subnet', type: 'boolean', defaultValue: false, section: 'Network' },
]

export const virtualServerConfigSchema: ConfigField[] = [
  { key: 'instanceType', label: 'Instance Type', type: 'string', defaultValue: 't3.medium', section: 'Compute' },
  { key: 'os', label: 'Operating System', type: 'select', options: [
    { value: 'amazon-linux-2', label: 'Amazon Linux 2' },
    { value: 'ubuntu-22', label: 'Ubuntu 22.04' },
    { value: 'ubuntu-20', label: 'Ubuntu 20.04' },
    { value: 'debian-11', label: 'Debian 11' },
  ], defaultValue: 'amazon-linux-2', section: 'Compute' },
]

export const nodejsConfigSchema: ConfigField[] = [
  { key: 'framework', label: 'Framework', type: 'select', options: [
    { value: 'express', label: 'Express' }, { value: 'fastify', label: 'Fastify' }, { value: 'koa', label: 'Koa' }
  ], defaultValue: 'express', section: 'Service' },
  { key: 'port', label: 'Port', type: 'number', defaultValue: 3000, min: 1, max: 65535, section: 'Service' },
  { key: 'logFormat', label: 'Log Format', type: 'select', options: [
    { value: 'json', label: 'JSON' }, { value: 'text', label: 'Text' }
  ], defaultValue: 'json', section: 'Logging' },
  { key: 'trafficRate', label: 'Traffic Rate (req/s)', type: 'slider', min: 0, max: 1000, step: 1, defaultValue: 10, section: 'Traffic' },
  { key: 'errorScenario', label: 'Error Scenario', type: 'select', options: getErrorScenarios('nodejs'), defaultValue: 'none', section: 'Errors' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0, section: 'Errors' },
]

export const golangConfigSchema: ConfigField[] = [
  { key: 'framework', label: 'Framework', type: 'select', options: [
    { value: 'net/http', label: 'net/http' }, { value: 'gin', label: 'Gin' }, { value: 'echo', label: 'Echo' }
  ], defaultValue: 'gin', section: 'Service' },
  { key: 'port', label: 'Port', type: 'number', defaultValue: 8080, min: 1, max: 65535, section: 'Service' },
  { key: 'logFormat', label: 'Log Format', type: 'select', options: [
    { value: 'json', label: 'JSON' }, { value: 'text', label: 'Text' }
  ], defaultValue: 'json', section: 'Logging' },
  { key: 'trafficRate', label: 'Traffic Rate (req/s)', type: 'slider', min: 0, max: 1000, step: 1, defaultValue: 10, section: 'Traffic' },
  { key: 'errorScenario', label: 'Error Scenario', type: 'select', options: getErrorScenarios('golang'), defaultValue: 'none', section: 'Errors' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0, section: 'Errors' },
]

export const postgresConfigSchema: ConfigField[] = [
  { key: 'port', label: 'Port', type: 'number', defaultValue: 5432, section: 'Service' },
  { key: 'version', label: 'Version', type: 'string', defaultValue: '15', section: 'Service' },
  { key: 'slowQueryThresholdMs', label: 'Slow Query Threshold (ms)', type: 'number', defaultValue: 1000, section: 'Logging' },
  { key: 'logStatement', label: 'Log Statement', type: 'select', options: [
    { value: 'none', label: 'None' }, { value: 'ddl', label: 'DDL' }, { value: 'mod', label: 'MOD' }, { value: 'all', label: 'All' }
  ], defaultValue: 'none', section: 'Logging' },
  { key: 'qps', label: 'Queries Per Second', type: 'slider', min: 0, max: 1000, step: 1, defaultValue: 20, section: 'Traffic' },
  { key: 'errorScenario', label: 'Error Scenario', type: 'select', options: getErrorScenarios('postgres'), defaultValue: 'none', section: 'Errors' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0, section: 'Errors' },
]

export const mysqlConfigSchema: ConfigField[] = [
  { key: 'port', label: 'Port', type: 'number', defaultValue: 3306, section: 'Service' },
  { key: 'version', label: 'Version', type: 'string', defaultValue: '8.0', section: 'Service' },
  { key: 'slowQueryLog', label: 'Slow Query Log', type: 'boolean', defaultValue: true, section: 'Logging' },
  { key: 'slowQueryThresholdMs', label: 'Slow Query Threshold (ms)', type: 'number', defaultValue: 2000, section: 'Logging' },
  { key: 'qps', label: 'Queries Per Second', type: 'slider', min: 0, max: 1000, step: 1, defaultValue: 20, section: 'Traffic' },
  { key: 'errorScenario', label: 'Error Scenario', type: 'select', options: getErrorScenarios('mysql'), defaultValue: 'none', section: 'Errors' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0, section: 'Errors' },
]

export const redisConfigSchema: ConfigField[] = [
  { key: 'port', label: 'Port', type: 'number', defaultValue: 6379, section: 'Service' },
  { key: 'maxmemory', label: 'Max Memory', type: 'string', defaultValue: '256mb', section: 'Service' },
  { key: 'evictionPolicy', label: 'Eviction Policy', type: 'select', options: [
    { value: 'allkeys-lru', label: 'allkeys-lru' }, { value: 'volatile-lru', label: 'volatile-lru' },
    { value: 'allkeys-random', label: 'allkeys-random' }, { value: 'noeviction', label: 'noeviction' }
  ], defaultValue: 'allkeys-lru', section: 'Service' },
  { key: 'opsRate', label: 'Ops Per Second', type: 'slider', min: 0, max: 10000, step: 10, defaultValue: 100, section: 'Traffic' },
  { key: 'errorScenario', label: 'Error Scenario', type: 'select', options: getErrorScenarios('redis'), defaultValue: 'none', section: 'Errors' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0, section: 'Errors' },
]

export const nginxConfigSchema: ConfigField[] = [
  { key: 'port', label: 'Port', type: 'number', defaultValue: 80, section: 'Service' },
  { key: 'accessLogFormat', label: 'Access Log Format', type: 'select', options: [
    { value: 'combined', label: 'Combined' }, { value: 'json', label: 'JSON' }
  ], defaultValue: 'combined', section: 'Logging' },
  { key: 'trafficRate', label: 'Traffic Rate (req/s)', type: 'slider', min: 0, max: 10000, step: 10, defaultValue: 100, section: 'Traffic' },
  { key: 'errorScenario', label: 'Error Scenario', type: 'select', options: getErrorScenarios('nginx'), defaultValue: 'none', section: 'Errors' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0, section: 'Errors' },
]

export const customServiceConfigSchema: ConfigField[] = [
  { key: 'port', label: 'Port', type: 'number', defaultValue: 8080, min: 1, max: 65535, section: 'Service' },
  { key: 'trafficRate', label: 'Events / sec', type: 'slider', min: 0, max: 1000, step: 1, defaultValue: 10, section: 'Traffic' },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0.02, section: 'Errors' },
]

export const connectionConfigSchema: ConfigField[] = [
  { key: 'protocol', label: 'Protocol', type: 'select', options: [
    { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' },
    { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' },
    { value: 'grpc', label: 'gRPC' }, { value: 'icmp', label: 'ICMP' }
  ], defaultValue: 'tcp' },
  { key: 'port', label: 'Port', type: 'number', defaultValue: 80, min: 1, max: 65535 },
  { key: 'trafficPattern', label: 'Traffic Pattern', type: 'select', options: [
    { value: 'steady', label: 'Steady' }, { value: 'bursty', label: 'Bursty' },
    { value: 'diurnal', label: 'Diurnal' }, { value: 'incident', label: 'Incident' }
  ], defaultValue: 'steady' },
  { key: 'trafficRate', label: 'Traffic Rate (req/s)', type: 'slider', min: 0, max: 1000, step: 1, defaultValue: 10 },
  { key: 'errorRate', label: 'Error Rate', type: 'slider', min: 0, max: 1, step: 0.01, defaultValue: 0.01 },
]

export const nodeRegistry: Record<string, NodeRegistryEntry> = {
  vpc: {
    type: 'vpc', category: 'network', displayName: 'VPC', icon: '🌐',
    configSchema: vpcConfigSchema,
    defaults: defaultVpcConfig as unknown as Record<string, unknown>,
    isContainer: true, allowedParents: [], allowedChildren: ['subnet'],
    color: '#000000', borderStyle: 'solid',
  },
  subnet: {
    type: 'subnet', category: 'network', displayName: 'Subnet', icon: '🔲',
    configSchema: subnetConfigSchema,
    defaults: defaultSubnetConfig as unknown as Record<string, unknown>,
    isContainer: true, allowedParents: ['vpc'], allowedChildren: ['virtual_server'],
    color: '#374151', borderStyle: 'dashed',
  },
  virtual_server: {
    type: 'virtual_server', category: 'compute', displayName: 'Virtual Server', icon: '💻',
    configSchema: virtualServerConfigSchema,
    defaults: defaultVirtualServerConfig as unknown as Record<string, unknown>,
    isContainer: true, allowedParents: ['subnet'], allowedChildren: ['service'],
    color: '#dc2626', borderStyle: 'solid',
  },
  'service:nodejs': {
    type: 'service', serviceType: 'nodejs', category: 'service', displayName: 'Node.js Service', icon: '🟩',
    configSchema: nodejsConfigSchema,
    defaults: defaultNodejsConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
  'service:golang': {
    type: 'service', serviceType: 'golang', category: 'service', displayName: 'Go Service', icon: '🐹',
    configSchema: golangConfigSchema,
    defaults: defaultGolangConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
  'service:postgres': {
    type: 'service', serviceType: 'postgres', category: 'service', displayName: 'PostgreSQL', icon: '🐘',
    configSchema: postgresConfigSchema,
    defaults: defaultPostgresConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
  'service:mysql': {
    type: 'service', serviceType: 'mysql', category: 'service', displayName: 'MySQL', icon: '🐬',
    configSchema: mysqlConfigSchema,
    defaults: defaultMysqlConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
  'service:redis': {
    type: 'service', serviceType: 'redis', category: 'service', displayName: 'Redis', icon: '🔴',
    configSchema: redisConfigSchema,
    defaults: defaultRedisConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
  'service:nginx': {
    type: 'service', serviceType: 'nginx', category: 'service', displayName: 'Nginx', icon: '🌿',
    configSchema: nginxConfigSchema,
    defaults: defaultNginxConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
  'service:custom': {
    type: 'service', serviceType: 'custom', category: 'service', displayName: 'Custom Service', icon: '⚙️',
    configSchema: customServiceConfigSchema,
    defaults: defaultCustomServiceConfig as unknown as Record<string, unknown>,
    isContainer: false, allowedParents: ['virtual_server', 'subnet'], allowedChildren: [],
    color: '#16a34a', borderStyle: 'solid',
  },
}

/**
 * Build a palette-friendly registry entry from a user-created CustomNodeType.
 * The custom type's full spec is embedded in `node.config.customType` when the
 * node is dropped onto the canvas, so the engine generator is self-contained.
 */
export function buildCustomTypeRegistryEntry(customType: CustomNodeType): NodeRegistryEntry {
  return {
    type: 'service',
    serviceType: 'custom',
    category: 'service',
    displayName: customType.name,
    icon: customType.icon || '⚙️',
    configSchema: customServiceConfigSchema,
    defaults: {
      name: customType.name,
      port: customType.defaultPort ?? 8080,
      trafficRate: customType.defaultRate,
      errorRate: customType.defaultErrorRate,
      customType: structuredClone(customType),
    },
    isContainer: false,
    allowedParents: ['virtual_server', 'subnet'],
    allowedChildren: [],
    color: '#16a34a',
    borderStyle: 'solid',
  }
}

export function getRegistryKey(type: NodeType, serviceType?: ServiceType): string {
  if (type === 'service' && serviceType) return `service:${serviceType}`
  return type
}

export function getRegistryEntry(type: NodeType, serviceType?: ServiceType): NodeRegistryEntry | null {
  return nodeRegistry[getRegistryKey(type, serviceType)] || null
}

export function getDefaultConfig(type: NodeType, serviceType?: ServiceType): Record<string, unknown> {
  const entry = getRegistryEntry(type, serviceType)
  return entry?.defaults || {}
}

const SERVICE_LABEL_PREFIX: Record<ServiceType, string> = {
  nodejs: 'nodejs',
  golang: 'golang',
  postgres: 'postgres',
  mysql: 'mysql',
  redis: 'redis',
  nginx: 'nginx',
  custom: 'custom',
}

/** Count existing nodes of the same kind to produce names like `postgres-1`, `vpc-2`. */
export function getDefaultLabel(
  type: NodeType,
  existing: Pick<ScenarioNode, 'type' | 'serviceType'>[],
  serviceType?: ServiceType
): string {
  if (type === 'service' && serviceType) {
    const prefix = SERVICE_LABEL_PREFIX[serviceType]
    const n = existing.filter(x => x.type === 'service' && x.serviceType === serviceType).length + 1
    return `${prefix}-${n}`
  }
  if (type === 'vpc') {
    const n = existing.filter(x => x.type === 'vpc').length + 1
    return `vpc-${n}`
  }
  if (type === 'subnet') {
    const n = existing.filter(x => x.type === 'subnet').length + 1
    return `subnet-${n}`
  }
  if (type === 'virtual_server') {
    const n = existing.filter(x => x.type === 'virtual_server').length + 1
    return `ec2-${n}`
  }
  const n = existing.filter(x => x.type === 'service').length + 1
  return `service-${n}`
}

export function getNodeColor(type: NodeType, serviceType?: ServiceType): string {
  const entry = getRegistryEntry(type, serviceType)
  return entry?.color || '#6b7280'
}
