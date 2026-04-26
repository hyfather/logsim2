import type { Episode, EpisodeFileV2 } from '@/types/episode'

/**
 * Accepts either a v2 wrapped file or a bare Episode object. Rejects v1
 * (segment-based) files with a clear error so users know the format changed.
 */
export function parseEpisodeFile(data: unknown): Episode {
  if (!data || typeof data !== 'object') throw new Error('Invalid episode file')
  const obj = data as Record<string, unknown>

  const candidate = ('episode' in obj && obj.episode && typeof obj.episode === 'object'
    ? obj.episode
    : obj) as Record<string, unknown>

  // v1 had `segments`; v2 has `lanes`. Reject v1 outright.
  if (Array.isArray((candidate as Record<string, unknown>).segments) && !('lanes' in candidate)) {
    throw new Error('This episode was saved in the legacy segment format. Re-create it in the new timeline.')
  }
  if (typeof candidate.id !== 'string' || typeof candidate.duration !== 'number' || typeof candidate.lanes !== 'object') {
    throw new Error('Invalid episode file')
  }
  return candidate as unknown as Episode
}

export function serializeEpisode(episode: Episode): EpisodeFileV2 {
  return { version: 2, episode }
}
