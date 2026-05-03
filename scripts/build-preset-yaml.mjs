#!/usr/bin/env node
// Convert each `public/scenarios/presets/<slug>.scenario.json` into a runnable
// engine YAML at `public/scenarios/yaml/<slug>.scenario.yaml`. The CLI can
// fetch these directly via `logsim run https://logsim.app/scenarios/yaml/<slug>.scenario.yaml`.
//
// The presets follow the AI-emitted "proposed scenario" shape: nodes
// (vpc/subnet/service), edges, and an optional timeline with per-lane behavior
// blocks. The engine YAML expects a different shape: nodes (vpc/subnet/
// virtual_server), services with explicit hosts, connections, and per-service
// timelines. This script bridges the two.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const presetsDir = resolve(root, 'public/scenarios/presets')
const outDir = resolve(root, 'public/scenarios/yaml')
mkdirSync(outDir, { recursive: true })

// ── Defaults per service type ────────────────────────────────────────────────
//
// Mirror the registry-side values in src/registry/nodeRegistry.ts so that
// presets converted offline match what the editor would have produced for the
// same canvas. Only the engine-relevant fields are emitted.

const SERVICE_DEFAULTS = {
  nodejs:   { port: 3000, log_format: 'json', log_level: 'info', traffic_rate: 10 },
  golang:   { port: 8080, log_format: 'json', log_level: 'info', traffic_rate: 10 },
  postgres: { port: 5432, slow_query_threshold: 1000, traffic_rate: 20 },
  mysql:    { port: 3306, slow_query_threshold: 1000, traffic_rate: 20 },
  redis:    { port: 6379, max_memory: '256mb', eviction_policy: 'allkeys-lru', traffic_rate: 100 },
  nginx:    { port: 80, log_format: 'combined', traffic_rate: 50 },
  custom:   { port: 8080, traffic_rate: 5 },
}

