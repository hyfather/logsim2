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
      max_tokens: req.maxTokens ?? 4096,
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

export { AIRequestError }
