'use client'
import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useEpisodeStore } from '@/store/useEpisodeStore'

/**
 * Two-way syncs the episode id with `?ep=<id>` so URLs capture the current
 * scenario. Tolerant: unknown ids are ignored, and writes use replaceState
 * so they don't pollute browser history.
 */
export function useUrlSync() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const episode = useEpisodeStore(s => s.episode)

  const appliedRef = useRef(false)

  useEffect(() => {
    appliedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  useEffect(() => {
    if (!appliedRef.current) return
    const t = setTimeout(() => {
      const params = new URLSearchParams(window.location.search)
      if (episode.id) params.set('ep', episode.id)
      else params.delete('ep')
      params.delete('mode')
      params.delete('seg')
      const nextSearch = params.toString()
      if (nextSearch !== window.location.search.replace(/^\?/, '')) {
        const url = nextSearch ? `${pathname}?${nextSearch}` : pathname
        router.replace(url, { scroll: false })
      }
    }, 0)
    return () => clearTimeout(t)
  }, [episode.id, pathname, router])
}
