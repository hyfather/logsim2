export type NodeType = 'vpc' | 'subnet' | 'virtual_server' | 'service'
export type Provider = 'aws' | 'gcp' | 'azure' | null

export interface ConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'multi-select' | 'array' | 'slider' | 'code' | 'color' | 'datetime'
  defaultValue?: unknown
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  description?: string
  required?: boolean
  section?: string
  subFields?: ConfigField[] // for array type
}

export interface VpcConfig {
  provider: Provider
  cidr: string
  region: string
  enableFlowLogs: boolean
  flowLogFormat: 'aws-default' | 'custom'
}

export interface SubnetConfig {
  cidr: string
  availabilityZone: string
  isPublic: boolean
}

export interface VirtualServerConfig {
  instanceType: string
  os: string
  privateIp: string
  securityGroups: string[]
}

export interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
  avgLatencyMs: number
  errorRate: number
}

export interface NodejsConfig {
  framework: 'express' | 'fastify' | 'koa'
  port: number
  logFormat: 'json' | 'text'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  endpoints: Endpoint[]
}

export interface GolangConfig {
  framework: 'net/http' | 'gin' | 'echo'
  port: number
  logFormat: 'json' | 'text'
  endpoints: Endpoint[]
}

export interface PostgresConfig {
  port: number
  version: string
  databases: string[]
  slowQueryThresholdMs: number
  logStatement: 'none' | 'ddl' | 'mod' | 'all'
}

export interface MysqlConfig {
  port: number
  version: string
  databases: string[]
  slowQueryLog: boolean
  slowQueryThresholdMs: number
}

export interface RedisConfig {
  port: number
  maxmemory: string
  evictionPolicy: string
}

export interface NginxConfig {
  port: number
  upstreamServers: string[]
  accessLogFormat: 'combined' | 'json'
  errorLogLevel: 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'crit'
}

export interface CustomServiceConfig {
  name: string
  port: number
  logTemplate: string
}

export type ServiceConfig =
  | NodejsConfig
  | GolangConfig
  | PostgresConfig
  | MysqlConfig
  | RedisConfig
  | NginxConfig
  | CustomServiceConfig

export type ServiceType = 'nodejs' | 'golang' | 'postgres' | 'mysql' | 'redis' | 'nginx' | 'custom'

export type NodeConfig = VpcConfig | SubnetConfig | VirtualServerConfig | ServiceConfig | Record<string, unknown>

export interface ScenarioNode {
  id: string
  type: NodeType
  serviceType?: ServiceType
  emoji?: string
  position: { x: number; y: number }
  size?: { width: number; height: number }
  parentId: string | null
  provider?: Provider
  channel: string
  config: NodeConfig
  label: string
  /** Optional IP for service nodes (virtual servers use `config.privateIp`). */
  privateIp?: string
  /**
   * When `serviceType === 'custom'`, references a user-created custom node type
   * in `useCustomNodeTypesStore`. The full spec is also embedded in `config.customType`
   * so log generation is self-contained and does not require a store lookup.
   */
  customTypeId?: string
}
