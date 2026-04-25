'use client'
import type { AIProviderConfig } from '@/types/aiKeys'
import type { CustomNodeType, CustomLogTemplate, PlaceholderSpec, PlaceholderKind } from '@/types/customNodeType'
import type { LogLevel } from '@/types/logs'
import { complete } from '@/lib/aiClient'
import { generateId } from '@/lib/id'

const VALID_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']

const VALID_KINDS = new Set<PlaceholderKind>([
  'timestamp', 'iso_timestamp', 'epoch_seconds', 'epoch_millis',
  'level', 'ip', 'ipv6', 'host', 'port',
  'method', 'path', 'status',
  'latency_ms', 'duration_ms', 'bytes',
  'request_id', 'trace_id', 'uuid',
  'user_id', 'session_id', 'email',
  'pid', 'thread',
  'integer', 'float', 'hex', 'word',
  'enum', 'free_text', 'literal', 'user_agent',
])

const VALID_FORMATS = new Set(['json', 'logfmt', 'apache', 'syslog', 'plain', 'mixed', 'custom'])

const SYSTEM_PROMPT = `You analyse sample log lines from a single source and produce a generation spec the LogSim simulator uses to emit synthetic-but-realistic logs that match the same shape.

Output ONE JSON object — no prose, no markdown fences, no commentary.

═══════════════════════════════════════════════════════════════════════════
GOAL
═══════════════════════════════════════════════════════════════════════════

Read the user's pasted samples. Identify:
  • the system the logs come from (Apache, Nginx, Kafka, Postgres, syslog, custom JSON, etc.)
  • the format (JSON line, logfmt key=value, Apache combined, RFC3164/5424 syslog, plain text)
  • which fields are timestamps, severity, identifiers (request/trace IDs), network info, status codes, latencies, byte counts, error markers, etc.

Produce a generation spec: a small set of TEMPLATES with \`{{placeholder}}\` markers and a PLACEHOLDER DICTIONARY. Generated logs will look like the originals but vary realistically.

═══════════════════════════════════════════════════════════════════════════
RESPONSE SCHEMA
═══════════════════════════════════════════════════════════════════════════

{
  "name": "kebab-case identifier ≤32 chars (e.g. 'apache-access', 'kafka-broker', 'payment-svc')",
  "icon": "single emoji that fits the system",
  "description": "≤120 chars: what these logs are from and what they show",
  "inferredKind": "free-form e.g. 'Apache HTTP combined access log', 'Kubernetes kubelet syslog', 'Custom JSON payment service'",
  "detectedFormat": "json | logfmt | apache | syslog | plain | mixed | custom",
  "defaultPort": <int or null>,
  "defaultRate": <number 1..1000>,           // events/sec a typical instance produces
  "defaultErrorRate": <0..1>,                 // fraction of error/warn events
  "placeholders": {
    "<placeholder_name>": {
      "kind": "<one of the placeholder kinds below>",
      "enumValues": [...],     // for kind=enum / free_text — pool of candidate values
      "literal":   "...",       // for kind=literal — fixed string to emit
      "min": <num>, "max": <num>,  // numeric kinds
      "format": "...",          // timestamp formats: 'iso' | 'rfc3164' | 'apache' | 'epoch_s' | 'epoch_ms'
      "length": <num>,          // hex/word
      "description": "what this field is"
    },
    ...
  },
  "templates": [
    {
      "template": "the full log line with {{placeholder}} markers — preserve exact punctuation, quotes, brackets, spacing of the originals",
      "weight":  <int 1..100>,
      "level":   "DEBUG | INFO | WARN | ERROR | FATAL",
      "isError": <boolean>
    },
    ...
  ]
}

═══════════════════════════════════════════════════════════════════════════
PLACEHOLDER KINDS — pick exactly one per placeholder
═══════════════════════════════════════════════════════════════════════════

  timestamp        Current event time, formatted per \`format\` (default 'iso')
  iso_timestamp    Explicit ISO 8601 / RFC3339
  epoch_seconds    Unix seconds
  epoch_millis     Unix milliseconds
  level            Severity word matching the template's \`level\`. Use \`enumValues\` for casing
                   (e.g. ["debug","info","warn","error"] or ["INFO","WARN","ERROR"])
  ip               Random IPv4
  ipv6             Random IPv6
  host             Hostname / FQDN
  port             TCP/UDP port (defaults to the node's port)
  method           HTTP method
  path             URL path. Set \`enumValues\` to anchor on the application's real paths visible in samples
  status           HTTP status code; the generator picks 2xx/3xx for non-error, 4xx/5xx for error templates
  latency_ms       Request latency in ms — set min/max (e.g. 1..1500)
  duration_ms      Generic duration in ms
  bytes            Byte count — set min/max
  request_id       Short hex/uuid identifier
  trace_id         32-char hex trace ID
  uuid             UUID v4
  user_id          Integer ID
  session_id       Hex session ID
  email            Fake email
  pid              Process ID
  thread           Thread name/id
  integer          Random int in [min, max]
  float            Random float in [min, max]
  hex              Random hex string of \`length\` chars
  word             Random short word (override with enumValues)
  enum             Pick from \`enumValues\`
  free_text        Pick from \`enumValues\` — use this for varying message strings (queries, error messages, event names)
  literal          Emit \`literal\` verbatim
  user_agent       Random User-Agent

═══════════════════════════════════════════════════════════════════════════
RULES (read carefully — these matter)
═══════════════════════════════════════════════════════════════════════════

1. TEMPLATES MUST PRESERVE FORMAT EXACTLY. JSON in → JSON templates out. Syslog in → keep the RFC3164/5424 prefix. Apache in → keep the field order and quoting. logfmt in → keep \`key=value\` shape and key order.

2. GENERALISE FIELDS, NOT CONTENT. Replace timestamps, IDs, IPs, paths, status codes with placeholders. Do NOT hard-code the example value from one sample.

3. MIX OF NORMAL + ERROR TEMPLATES. Provide 4–10 templates: at least 3 normal (INFO/DEBUG), 1–3 warnings, 1–3 errors. Use foundation knowledge of the source to add realistic error variants the user did NOT paste — e.g. for Postgres samples include "could not connect", slow query warnings, "duplicate key violates unique constraint", "deadlock detected". For Nginx include 502/504 upstream errors. For Kafka include leader election warnings. For Java/JVM add stack-trace-style FATAL lines.

4. REALISTIC ENUM POOLS. For \`enum\` and \`free_text\`, populate \`enumValues\` with 4–10 plausible options drawn from the application domain visible in the samples. If samples show \`/api/checkout\`, include other checkout/cart/user paths the same app would have.

5. WHITESPACE FIDELITY. Preserve tabs, exact spacing, brackets [], quotes "", equals =, dashes — anything that matters for a log parser. JSON output must remain valid JSON when rendered.

6. STATUS CODES. For HTTP-shaped logs use kind=status. The template's \`isError\` flag tells the generator to emit 4xx/5xx; otherwise 2xx/3xx. Don't bake the code into the template.

7. ERROR LEVEL RULES. isError=true ⇒ level WARN/ERROR/FATAL.  isError=false ⇒ level DEBUG/INFO.

8. NUMBER RANGES. Always set realistic min/max for latency_ms (e.g. 1..1500 normal, 100..10000 errors), bytes (10..50000), integer kinds.

9. FREE-TEXT FOR MESSAGE FIELDS. Where a \`msg=\` / \`message\` / \`error\` field varies in content, define a \`free_text\` placeholder and give 4–10 plausible message strings drawn from the system's vocabulary.

10. TIMESTAMP FORMAT. Match the samples exactly. Examples:
    iso       → 2026-04-25T13:22:01.123Z
    rfc3164   → Apr 25 13:22:01
    apache    → 25/Apr/2026:13:22:01 +0000
    epoch_s   → 1745588521
    epoch_ms  → 1745588521123

═══════════════════════════════════════════════════════════════════════════
WORKED EXAMPLE — STUDY THIS
═══════════════════════════════════════════════════════════════════════════

INPUT samples:
192.168.1.10 - - [24/Apr/2026:09:11:34 +0000] "GET /index.html HTTP/1.1" 200 2326 "-" "Mozilla/5.0"
192.168.1.10 - - [24/Apr/2026:09:11:35 +0000] "POST /api/login HTTP/1.1" 401 87 "-" "curl/7.85"

OUTPUT:
{
  "name": "apache-access",
  "icon": "🪶",
  "description": "Apache HTTP combined access log: client IP, method, path, status, byte count, User-Agent.",
  "inferredKind": "Apache combined access log",
  "detectedFormat": "apache",
  "defaultPort": 80,
  "defaultRate": 50,
  "defaultErrorRate": 0.03,
  "placeholders": {
    "client_ip": { "kind": "ip", "description": "client IP address" },
    "ts":        { "kind": "timestamp", "format": "apache" },
    "method":    { "kind": "method" },
    "path":      { "kind": "path", "enumValues": ["/index.html","/api/login","/api/logout","/static/app.js","/favicon.ico","/healthz","/api/orders","/api/users"] },
    "status":    { "kind": "status" },
    "bytes":     { "kind": "bytes", "min": 50, "max": 50000 },
    "ua":        { "kind": "user_agent" }
  },
  "templates": [
    { "template": "{{client_ip}} - - [{{ts}}] \\"{{method}} {{path}} HTTP/1.1\\" {{status}} {{bytes}} \\"-\\" \\"{{ua}}\\"", "weight": 60, "level": "INFO",  "isError": false },
    { "template": "{{client_ip}} - - [{{ts}}] \\"{{method}} {{path}} HTTP/1.1\\" {{status}} {{bytes}} \\"-\\" \\"{{ua}}\\"", "weight": 6,  "level": "WARN",  "isError": true  },
    { "template": "{{client_ip}} - - [{{ts}}] \\"{{method}} {{path}} HTTP/1.1\\" {{status}} {{bytes}} \\"-\\" \\"{{ua}}\\"", "weight": 4,  "level": "ERROR", "isError": true  }
  ]
}

Output the JSON object only.`

