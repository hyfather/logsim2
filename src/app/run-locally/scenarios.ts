import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface ScenarioGroup {
  id: string
  label: string
  description: string
  order: number
}

export interface ScenarioEntry {
  file: string
  slug: string
  title: string
  description: string
  category: string
  difficulty?: string
  durationTicks?: number
  serviceCount?: number
  bytes?: number
}

export interface ScenarioIndex {
  groups: ScenarioGroup[]
  scenarios: ScenarioEntry[]
  generatedAt?: string
}

const INDEX_PATH = path.join(process.cwd(), 'public', 's', 'index.json')

let cached: ScenarioIndex | null = null

export async function loadScenarioIndex(): Promise<ScenarioIndex> {
  if (cached) return cached
  const raw = await fs.readFile(INDEX_PATH, 'utf8')
  const parsed = JSON.parse(raw) as ScenarioIndex
  parsed.scenarios = [...parsed.scenarios].sort((a, b) => a.title.localeCompare(b.title))
  parsed.groups = [...parsed.groups].sort((a, b) => a.order - b.order)
  cached = parsed
  return parsed
}
