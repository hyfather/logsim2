// AI provider keys live ONLY in the browser. They are persisted to localStorage
// and used directly from the client to call each provider's public API.
// Nothing in this file (or anything that imports it) may run on the server.

export type AIProvider = 'anthropic' | 'openai' | 'gemini'

export interface AIProviderMeta {
  label: string
  icon: string
  description: string
  defaultModel: string
  /** Example model strings to surface in the UI as a starting point. */
  modelExamples: string[]
  /** Where to find / create an API key. */
  consoleUrl: string
  /** Display hint about the expected key format. */
  keyHint: string
}

export const AI_PROVIDER_META: Record<AIProvider, AIProviderMeta> = {
  anthropic: {
    label: 'Anthropic Claude',
    icon: '🅰️',
    description: 'Claude models from Anthropic. Used directly from your browser.',
    defaultModel: 'claude-sonnet-4-6',
    modelExamples: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-...',
  },
  openai: {
    label: 'OpenAI',
    icon: '🟢',
    description: 'GPT models from OpenAI. Used directly from your browser.',
    defaultModel: 'gpt-4o-mini',
    modelExamples: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    consoleUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-...',
  },
  gemini: {
    label: 'Google Gemini',
    icon: '🔷',
    description: 'Gemini models from Google AI Studio. Used directly from your browser.',
    defaultModel: 'gemini-2.0-flash',
    modelExamples: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza...',
  },
}

export interface AIProviderConfig {
  provider: AIProvider
  apiKey: string
  model: string
  /** When true, this provider is preferred for AI features. Only one default at a time. */
  isDefault: boolean
  /** Free-form note the user can leave for themselves. */
  note?: string
  createdAt: string
  updatedAt: string
}
