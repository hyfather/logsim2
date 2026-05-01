'use client'
import type { AIProvider, AIProviderConfig } from '@/types/aiKeys'

// All requests in this file go DIRECTLY from the browser to the provider's
// public API. The user's API key is read from the browser-only Zustand store
// (useAIKeysStore) and put on outbound `Authorization` / `x-api-key` headers
// going to api.anthropic.com / api.openai.com / generativelanguage.googleapis.com.
//
// Nothing here ever calls the LogSim backend. If you add a new feature, follow
// the same pattern: take an `AIProviderConfig` from the store and post directly.

export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AICompletionRequest {
  messages: AIMessage[]
  /** Soft cap. Each provider clamps differently. */
  maxTokens?: number
  /** Override the model on the config (e.g. one-off "use opus for this call"). */
  model?: string
  /** AbortController signal for cancellation. */
  signal?: AbortSignal
  /** When set, asks the provider to enforce JSON output. */
  jsonMode?: boolean
}

export interface AICompletionResponse {
  text: string
  provider: AIProvider
  model: string
}

class AIRequestError extends Error {
  constructor(
    message: string,
    readonly provider: AIProvider,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AIRequestError'
  }
}

function buildSystemPrompt(messages: AIMessage[]): { system: string; rest: AIMessage[] } {
  const systems = messages.filter(m => m.role === 'system').map(m => m.content)
  const rest = messages.filter(m => m.role !== 'system')
  return { system: systems.join('\n\n'), rest }
}

async function readError(res: Response, provider: AIProvider): Promise<AIRequestError> {
  let detail = `HTTP ${res.status}`
  try {
    const body = await res.json()
    const message =
      body?.error?.message ||
      body?.error?.error?.message ||
      body?.message ||
      JSON.stringify(body)
    if (message) detail = message
  } catch {
    try {
      detail = (await res.text()) || detail
    } catch {
      /* ignore */
    }
  }
  return new AIRequestError(detail, provider, res.status)
}

// ── Anthropic Claude ─────────────────────────────────────────────────────────

async function completeAnthropic(config: AIProviderConfig, req: AICompletionRequest): Promise<AICompletionResponse> {
  const { system, rest } = buildSystemPrompt(req.messages)
  const model = req.model || config.model
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // Required to call the Anthropic API directly from a browser.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal: req.signal,
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: rest.map(m => ({ role: m.role, content: m.content })),
    }),
  })

  if (!res.ok) throw await readError(res, 'anthropic')

  const data = await res.json()
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((block: { type: string }) => block.type === 'text')
        .map((block: { text: string }) => block.text)
        .join('')
    : ''
  return { text, provider: 'anthropic', model }
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function completeOpenAI(config: AIProviderConfig, req: AICompletionRequest): Promise<AICompletionResponse> {
  const model = req.model || config.model
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    signal: req.signal,
    body: JSON.stringify({
      model,
      messages: req.messages.map(m => ({ role: m.role, content: m.content })),
      max_completion_tokens: req.maxTokens ?? 4096,
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  })

  if (!res.ok) throw await readError(res, 'openai')

  const data = await res.json()
  const text: string = data?.choices?.[0]?.message?.content ?? ''
  return { text, provider: 'openai', model }
}

// ── Google Gemini ────────────────────────────────────────────────────────────

async function completeGemini(config: AIProviderConfig, req: AICompletionRequest): Promise<AICompletionResponse> {
  const model = req.model || config.model
  const { system, rest } = buildSystemPrompt(req.messages)

  // Gemini uses the API key as a `?key=` query param. Keep the key in the URL
  // only — do not ever log full URLs anywhere.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: req.signal,
    body: JSON.stringify({
      ...(system ? { systemInstruction: { role: 'system', parts: [{ text: system }] } } : {}),
      contents: rest.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 4096,
        ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  })

  if (!res.ok) throw await readError(res, 'gemini')

  const data = await res.json()
  const text: string = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p?.text ?? '')
    .join('')
  return { text, provider: 'gemini', model }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function complete(config: AIProviderConfig, req: AICompletionRequest): Promise<AICompletionResponse> {
  if (!config.apiKey) {
    throw new AIRequestError('Missing API key — add one in Settings → AI Keys.', config.provider)
  }
  switch (config.provider) {
    case 'anthropic': return completeAnthropic(config, req)
    case 'openai':    return completeOpenAI(config, req)
    case 'gemini':    return completeGemini(config, req)
  }
}

/** Send a tiny round-trip to verify the key works. Throws on failure. */
export async function pingProvider(config: AIProviderConfig): Promise<void> {
  await complete(config, {
    messages: [
      { role: 'user', content: 'Reply with the single word: pong' },
    ],
    maxTokens: 16,
  })
}

// ── Model listing ────────────────────────────────────────────────────────────

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  })
  if (!res.ok) throw await readError(res, 'anthropic')
  const data = await res.json()
  return (data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean)
}

async function listOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await readError(res, 'openai')
  const data = await res.json()
  return (data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean)
}

