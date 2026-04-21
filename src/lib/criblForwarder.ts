import type { LogEntry } from '@/types/logs'
import type { CriblHecDestination } from '@/types/destinations'

/** Server-side proxy — avoids browser CORS restrictions. */
const PROXY = '/api/cribl'

interface HecEvent {
  time: number
  host: string
  source: string
  sourcetype: string
  event: {
    id: string
    ts: string
    channel: string
    level: string
    source: string
    raw: string
  }
}

function toHecEvent(entry: LogEntry, dest: CriblHecDestination): HecEvent {
  return {
    time: new Date(entry.ts).getTime() / 1000,
    host: entry.channel,
    // Empty source override → use the log's channel path per-event
    source: dest.source || entry.channel,
    sourcetype: dest.sourcetype || 'logsim:json',
    event: {
      id: entry.id,
      ts: entry.ts,
      channel: entry.channel,
      level: entry.level,
      source: entry.source,
      raw: entry.raw,
    },
  }
}

async function postViaProxy(batch: string, dest: CriblHecDestination): Promise<void> {
  const res = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch, url: dest.url, token: dest.token }),
  })

  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    const detail = (json as { body?: string; error?: string }).body
      || (json as { body?: string; error?: string }).error
      || `HTTP ${res.status}`
    throw new Error(`Cribl HEC error: ${detail}`)
  }
}

/**
 * Forward log entries to a Cribl Stream HEC destination via the server-side proxy.
 * Splits into batches of dest.batchSize and awaits each in sequence.
 * Throws on network or upstream error.
 */
export async function forwardToHec(logs: LogEntry[], dest: CriblHecDestination): Promise<void> {
  if (!dest.enabled || !dest.url || !dest.token || logs.length === 0) return

  const batchSize = Math.max(1, dest.batchSize || 100)

  for (let i = 0; i < logs.length; i += batchSize) {
    const slice = logs.slice(i, i + batchSize)
    const body = slice.map(e => JSON.stringify(toHecEvent(e, dest))).join('\n')
    await postViaProxy(body, dest)
  }
}

/**
 * Send a single synthetic test event to verify connectivity and auth.
 */
export async function testHecConnection(dest: CriblHecDestination): Promise<void> {
  const testEvent = JSON.stringify({
    time: Date.now() / 1000,
    host: 'logsim-test',
    source: dest.source || 'logsim-test',
    sourcetype: dest.sourcetype || 'logsim:json',
    event: { message: 'LogSim connectivity test', level: 'INFO' },
  })
  await postViaProxy(testEvent, dest)
}
