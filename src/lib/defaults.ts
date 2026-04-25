import type { VpcConfig, SubnetConfig, VirtualServerConfig, NodejsConfig, GolangConfig, PostgresConfig, MysqlConfig, RedisConfig, NginxConfig, CustomServiceConfig } from '@/types/nodes'

export const defaultVpcConfig: VpcConfig = {
  provider: 'aws',
  cidr: '10.0.0.0/16',
  region: 'us-east-1',
  enableFlowLogs: true,
  flowLogFormat: 'aws-default',
}

export const defaultSubnetConfig: SubnetConfig = {
  cidr: '10.0.1.0/24',
  availabilityZone: 'us-east-1a',
  isPublic: false,
}

export const defaultVirtualServerConfig: VirtualServerConfig = {
  instanceType: 't3.medium',
  os: 'amazon-linux-2',
  privateIp: '',
  securityGroups: [],
}

export const defaultNodejsConfig: NodejsConfig = {
  framework: 'express',
  port: 3000,
  logFormat: 'json',
  logLevel: 'info',
  endpoints: [
    { method: 'GET', path: '/api/health', avgLatencyMs: 5, errorRate: 0.001 },
    { method: 'GET', path: '/api/users', avgLatencyMs: 45, errorRate: 0.02 },
    { method: 'POST', path: '/api/users', avgLatencyMs: 80, errorRate: 0.03 },
  ],
}

export const defaultGolangConfig: GolangConfig = {
  framework: 'gin',
  port: 8080,
  logFormat: 'json',
  endpoints: [
    { method: 'GET', path: '/health', avgLatencyMs: 3, errorRate: 0.001 },
    { method: 'GET', path: '/api/data', avgLatencyMs: 30, errorRate: 0.02 },
  ],
}

export const defaultPostgresConfig: PostgresConfig = {
  port: 5432,
  version: '15',
  databases: ['app_db'],
  slowQueryThresholdMs: 1000,
  logStatement: 'none',
}

export const defaultMysqlConfig: MysqlConfig = {
  port: 3306,
  version: '8.0',
  databases: ['app_db'],
  slowQueryLog: true,
  slowQueryThresholdMs: 2000,
}

export const defaultRedisConfig: RedisConfig = {
  port: 6379,
  maxmemory: '256mb',
  evictionPolicy: 'allkeys-lru',
}

export const defaultNginxConfig: NginxConfig = {
  port: 80,
  upstreamServers: [],
  accessLogFormat: 'combined',
  errorLogLevel: 'warn',
}

export const defaultCustomServiceConfig: CustomServiceConfig = {
  name: 'custom-service',
  port: 8080,
  logTemplate: '{{timestamp}} [{{level}}] {{message}}',
}

export const DEFAULT_NODE_SIZES = {
  vpc: { width: 520, height: 340 },
  subnet: { width: 340, height: 220 },
  virtual_server: { width: 220, height: 150 },
  service: { width: 210, height: 78 },
}
