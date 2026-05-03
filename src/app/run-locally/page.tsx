import type { Metadata } from 'next'
import { loadScenarioIndex } from './scenarios'
import RunLocallyClient from './RunLocallyClient'

export const metadata: Metadata = {
  title: 'Run LogSim locally — install the CLI and replay any scenario',
  description:
    'Install the logsim CLI, then replay any built-in scenario by URL. Stream JSON, OCSF, or OTEL logs straight to stdout, a file, or your SIEM.',
}

export default async function RunLocallyPage() {
  const index = await loadScenarioIndex()
  return <RunLocallyClient index={index} />
}
