/// <reference lib="webworker" />
import { SimulationEngine } from './SimulationEngine'
import type { ScenarioNode } from '@/types/nodes'
import type { Connection, ConnectionActivity } from '@/types/connections'
import type { TrafficFlow } from './traffic/TrafficSimulator'

export type WorkerMessage =
  | { type: 'start'; payload: { nodes: ScenarioNode[]; connections: Connection[]; speed: number; seed?: number; startTime?: number } }
  | { type: 'step'; payload: { nodes: ScenarioNode[]; connections: Connection[] } }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'setSpeed'; payload: { speed: number } }
  | { type: 'bulkGenerate'; payload: { nodes: ScenarioNode[]; connections: Connection[]; durationMs: number; channelFilter?: string; startTime?: number; seed?: number } }

export type WorkerResponse =
  | { type: 'logs'; payload: { logs: import('@/types/logs').LogEntry[]; tickIndex: number; simulatedTime: string; activeConnections: ConnectionActivity[] } }
  | { type: 'status'; payload: { status: string } }
  | { type: 'bulkProgress'; payload: { progress: number } }
  | { type: 'bulkComplete'; payload: { logs: import('@/types/logs').LogEntry[]; tickCount: number } }
  | { type: 'error'; payload: { message: string } }

let engine: SimulationEngine | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let speed = 1
let currentNodes: ScenarioNode[] = []
let currentConnections: Connection[] = []

function toConnectionActivity(flows: TrafficFlow[]): ConnectionActivity[] {
  return flows.map(flow => ({
    connectionId: flow.connectionId,
    requestCount: flow.requestCount,
    errorCount: flow.errorCount,
    bytesSent: flow.bytesSent,
    bytesReceived: flow.bytesReceived,
    sourceId: flow.sourceId,
    targetId: flow.targetId,
  }))
}

function stopInterval() {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

function startTickLoop() {
  stopInterval()
  if (!engine) return

  const msPerTick = Math.max(50, 1000 / speed)

  intervalId = setInterval(() => {
    if (!engine) return
    try {
      const { logs, flows } = engine.tickWithFlows(currentNodes, currentConnections)
      const response: WorkerResponse = {
        type: 'logs',
        payload: {
          logs,
          tickIndex: engine.getTickIndex(),
          simulatedTime: engine.getCurrentTime().toISOString(),
          activeConnections: toConnectionActivity(flows),
        },
      }
      self.postMessage(response)
    } catch (err) {
      self.postMessage({ type: 'error', payload: { message: String(err) } } satisfies WorkerResponse)
    }
  }, msPerTick)
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data

  try {
    switch (msg.type) {
      case 'start': {
        const { nodes, connections, speed: s, seed, startTime } = msg.payload
        currentNodes = nodes
        currentConnections = connections
        speed = s

        if (!engine) {
          engine = new SimulationEngine({ seed, startTime })
        }
        startTickLoop()
        self.postMessage({ type: 'status', payload: { status: 'running' } } satisfies WorkerResponse)
        break
      }

      case 'step': {
        const { nodes, connections } = msg.payload
        currentNodes = nodes
        currentConnections = connections

        if (!engine) {
          engine = new SimulationEngine()
        }
        stopInterval()
        const { logs, flows } = engine.tickWithFlows(currentNodes, currentConnections)
        self.postMessage({
          type: 'logs',
          payload: {
            logs,
            tickIndex: engine.getTickIndex(),
            simulatedTime: engine.getCurrentTime().toISOString(),
            activeConnections: toConnectionActivity(flows),
          },
        } satisfies WorkerResponse)
        break
      }

      case 'stop': {
        stopInterval()
        self.postMessage({ type: 'status', payload: { status: 'idle' } } satisfies WorkerResponse)
        break
      }

      case 'reset': {
        stopInterval()
        engine = null
        currentNodes = []
        currentConnections = []
        self.postMessage({ type: 'status', payload: { status: 'idle' } } satisfies WorkerResponse)
        break
      }

      case 'setSpeed': {
        speed = msg.payload.speed
        if (intervalId !== null && engine) {
          startTickLoop()
        }
        break
      }

      case 'bulkGenerate': {
        const { nodes, connections, durationMs, channelFilter, startTime, seed } = msg.payload
        stopInterval()

        const bulkEngine = new SimulationEngine({
          seed: seed ?? Math.floor(Math.random() * 1000000),
          startTime,
          channelFilter,
        })

        const logs = bulkEngine.bulkGenerate(
          nodes,
          connections,
          durationMs,
          channelFilter,
          (progress) => {
            self.postMessage({ type: 'bulkProgress', payload: { progress } } satisfies WorkerResponse)
          }
        )

        self.postMessage({
          type: 'bulkComplete',
          payload: { logs, tickCount: bulkEngine.getTickIndex() },
        } satisfies WorkerResponse)
        break
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', payload: { message: String(err) } } satisfies WorkerResponse)
  }
}
