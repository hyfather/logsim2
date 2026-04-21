import type { ScenarioNode } from '@/types/nodes'
import { VpcFlowLogGenerator } from './VpcFlowLogGenerator'
import { NodejsLogGenerator } from './NodejsLogGenerator'
import { GolangLogGenerator } from './GolangLogGenerator'
import { PostgresLogGenerator } from './PostgresLogGenerator'
import { NginxLogGenerator } from './NginxLogGenerator'
import { MysqlLogGenerator } from './MysqlLogGenerator'
import { RedisLogGenerator } from './RedisLogGenerator'
import type { BaseGenerator } from './BaseGenerator'

const VPC_FLOW = new VpcFlowLogGenerator()
const NODEJS = new NodejsLogGenerator()
const GOLANG = new GolangLogGenerator()
const POSTGRES = new PostgresLogGenerator()
const NGINX = new NginxLogGenerator()
const MYSQL = new MysqlLogGenerator()
const REDIS = new RedisLogGenerator()

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
        default: return NODEJS // fallback
      }
    default:
      return null
  }
}
