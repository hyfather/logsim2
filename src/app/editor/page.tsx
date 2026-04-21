import { Suspense } from 'react'
import EditorPageClient from './EditorPageClient'

function EditorPageFallback() {
  return <div className="h-screen w-screen bg-white" />
}

export default function EditorPage() {
  return (
    <Suspense fallback={<EditorPageFallback />}>
      <EditorPageClient />
    </Suspense>
  )
}
