#!/usr/bin/env node
// Builds example episode files from scenarios/web-service.yaml.
// Each episode has segments that apply text-level mutations to the base YAML
// to represent realistic incident timelines (baseline → incident → recovery).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const baseYaml = readFileSync(resolve(root, 'scenarios/web-service.yaml'), 'utf8')
const outDir = resolve(root, 'public/examples/episodes')
mkdirSync(outDir, { recursive: true })

const uid = () => randomUUID()

// --- Mutation helpers (string-level so we don't need a yaml lib) ------------

/** Replace the first occurrence of `from` with `to` (anchored by prefix). */
function replaceOnce(text, from, to) {
  const idx = text.indexOf(from)
  if (idx === -1) throw new Error(`pattern not found: ${from}`)
  return text.slice(0, idx) + to + text.slice(idx + from.length)
}

/** Replace every occurrence. */
function replaceAll(text, from, to) {
  return text.split(from).join(to)
}

// Mutations that produce different scenario variants:

function variantDbSlow(yaml) {
  // POST /api/users gets dramatically slower + more errors; MySQL slow-query
  // threshold drops so slow-query logs start firing.
  let y = yaml
  // Bump POST avg_latency_ms 500 → 3000
  y = replaceOnce(y,
    '          avg_latency_ms: 500\n          error_rate: 0.01',
    '          avg_latency_ms: 3000\n          error_rate: 0.15')
  // Lower MySQL slow-query threshold so writes fire slow-query logs
  y = replaceOnce(y, 'slow_query_threshold: 1000', 'slow_query_threshold: 100')
  return y
}

function variantApiErrorBurst(yaml) {
  // GET /api/users error_rate 0.01 → 0.4; latency unchanged.
  return replaceOnce(yaml,
    '          avg_latency_ms: 100\n          error_rate: 0.01',
    '          avg_latency_ms: 100\n          error_rate: 0.4')
}

function variantTrafficSpike(yaml) {
  // Every user_client rps gets multiplied; pattern becomes bursty.
  let y = yaml
  y = replaceOnce(y, 'rps: 1\n        traffic_pattern: steady mix of GET and POST requests',
                     'rps: 20\n        traffic_pattern: bursty traffic with bursts of GET and POST requests')
  y = replaceOnce(y, 'rps: 10\n        traffic_pattern: only GET requests',
                     'rps: 80\n        traffic_pattern: bursty only GET requests')
  y = replaceOnce(y, 'rps: 0.1\n        traffic_pattern: only POST requests',
                     'rps: 5\n        traffic_pattern: bursty only POST requests')
  return y
}

function variantPartialOutage(yaml) {
  // App Server 1's nodejs service errors heavily (simulating a bad deploy)
  // while the rest of the stack is fine.
  return replaceOnce(yaml,
    '          avg_latency_ms: 100\n          error_rate: 0.01',
    '          avg_latency_ms: 250\n          error_rate: 0.7')
}

// --- Episode definitions ----------------------------------------------------

function makeSegment(name, ticks, yamlBody, parentId) {
  return { id: uid(), name, ticks, scenarioYaml: yamlBody, ...(parentId ? { parentId } : {}) }
}

function episode({ name, description, segments }) {
  const now = new Date().toISOString()
  return {
    version: 1,
    episode: {
      id: uid(),
      name,
      description,
      createdAt: now,
      updatedAt: now,
      segments,
    },
  }
}

const episodes = [
  {
    file: 'db-slowdown-incident.episode.json',
    title: 'Database Slowdown Incident',
    description:
      'Five minutes of healthy traffic, then the app database begins returning slow queries and the POST /api/users endpoint degrades with 15% error rate. After five minutes of degraded service the issue is mitigated.',
    build: () => {
      const baseline = makeSegment('Baseline — healthy', 300, baseYaml)
      const incident = makeSegment('DB slowdown (latency + errors)', 300,
        variantDbSlow(baseYaml), baseline.id)
      const recovery = makeSegment('Mitigation — back to baseline', 180,
        baseYaml, incident.id)
      return { segments: [baseline, incident, recovery] }
    },
  },
  {
    file: 'api-error-burst.episode.json',
    title: 'API Error Burst',
    description:
      'Baseline traffic for five minutes, then GET /api/users starts returning ~40% errors (e.g. a bad release on the read path) for three minutes, then recovers.',
    build: () => {
      const baseline = makeSegment('Baseline — healthy', 300, baseYaml)
      const burst = makeSegment('Error burst on /api/users GET', 180,
        variantApiErrorBurst(baseYaml), baseline.id)
      const recovery = makeSegment('Fix deployed — errors drop', 120,
        baseYaml, burst.id)
      return { segments: [baseline, burst, recovery] }
    },
  },
  {
    file: 'traffic-spike-and-bad-deploy.episode.json',
    title: 'Traffic Spike Into Bad Deploy',
    description:
      'Baseline is fine. A marketing push drives a 20x traffic spike. Under load a bad deploy surfaces on App Server 1 and errors jump to 70%. After rollback the system stabilises at the higher traffic level.',
    build: () => {
      const baseline = makeSegment('Baseline — healthy', 240, baseYaml)
      const spike = makeSegment('Traffic spike (bursty)', 240,
        variantTrafficSpike(baseYaml), baseline.id)
      const badDeploy = makeSegment('Bad deploy — 70% errors', 180,
        variantPartialOutage(variantTrafficSpike(baseYaml)), spike.id)
      const rollback = makeSegment('Rollback — stable at high load', 240,
        variantTrafficSpike(baseYaml), badDeploy.id)
      return { segments: [baseline, spike, badDeploy, rollback] }
    },
  },
]

// --- Write files ------------------------------------------------------------

const manifest = []
for (const ep of episodes) {
  const { segments } = ep.build()
  const totalTicks = segments.reduce((a, s) => a + s.ticks, 0)
  const payload = episode({ name: ep.title, description: ep.description, segments })
  writeFileSync(resolve(outDir, ep.file), JSON.stringify(payload, null, 2))
  manifest.push({
    file: ep.file,
    title: ep.title,
    description: ep.description,
    segmentCount: segments.length,
    totalTicks,
  })
  console.log(`wrote ${ep.file} (${segments.length} segments, ${totalTicks} ticks)`)
}

writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(manifest, null, 2))
console.log(`wrote index.json (${manifest.length} episodes)`)
