// Provider factory: turn resolved model settings into a concrete
// `LLMProvider`. The UI calls this once per send so settings edits take
// effect immediately without a reload. Accepts anything with the four
// connection fields — a legacy LLMSettings block, a ModelProfile, or a
// ResolvedModel (settings.resolveSessionModel).

import { AnthropicProvider } from './anthropic'
import { LLMProvider } from './base'
import { LLMError } from './errors'
import { OpenAICompatibleProvider } from './openaiCompatible'
import { ResponsesProvider } from './responses'
import type { ApiMode, ModelCapabilities } from '../../settings/settings'

/** The connection quartet every provider adapter needs. */
export interface LLMProviderConfig {
  provider: string
  /** API mode for openai-compatible vendors; undefined = chat-completions. */
  apiMode?: ApiMode
  model: string
  baseUrl: string
  apiKey: string
  /** Resolved capabilities — the provider self-gates tools/reasoning
   *  based on these (default true unless explicitly false). */
  capabilities?: ModelCapabilities
  /** Per-model max output tokens cap (caps request max_tokens). */
  maxOutputTokens?: number
}

export function createLLMProvider(cfg: LLMProviderConfig): LLMProvider {
  switch (cfg.provider) {
    case 'openai-compatible':
      // 追加㉒: the same protocol speaks two API modes — the classic Chat
      // Completions endpoint or the newer Responses API.
      if (cfg.apiMode === 'responses') {
        return new ResponsesProvider({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          capabilities: cfg.capabilities,
          maxOutputTokens: cfg.maxOutputTokens,
        })
      }
      return new OpenAICompatibleProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        capabilities: cfg.capabilities,
        maxOutputTokens: cfg.maxOutputTokens,
      })
    case 'anthropic':
      return new AnthropicProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        maxOutputTokens: cfg.maxOutputTokens,
      })
    default:
      throw new LLMError('unknown', `未知的 provider：${cfg.provider}`)
  }
}
