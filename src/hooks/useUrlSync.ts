'use client'
import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useUIStore } from '@/store/useUIStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'

/**
 * Two-way syncs a tiny slice of app state with the URL search params so any
 * URL captures the current view exactly:
 *   ?mode=design|episodes
 *   ?ep=<episodeId>         (matched against the currently-loaded episode)
 *   ?seg=<segmentId>
 *
 * Designed to be tolerant: unknown ids are ignored, and writes use replaceState
 * so they don't pollute browser history.
 */
export function useUrlSync() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const mode = useUIStore(s => s.mode)
  const setMode = useUIStore(s => s.setMode)
  const episode = useEpisodeStore(s => s.episode)
  const selectedSegmentId = useEpisodeStore(s => s.selectedSegmentId)
  const selectSegment = useEpisodeStore(s => s.selectSegment)

  const appliedRef = useRef(false)

  // URL -> state (once on mount, then whenever user navigates)
  useEffect(() => {
    const urlMode = searchParams.get('mode')
    const urlEp = searchParams.get('ep')
    const urlSeg = searchParams.get('seg')

    if (urlMode === 'design' || urlMode === 'episodes') {
      if (urlMode !== mode) setMode(urlMode)
    }

    if (urlSeg && (!urlEp || urlEp === episode.id)) {
      const exists = episode.segments.some(s => s.id === urlSeg)
      if (exists && urlSeg !== selectedSegmentId) selectSegment(urlSeg)
    }

    appliedRef.current = true
    // Intentionally one-way on changes to the URL itself; state->URL effect below
    // handles the forward direction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // state -> URL (deferred so URL->state on mount settles first)
  useEffect(() => {
    if (!appliedRef.current) return
    const t = setTimeout(() => {
      const params = new URLSearchParams(window.location.search)

      if (mode === 'design') params.set('mode', 'design')
      else params.set('mode', 'episodes')

      if (episode.id) params.set('ep', episode.id)
      else params.delete('ep')

      if (selectedSegmentId) params.set('seg', selectedSegmentId)
      else params.delete('seg')

      const nextSearch = params.toString()
      if (nextSearch !== window.location.search.replace(/^\?/, '')) {
        router.replace(`${pathname}?${nextSearch}`, { scroll: false })
      }
    }, 0)
    return () => clearTimeout(t)
  }, [mode, episode.id, selectedSegmentId, pathname, router])
}