const DEFAULT_ENDPOINTS = {
  nodejs: [
    { method: 'GET', path: '/api/health', avg_latency_ms: 20, error_rate: 0.001 },
    { method: 'GET', path: '/api/users', avg_latency_ms: 100, error_rate: 0.01 },
    { method: 'POST', path: '/api/users', avg_latency_ms: 220, error_rate: 0.01 },
  ],
  golang: [
    { method: 'GET', path: '/healthz', avg_latency_ms: 8, error_rate: 0.001 },
    { method: 'GET', path: '/api/v1/items', avg_latency_ms: 80, error_rate: 0.005 },
  ],
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function dedupeName(used, base) {
  let candidate = base || 'item'
  let i = 2
  while (used.has(candidate)) {
    candidate = `${base}-${i++}`
  }
  used.add(candidate)
  return candidate
}

function ancestorOfType(node, byId, target) {
  let current = node
  while (current?.parent) {
    const parent = byId.get(current.parent)
    if (!parent) return undefined
    if (parent.type === target) return parent
    current = parent
  }
  return undefined
}

// Synthesize a single-template custom_type for a service whose serviceType is
// "custom". The presets don't carry template definitions, so we generate one
// generic INFO line that prints the service name. The engine validator
// requires at least one template per custom_type.
function customTypeFor(serviceLabel) {
  const id = `${slugify(serviceLabel) || 'custom'}-events`
  return {
    id,
    name: serviceLabel,
    description: `Generic event log for ${serviceLabel}`,
    default_port: 8080,
    default_rate: 5,
    placeholders: {
      timestamp: { kind: 'iso_timestamp' },
      level: { kind: 'level' },
      message: {
        kind: 'enum',
        enum_values: [
          `${serviceLabel} request received`,
          `${serviceLabel} processed event`,
          `${serviceLabel} returned response`,
        ],
      },
    },
    templates: [
      {
        id: 'info',
        template: `{{timestamp}} ${serviceLabel} [{{level}}] {{message}}`,
        weight: 0.95,
        level: 'info',
      },
      {
        id: 'error',
        template: `{{timestamp}} ${serviceLabel} [ERROR] request failed unexpectedly`,
        weight: 0.05,
        level: 'error',
        is_error: true,
      },
    ],
  }
}

// ── Conversion ───────────────────────────────────────────────────────────────

function convertPreset(preset, sourceFile) {
  const allNodes = Array.isArray(preset.nodes) ? preset.nodes : []
  const allEdges = Array.isArray(preset.edges) ? preset.edges : []
  const byId = new Map(allNodes.map(n => [n.id, n]))

  // Stable canonical names — node label or id. Names must be unique across
  // every node + service in the scenario for the engine validator.
  const usedNames = new Set()
  const canonicalName = new Map() // node id → unique name

  for (const n of allNodes) {
    const base = slugify(n.label || n.id) || n.id
    canonicalName.set(n.id, dedupeName(usedNames, base))
  }

  const yamlNodes = []
  const yamlServices = []
  const yamlConnections = []
  const customTypes = new Map()

  // 1) infra nodes (vpc, subnet) come first.
  for (const node of allNodes) {
    const name = canonicalName.get(node.id)
    if (node.type === 'vpc') {
      yamlNodes.push({
        type: 'vpc',
        name,
        provider: 'aws',
        region: 'us-east-1',
        cidr_block: '10.0.0.0/16',
      })
    } else if (node.type === 'subnet') {
      yamlNodes.push({
        type: 'subnet',
        name,
        cidr_block: '10.0.1.0/24',
      })
    }
  }

  // 2) Synthesize a virtual_server host for each service. The proposed schema
  //    drops services straight onto subnets — the engine YAML requires a
  //    virtual_server host between them.
  const synthesizedHostByServiceId = new Map()
  for (const node of allNodes) {
    if (node.type !== 'service') continue
    const subnet = ancestorOfType(node, byId, 'subnet')
    const serviceName = canonicalName.get(node.id)
    const baseHost = `${slugify(serviceName)}-host`
    const hostName = dedupeName(usedNames, baseHost)
    yamlNodes.push({
      type: 'virtual_server',
      name: hostName,
      instance_type: 't3.medium',
      os: 'ubuntu-22.04',
      ...(subnet ? { subnet: canonicalName.get(subnet.id) } : {}),
    })
    synthesizedHostByServiceId.set(node.id, hostName)
  }

  // 3) Services. Generator config blends preset's edge-level rates with the
  //    per-service-type defaults.
  const incomingByTarget = new Map()
  for (const e of allEdges) {
    if (!incomingByTarget.has(e.target)) incomingByTarget.set(e.target, [])
    incomingByTarget.get(e.target).push(e)
  }

  for (const node of allNodes) {
    if (node.type !== 'service') continue
    const serviceType = (node.serviceType ?? 'custom')
    const defaults = SERVICE_DEFAULTS[serviceType] ?? SERVICE_DEFAULTS.custom

    const serviceName = canonicalName.get(node.id)
    const hostName = synthesizedHostByServiceId.get(node.id)

    // Sum of incoming traffic gives a more lifelike traffic_rate than the
    // per-service-type default, especially for backends fronted by an LB.
    const incoming = incomingByTarget.get(node.id) ?? []
    const summedTraffic = incoming.reduce((acc, e) => acc + (Number(e.trafficRate) || 0), 0)

    const generator = {
      type: serviceType,
      ...defaults,
      ...(summedTraffic > 0 ? { traffic_rate: summedTraffic } : {}),
    }

    if (incoming.length > 0) {
      const errSum = incoming.reduce((acc, e) => acc + (Number(e.errorRate) || 0), 0)
      const errAvg = errSum / incoming.length
      if (errAvg > 0) generator.error_rate = +errAvg.toFixed(4)
    }

    if (serviceType === 'nodejs' || serviceType === 'golang') {
      generator.endpoints = DEFAULT_ENDPOINTS[serviceType]
    }

    if (serviceType === 'custom') {
      const ct = customTypeFor(node.label || serviceName)
      customTypes.set(ct.id, ct)
      generator.custom_type = ct.id
    }

    const svcEntry = {
      type: serviceType,
      name: serviceName,
      ...(node.notes ? { description: String(node.notes) } : {}),
      host: hostName,
      generator,
    }

    // Attach per-service timeline if this lane appears in the preset timeline.
    const lanes = preset.timeline?.lanes ?? {}
    const blocks = lanes[node.id]
    if (Array.isArray(blocks) && blocks.length > 0) {
      svcEntry.timeline = blocks
        .filter(b => Number(b.duration) > 0)
        .map(b => {
          const out = {
            from: Number(b.start) || 0,
            to: (Number(b.start) || 0) + (Number(b.duration) || 0),
          }
          if (b.state) out.state = b.state
          if (typeof b.errorRate === 'number') out.error_rate = b.errorRate
          if (typeof b.latencyMul === 'number') out.latency_mul = b.latencyMul
          if (typeof b.logVolMul === 'number') out.log_vol_mul = b.logVolMul
          if (b.note) out.note = String(b.note)
          if (b.customLog) out.custom_log = String(b.customLog)
          return out
        })
    }

    yamlServices.push(svcEntry)
  }

  // 4) Connections. Drop edges whose endpoints are unknown after canonicalisation.
  for (const edge of allEdges) {
    const source = canonicalName.get(edge.source)
    const target = canonicalName.get(edge.target)
    if (!source || !target) continue
    yamlConnections.push({
      source,
      target,
      protocol: edge.protocol || 'tcp',
      port: Number(edge.port) || 80,
    })
  }

  // 5) Stitch the top-level scenario document.
  const scenario = {
    name: preset.name || basename(sourceFile, '.scenario.json'),
    ...(preset.description ? { description: preset.description } : {}),
    ...(preset.timeline?.duration ? { duration: preset.timeline.duration } : {}),
    tick_interval_ms: 1000,
    nodes: yamlNodes,
    services: yamlServices,
    connections: yamlConnections,
    ...(customTypes.size > 0 ? { custom_types: [...customTypes.values()] } : {}),
  }

  return scenario
}

// ── Build all presets ────────────────────────────────────────────────────────

const indexPath = resolve(presetsDir, 'index.json')
const presetIndex = JSON.parse(readFileSync(indexPath, 'utf8'))

const manifest = []
const errors = []

for (const entry of presetIndex.scenarios) {
  const sourcePath = resolve(presetsDir, entry.file)
  let preset
  try {
    preset = JSON.parse(readFileSync(sourcePath, 'utf8'))
  } catch (err) {
    errors.push({ file: entry.file, err: `read preset: ${err.message}` })
    continue
  }

  const slug = entry.file.replace(/\.scenario\.json$/i, '')
  const yamlFile = `${slug}.scenario.yaml`
  const outPath = resolve(outDir, yamlFile)

  try {
    const scenario = convertPreset(preset, entry.file)
    const text = yaml.dump(scenario, { lineWidth: 120, noRefs: true })
    writeFileSync(outPath, text, 'utf8')
    manifest.push({
      file: yamlFile,
      slug,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      difficulty: entry.difficulty,
      durationTicks: entry.durationTicks,
      serviceCount: entry.serviceCount,
      bytes: text.length,
    })
    console.log(`wrote ${yamlFile} (${text.length} bytes)`)
  } catch (err) {
    errors.push({ file: entry.file, err: err.stack || err.message })
  }
}

const outIndex = {
  groups: presetIndex.groups,
  scenarios: manifest,
  generatedAt: new Date().toISOString(),
}
writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(outIndex, null, 2))
console.log(`wrote index.json (${manifest.length} scenarios)`)

if (errors.length > 0) {
  console.error(`\n${errors.length} preset(s) failed to convert:`)
  for (const e of errors) console.error(`  - ${e.file}: ${e.err}`)
  process.exit(1)
}