async function listGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
  )
  if (!res.ok) throw await readError(res, 'gemini')
  const data = await res.json()
  return (data?.models ?? [])
    .filter((m: { supportedGenerationMethods?: string[] }) =>
      (m.supportedGenerationMethods ?? []).includes('generateContent'),
    )
    .map((m: { name: string }) => m.name?.replace(/^models\//, ''))
    .filter(Boolean)
}

export async function listModels(provider: AIProvider, apiKey: string): Promise<string[]> {
  if (!apiKey) throw new AIRequestError('Missing API key.', provider)
  switch (provider) {
    case 'anthropic': return listAnthropicModels(apiKey)
    case 'openai':    return listOpenAIModels(apiKey)
    case 'gemini':    return listGeminiModels(apiKey)
  }
}

// ── "Most intelligent" model picker ──────────────────────────────────────────
//
// Per-provider heuristic ranking. We prefer the flagship reasoning/quality
// tier of the latest version, ignoring small/cheap variants and non-text
// modalities (audio, image, embedding, moderation, etc.).

// Strip provider-style date suffixes ("-20250514", "-2025-08-07", "-latest")
// so version extraction below doesn't mistake a date for a minor version.
function stripDateSuffix(id: string): string {
  return id
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '')
}

// Parse a "major.minor" or "major-minor" version pair, e.g. "4-7" → 407.
// Returns 0 when no version is present.
function parseVersion(id: string): number {
  const mm = id.match(/(\d+)[.-](\d+)(?!\d)/)
  if (mm) return parseInt(mm[1]) * 100 + parseInt(mm[2])
  const single = id.match(/-(\d+)\b/)
  return single ? parseInt(single[1]) * 100 : 0
}

function rankAnthropic(id: string): number {
  const lower = id.toLowerCase()
  if (!lower.startsWith('claude')) return -1
  const tier = lower.includes('opus') ? 3 : lower.includes('sonnet') ? 2 : lower.includes('haiku') ? 1 : 0
  if (!tier) return -1
  const stripped = stripDateSuffix(lower)
  const ver = parseVersion(stripped)
  // Prefer aliases (no trailing date) over date-pinned snapshots.
  const dated = stripped !== lower ? 0 : 1
  // Tier dominates, then version, then date preference.
  return tier * 10000 + ver + dated * 0.1
}

function rankOpenAI(id: string): number {
  const lower = id.toLowerCase()
  const blocked = ['embed', 'audio', 'image', 'moderation', 'whisper', 'tts', 'dall', 'realtime', 'instruct', 'transcribe', 'search', 'computer-use', 'davinci', 'babbage', 'curie']
  if (blocked.some(b => lower.includes(b))) return -1
  if (lower.includes('mini') || lower.includes('nano')) return -1

  const stripped = stripDateSuffix(lower)
  const dated = stripped !== lower ? 0 : 1

  // Modern flagship: gpt-5.x family. Use minor version so 5.5 > 5.0.
  if (stripped.startsWith('gpt-5')) {
    const minor = stripped.match(/^gpt-5[.-](\d+)/)
    const minorVal = minor ? parseInt(minor[1]) : 0
    return 6000 + minorVal * 10 + dated
  }
  // Newer reasoning models (o3, o4, ...). o1 / o2 are explicitly legacy below.
  const oNew = stripped.match(/^o([3-9]|\d{2,})\b/)
  if (oNew) {
    return 5000 + parseInt(oNew[1]) * 10 + dated
  }
  // Older flagships kept as fallbacks if nothing newer is available.
  if (stripped.startsWith('gpt-4.5')) return 4500 + dated * 0.1
  if (stripped.startsWith('gpt-4o')) return 4000 + dated * 0.1
  if (stripped.startsWith('gpt-4-turbo')) return 3500 + dated * 0.1
  if (stripped.startsWith('gpt-4')) return 3000 + dated * 0.1
  // Legacy reasoning (o1, o2) — kept above gpt-3.5 but below any modern model.
  if (/^o[12]\b/.test(stripped)) return 2500 + dated * 0.1
  if (stripped.startsWith('gpt-3.5')) return 2000 + dated * 0.1
  return -1
}

function rankGemini(id: string): number {
  const lower = id.toLowerCase()
  if (!lower.startsWith('gemini')) return -1
  if (lower.includes('embedding') || lower.includes('aqa') || lower.includes('image') || lower.includes('tts') || lower.includes('audio')) return -1
  const stripped = stripDateSuffix(lower)
  const ver = parseVersion(stripped)
  // flash-lite must be checked before flash (substring overlap).
  const tier = stripped.includes('flash-lite') ? 100 : stripped.includes('pro') ? 300 : stripped.includes('flash') ? 200 : 0
  if (!tier) return -1
  // Prefer stable over -exp / -preview snapshots.
  const stable = (stripped.includes('exp') || stripped.includes('preview')) ? 0 : 1
  // Version dominates so a newer Flash beats an older Pro; tier is the tiebreaker.
  return ver * 10 + tier + stable
}

function rankerFor(provider: AIProvider): (id: string) => number {
  return provider === 'anthropic' ? rankAnthropic : provider === 'openai' ? rankOpenAI : rankGemini
}

export function pickBestModel(provider: AIProvider, ids: string[]): string | undefined {
  if (!ids.length) return undefined
  const ranker = rankerFor(provider)
  const ranked = ids
    .map(id => ({ id, score: ranker(id) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.id ?? ids[0]
}

/**
 * Sort models for display: chat-capable / flagship tier first (sorted by rank
 * descending), then everything else (cheap variants, embeddings, etc.) below.
 */
export function sortModelsForDisplay(provider: AIProvider, ids: string[]): string[] {
  const ranker = rankerFor(provider)
  const scored = ids.map(id => ({ id, score: ranker(id) }))
  const primary = scored.filter(x => x.score >= 0).sort((a, b) => b.score - a.score)
  const secondary = scored.filter(x => x.score < 0).sort((a, b) => a.id.localeCompare(b.id))
  return [...primary.map(x => x.id), ...secondary.map(x => x.id)]
}

export { AIRequestError }
