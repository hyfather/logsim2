import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { loadScenarioIndex } from '@/app/run-locally/scenarios'
import EditorPageClient from '@/app/editor/EditorPageClient'

interface PageProps {
  params: { slug: string }
}

// Pre-render every known slug. Unknown slugs fall through to the dynamic
// handler below — see `dynamicParams = true`.
export async function generateStaticParams() {
  const index = await loadScenarioIndex()
  return index.scenarios.map(s => ({ slug: s.slug }))
}

// Allow unknown /s/<slug> requests to reach this handler so we can redirect
// them to /s/blank instead of returning Next's default 404 page. Static files
// in public/s/ (the .yaml exports) still take precedence and are served by
// the file system handler before any route matching happens.
export const dynamicParams = true

// Disable Next's response cache for this route. A cached 307 redirect
// silently drops its Location header on a HIT, which would leave non-browser
// clients (curl, crawlers, the link unfurlers) stuck on the redirect status
// with no destination. Known slugs are still served from generateStaticParams
// HTML; only the unknown-slug redirect path is dynamic.
export const revalidate = 0

export async function generateMetadata({ params }: PageProps) {
  const index = await loadScenarioIndex()
  const scenario = index.scenarios.find(s => s.slug === params.slug)
  if (!scenario) return { title: 'Scenario not found — LogSim' }
  return {
    title: `${scenario.title} — LogSim`,
    description: scenario.description,
  }
}

export default async function ScenarioPage({ params }: PageProps) {
  // `/s/<unknown>.yaml` should 404 — the user (or their CLI) was reaching for
  // a file that doesn't exist, not the editor. Static files in public/s/
  // already take precedence for known YAMLs, so reaching this handler with a
  // .yaml suffix means the file isn't on disk.
  if (params.slug.endsWith('.yaml')) notFound()

  const index = await loadScenarioIndex()
  const scenario = index.scenarios.find(s => s.slug === params.slug)
  // Browser UX: a typo or stale link lands on a usable empty canvas instead
  // of a dead end. Dynamic rendering means this redirect ships a proper 307
  // with a Location header (unlike SSG redirects, which bake into HTML only).
  if (!scenario) redirect('/s/blank')

  return (
    <Suspense fallback={<div className="h-screen w-screen bg-white" />}>
      <EditorPageClient initialScenarioSlug={params.slug} />
    </Suspense>
  )
}
