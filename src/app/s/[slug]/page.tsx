import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { loadScenarioIndex } from '@/app/run-locally/scenarios'
import EditorPageClient from '@/app/editor/EditorPageClient'

interface PageProps {
  params: { slug: string }
}

// Pre-render every known slug. Anything else 404s rather than silently opening
// an empty editor — keeps `/s/<slug>` honest as a "this is a real scenario"
// signal for both browsers and crawlers.
export async function generateStaticParams() {
  const index = await loadScenarioIndex()
  return index.scenarios.map(s => ({ slug: s.slug }))
}

export const dynamicParams = false

export async function generateMetadata({ params }: PageProps) {
  const index = await loadScenarioIndex()
  const scenario = index.scenarios.find(s => s.slug === params.slug)
  if (!scenario) return { title: 'Scenario not found' }
  return {
    title: `${scenario.title} — LogSim`,
    description: scenario.description,
  }
}

export default async function ScenarioPage({ params }: PageProps) {
  const index = await loadScenarioIndex()
  const scenario = index.scenarios.find(s => s.slug === params.slug)
  if (!scenario) notFound()
  // Renders the canvas at /s/<slug>. EditorPageClient sees the slug, loads
  // the matching preset, then navigates to /editor so subsequent edits happen
  // on the canonical URL. Suspense wraps useSearchParams the same way the
  // /editor route does — required for SSG.
  return (
    <Suspense fallback={<div className="h-screen w-screen bg-white" />}>
      <EditorPageClient initialScenarioSlug={params.slug} />
    </Suspense>
  )
}
