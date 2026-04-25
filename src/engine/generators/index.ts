import type { ScenarioNode } from '@/types/nodes'
import { VpcFlowLogGenerator } from './VpcFlowLogGenerator'
import { NodejsLogGenerator } from './NodejsLogGenerator'
import { GolangLogGenerator } from './GolangLogGenerator'
import { PostgresLogGenerator } from './PostgresLogGenerator'
import { NginxLogGenerator } from './NginxLogGenerator'
import { MysqlLogGenerator } from './MysqlLogGenerator'
import { RedisLogGenerator } from './RedisLogGenerator'
import { CustomLogGenerator } from './CustomLogGenerator'
import type { BaseGenerator } from './BaseGenerator'

const VPC_FLOW = new VpcFlowLogGenerator()
const NODEJS = new NodejsLogGenerator()
const GOLANG = new GolangLogGenerator()
const POSTGRES = new PostgresLogGenerator()
const NGINX = new NginxLogGenerator()
const MYSQL = new MysqlLogGenerator()
const REDIS = new RedisLogGenerator()
const CUSTOM = new CustomLogGenerator()

export function getGeneratorForNode(node: ScenarioNode): BaseGenerator | null {
  switch (node.type) {
    case 'vpc':
      return VPC_FLOW
    case 'subnet':
      return null // subnets don't directly generate logs
    case 'virtual_server':
      return null // VMs don't generate app logs, just host metrics
    case 'service':
      switch (node.serviceType) {
        case 'nodejs': return NODEJS
        case 'golang': return GOLANG
        case 'postgres': return POSTGRES
        case 'mysql': return MYSQL
        case 'nginx': return NGINX
        case 'redis': return REDIS
        case 'custom': {
          // User-created custom types embed their spec in `config.customType`.
          // Without it, fall back to NODEJS so the legacy custom-service entry
          // still produces something useful.
          const cfg = node.config as Record<string, unknown>
          return cfg && cfg.customType ? CUSTOM : NODEJS
        }
        default: return NODEJS // fallback
      }
    default:
      return null
  }
}
