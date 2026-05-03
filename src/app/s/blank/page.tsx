import { Suspense } from 'react'
import type { Metadata } from 'next'
import EditorPageClient from '@/app/editor/EditorPageClient'

export const metadata: Metadata = {
  title: 'Blank canvas — LogSim',
  description:
    'Start a fresh LogSim scenario, or pick up where you left off in your browser library.',
}

// Acts as the editor home under the /s/ namespace. Unknown /s/<slug> URLs
// redirect here so a typo lands the user on a usable canvas instead of a
// dead end. Renders the same editor as /editor; the bootstrap effect will
// restore the user's last library entry or drop them into the intro template.
export default function BlankCanvasPage() {
  return (
    <Suspense fallback={<div className="h-screen w-screen bg-white" />}>
      <EditorPageClient />
    </Suspense>
  )
}
