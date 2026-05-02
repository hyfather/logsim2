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
  /** Elbow offset from the natural source→target midpoint, in flow coords.
   *  Stored as an offset (not absolute) so the bend follows when a parent
   *  container is dragged. */
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