function buildUserPrompt(sampleLogs: string, hints?: { name?: string; icon?: string }): string {
  const parts: string[] = []
  parts.push(`Analyse these sample log lines and produce the generation spec per the system schema.`)
  parts.push('')
  parts.push('Samples (verbatim, one entry per line):')
  parts.push('```')
  parts.push(sampleLogs.trim())
  parts.push('```')
  if (hints?.name) parts.push(`User suggested name: ${hints.name}`)
  if (hints?.icon) parts.push(`User suggested icon: ${hints.icon}`)
  parts.push('')
  parts.push('Return the JSON object only.')
  return parts.join('\n')
}

export interface InferCustomTypeOptions {
  signal?: AbortSignal
  hints?: { name?: string; icon?: string }
}

export async function inferCustomNodeType(
  config: AIProviderConfig,
  sampleLogs: string,
  options: InferCustomTypeOptions = {},
): Promise<CustomNodeType> {
  const samples = sampleLogs.trim()
  if (!samples) throw new Error('Paste at least one sample log line.')

  const completion = await complete(config, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(samples, options.hints) },
    ],
    maxTokens: 4096,
    jsonMode: true,
    signal: options.signal,
  })

  return parseAndNormalize(completion.text, samples)
}

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) return fence[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

function parseAndNormalize(rawText: string, samples: string): CustomNodeType {
  if (!rawText?.trim()) throw new Error('AI returned an empty response.')
  let data: unknown
  try {
    data = JSON.parse(extractJsonBlock(rawText))
  } catch (err) {
    throw new Error(`AI response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!data || typeof data !== 'object') throw new Error('AI response was not a JSON object.')
  const obj = data as Record<string, unknown>

  // Placeholders
  const placeholders: Record<string, PlaceholderSpec> = {}
  if (obj.placeholders && typeof obj.placeholders === 'object') {
    for (const [k, vRaw] of Object.entries(obj.placeholders as Record<string, unknown>)) {
      if (!vRaw || typeof vRaw !== 'object') continue
      const v = vRaw as Record<string, unknown>
      const kindRaw = typeof v.kind === 'string' ? (v.kind as PlaceholderKind) : 'literal'
      const kind: PlaceholderKind = VALID_KINDS.has(kindRaw) ? kindRaw : 'literal'
      const spec: PlaceholderSpec = { kind }
      if (Array.isArray(v.enumValues)) spec.enumValues = v.enumValues.map(String).filter(Boolean)
      if (typeof v.literal === 'string') spec.literal = v.literal
      if (typeof v.min === 'number') spec.min = v.min
      if (typeof v.max === 'number') spec.max = v.max
      if (typeof v.format === 'string') spec.format = v.format
      if (typeof v.length === 'number') spec.length = v.length
      if (typeof v.description === 'string') spec.description = v.description
      placeholders[k] = spec
    }
  }

  // Templates
  const templates: CustomLogTemplate[] = []
  if (Array.isArray(obj.templates)) {
    for (const t of obj.templates as unknown[]) {
      if (!t || typeof t !== 'object') continue
      const tt = t as Record<string, unknown>
      const tpl = typeof tt.template === 'string' ? tt.template : ''
      if (!tpl) continue
      const isError = !!tt.isError
      const levelCandidate = typeof tt.level === 'string' ? (tt.level.toUpperCase() as LogLevel) : ''
      const level: LogLevel = VALID_LEVELS.includes(levelCandidate as LogLevel)
        ? (levelCandidate as LogLevel)
        : (isError ? 'ERROR' : 'INFO')
      const weight = typeof tt.weight === 'number' && tt.weight > 0 ? Math.min(100, tt.weight) : 1
      templates.push({ template: tpl, weight, level, isError })
    }
  }
  if (templates.length === 0) throw new Error('AI did not return any usable templates.')

  // Top-level fields
  const detectedFormatRaw = typeof obj.detectedFormat === 'string' ? obj.detectedFormat : 'custom'
  const detectedFormat = (VALID_FORMATS.has(detectedFormatRaw)
    ? detectedFormatRaw
    : 'custom') as CustomNodeType['detectedFormat']

  const name = typeof obj.name === 'string' && obj.name.trim()
    ? obj.name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_.]/g, '').slice(0, 48) || 'custom-type'
    : 'custom-type'

  const icon = typeof obj.icon === 'string' && obj.icon.trim() ? obj.icon.trim().slice(0, 4) : '⚙️'

  const now = new Date().toISOString()
  const result: CustomNodeType = {
    id: generateId(),
    name,
    icon,
    description: typeof obj.description === 'string' ? obj.description.slice(0, 240) : '',
    inferredKind: typeof obj.inferredKind === 'string' ? obj.inferredKind.slice(0, 200) : undefined,
    detectedFormat,
    templates,
    placeholders,
    defaultPort: typeof obj.defaultPort === 'number' && obj.defaultPort >= 1 && obj.defaultPort <= 65535
      ? Math.round(obj.defaultPort)
      : undefined,
    defaultRate: typeof obj.defaultRate === 'number' && obj.defaultRate > 0
      ? Math.min(1000, Math.max(1, obj.defaultRate))
      : 10,
    defaultErrorRate: typeof obj.defaultErrorRate === 'number'
      ? Math.max(0, Math.min(1, obj.defaultErrorRate))
      : 0.02,
    sampleLogs: samples,
    createdAt: now,
    updatedAt: now,
  }
  return result
}
