import type { Episode } from '@/types/episode'
import type { LogEntry } from '@/types/logs'
import { generate, pickCriblPayload } from '@/lib/backendClient'
import type { DestinationConfig } from '@/types/destinations'

const TICK_INTERVAL_MS = 1000
const WINDOW_TICKS = 10 // ticks per backend call

export interface EpisodeRunCallbacks {
  onSegmentStart: (segmentId: string) => void
  onProgress: (segmentId: string, ticksInSegment: number) => void
  onLogs: (logs: LogEntry[]) => void
  onForwarded: (count: number, error?: string) => void
  onSegmentEnd: (segmentId: string) => void
  onDone: () => void
  onError: (err: Error) => void
  shouldStop: () => boolean
  getDestinations: () => DestinationConfig[]
}

export async function runEpisode(episode: Episode, cbs: EpisodeRunCallbacks, initialStartMs?: number): Promise<void> {
  let cursorMs = initialStartMs ?? Date.now()
  let seed = Math.floor(Math.random() * 1e9)

  for (const segment of episode.segments) {
    if (cbs.shouldStop()) break
    cbs.onSegmentStart(segment.id)

    let remaining = segment.ticks
    let done = 0

    while (remaining > 0) {
      if (cbs.shouldStop()) break
      const batch = Math.min(WINDOW_TICKS, remaining)
      const cribl = pickCriblPayload(cbs.getDestinations())

      try {
        const { logs, forwarded, forwardError } = await generate({
          scenarioYaml: segment.scenarioYaml,
          ticks: batch,
          tickIntervalMs: TICK_INTERVAL_MS,
          startTimeMs: cursorMs,
          seed: seed++,
          cribl,
        })
        cbs.onLogs(logs)
        if (cribl) cbs.onForwarded(forwarded, forwardError)
      } catch (err) {
        cbs.onError(err instanceof Error ? err : new Error(String(err)))
        return
      }

      cursorMs += batch * TICK_INTERVAL_MS
      remaining -= batch
      done += batch
      cbs.onProgress(segment.id, done)
    }

    cbs.onSegmentEnd(segment.id)
  }

  cbs.onDone()
}
