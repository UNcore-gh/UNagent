// OpenAI-compatible adapter (works with OpenAI, DeepSeek, OpenRouter, local
// proxies, etc. — anything speaking the /chat/completions SSE protocol).
// Native fetch + hand-written SSE; no SDK.

import {
  ChatMessage,
  ChatCompletionTool,
  FinishReason,
  LLMProvider,
  StreamChatOptions,
  StreamChunk,
  TokenUsage,
} from './base'
import { LLMError } from './errors'
import { fetchStream } from './http'
import { parseSSE } from '../../utils/sse'
import type { ModelCapabilities } from '../../settings/settings'

export interface OpenAICompatibleConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Resolved capabilities — self-gates tools/reasoning. */
  capabilities?: ModelCapabilities
  /** Per-model max output tokens cap. */
  maxOutputTokens?: number
}

/** Wire content: a plain string, or an array of text/image_url parts for
 *  multimodal (vision) messages. */
type WireContent =
  | string
  | null
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

interface OpenAIWireMessage {
  role: string
  content: WireContent
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export function toWireMessages(messages: ChatMessage[]): OpenAIWireMessage[] {
  return messages.map((m) => {
    // Tool-result message: answers a prior assistant tool call.
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: m.content,
      }
    }
    // Multimodal: when the message carries image data URLs, emit an array of
    // text + image_url parts (OpenAI vision format). The text content stays
    // first so providers that only read the first part still get the prompt.
    if (m.images && m.images.length > 0) {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const url of m.images) {
        parts.push({ type: 'image_url', image_url: { url } })
      }
      const wire: OpenAIWireMessage = { role: m.role, content: parts }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        wire.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      }
      return wire
    }
    const wire: OpenAIWireMessage = { role: m.role, content: m.content }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // OpenAI wants content nullable when only tool_calls are present.
      wire.content = m.content || null
      wire.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }))
    }
    return wire
  })
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'other'
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai-compatible'

  constructor(private readonly config: OpenAICompatibleConfig) {}

  async *streamChat(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    options?: StreamChatOptions,
  ): AsyncGenerator<StreamChunk> {
    const baseUrl = this.config.baseUrl.trim()
    const apiKey = this.config.apiKey.trim()
    const model = this.config.model.trim()

    if (!apiKey) {
      throw new LLMError('api-key-missing', '请先在设置中填写 API Key')
    }
    if (!baseUrl) {
      throw new LLMError('base-url-missing', '请先在设置中填写 Base URL')
    }
    if (!model) {
      throw new LLMError('model-missing', '请先在设置中填写模型名称')
    }

    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(messages),
      stream: true,
      // Ask for token usage in the final chunk (widely supported).
      stream_options: { include_usage: true },
    }
    // Capability self-gating: tools default true (backward compat) — explicit
    // false strips them so non-supporting models don't 400.
    const caps = this.config.capabilities
    if (tools && tools.length > 0 && caps?.tools !== false) body.tools = tools
    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens
    // Cap max_tokens to the model's known limit.
    if (this.config.maxOutputTokens && typeof body.max_tokens === 'number') {
      if (body.max_tokens > this.config.maxOutputTokens) {
        body.max_tokens = this.config.maxOutputTokens
      }
    }
    // Reasoning: default true — explicit false skips reasoning_effort so
    // non-reasoning models don't get a (possibly rejected) unknown field.
    if (
      options?.thinking &&
      options.thinking !== 'off' &&
      caps?.reasoning !== false
    ) {
      const effort = {
        think: 'low',
        'think-hard': 'medium',
        ultrathink: 'high',
      } as const
      body.reasoning_effort = effort[options.thinking]
    }

    // 追加㉒: vendor-specific extra params were removed — requests carry only
    // the standard fields and rely on each provider's defaults.

    // Debug: log the final request (no API key in body) so failures can be
    // traced. Filtered to debug level — harmless in production.
    console.debug(
      '[Obsidian AI] LLM request →',
      url,
      JSON.stringify(body).slice(0, 2000),
    )

    const response = await fetchStream(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.signal,
    )

    let finishReason: FinishReason = 'stop'
    let usage: TokenUsage | undefined

    for await (const data of parseSSE(response)) {
      if (data === '[DONE]') break

      let json: any
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }

      if (json.error) {
        throw new LLMError(
          'http',
          typeof json.error === 'string'
            ? json.error
            : json.error.message ?? '服务端返回错误',
        )
      }

      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      }

      const choice = json.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content }
      }

      // Reasoning / thinking content: DeepSeek streams it as
      // `reasoning_content`; some OpenAI-compatible servers use `reasoning`.
      // Both are surfaced as thinking chunks for the UI to render.
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        yield { type: 'thinking', text: delta.reasoning_content }
      }
      if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
        yield { type: 'thinking', text: delta.reasoning }
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          yield {
            type: 'tool-call',
            toolCall: {
              index: typeof tc.index === 'number' ? tc.index : 0,
              id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            },
          }
        }
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = mapFinishReason(choice.finish_reason)
      }
    }

    yield { type: 'finish', reason: finishReason, usage }
  }
}
