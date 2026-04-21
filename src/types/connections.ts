export type Protocol = 'tcp' | 'udp' | 'icmp' | 'http' | 'https' | 'grpc'
export type AnchorHandleId = 'top' | 'right' | 'bottom' | 'left'

export interface Connection {
  id: string
  sourceId: string
  targetId: string
  sourceHandle?: AnchorHandleId
  targetHandle?: AnchorHandleId
  protocol: Protocol
  port: number
  bandwidth?: number
  errorRate?: number
  trafficPattern?: 'steady' | 'bursty' | 'diurnal' | 'incident'
  trafficRate?: number // requests per second
  topologyWarning?: boolean
  bendX?: number
  bendY?: number
  config: Record<string, unknown>
}

export interface ConnectionActivity {
  connectionId: string
  requestCount: number
  errorCount: number
  bytesSent: number
  bytesReceived: number
  sourceId: string
  targetId: string
}
