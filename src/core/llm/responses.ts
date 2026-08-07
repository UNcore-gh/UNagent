// OpenAI Responses API adapter (追加㉒).
//
// Wire format (POST {baseUrl}/responses, native fetch + hand-written SSE):
//   body: { model, input, stream, instructions?, tools?, temperature?,
//           max_output_tokens?, reasoning? }
//   system messages are hoisted to the top-level `instructions` param;
//   assistant tool calls become `function_call` items and tool results
//   become `function_call_output` items.
//
// SSE events carry their own `type` field, so the shared data-only parseSSE
// is enough: response.output_text.delta (text), response.output_item.added
// (function_call start), response.function_call_arguments.delta (args),
// response.reasoning_summary_text.delta (thinking), response.completed /
// response.incomplete / response.failed (finish + usage), error.
//
// Server-side built-in tools: when the model capability `webSearch` is set,
// the standard `{"type":"web_search"}` item is appended to `tools` — the
// server executes the search itself (百炼 Responses API / OpenAI Responses
// both speak this shape), so no client-side tool loop is involved.

import {
  ChatMessage,
  ChatCompletionTool,
  FinishReason,
  LLMProvider,
  StreamChatOptions,
  StreamChunk,
  TokenUsage,
  WebSearchSource,
} from './base'
import { LLMError } from './errors'
import { fetchStream } from './http'
import { parseSSE } from '../../utils/sse'
import type { ModelCapabilities } from '../../settings/settings'

export interface ResponsesConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Resolved capabilities — self-gates tools/reasoning. */
  capabilities?: ModelCapabilities
  /** Per-model max output tokens cap. */
  maxOutputTokens?: number
}

/** Wire content: plain string or text/image_url parts (same as Chat Completions). */
type ResponseContent =
  | string
  | Array<
      | { type: 'input_text'; text: string }
      | { type: 'input_image'; image_url: string }
    >

/** One item of the Responses API `input` array. */
export type ResponseInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponseContent }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/**
 * Map unified ChatMessages onto Responses API input items. System messages
 * are hoisted into the returned `instructions` string (the API's top-level
 * system-prompt slot).
 */
export function toResponseInput(messages: ChatMessage[]): {
  instructions?: string
  input: ResponseInputItem[]
} {
  const systemParts: string[] = []
  const input: ResponseInputItem[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId ?? '',
        output: m.content,
      })
      continue
    }
    if (m.role === 'assistant') {
      if (m.content) {
        input.push({ type: 'message', role: 'assistant', content: m.content })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })
      }
      continue
    }
    // user — with optional images as input_text/input_image parts.
    if (m.images && m.images.length > 0) {
      const parts: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
      > = []
      if (m.content) parts.push({ type: 'input_text', text: m.content })
      for (const url of m.images) {
        parts.push({ type: 'input_image', image_url: url })
      }
      input.push({ type: 'message', role: 'user', content: parts })
    } else {
      input.push({ type: 'message', role: 'user', content: m.content })
    }
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    input,
  }
}

/** Map the final response status (+ tool-call presence) onto FinishReason. */
export function mapResponseStatus(
  status: string,
  hadToolCalls: boolean,
): FinishReason {
  if (hadToolCalls) return 'tool-calls'
  switch (status) {
    case 'completed':
      return 'stop'
    case 'incomplete':
      return 'length'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'other'
  }
}

/**
 * Assemble the Responses API `tools` array: plugin function tools mapped to
 * `{type:'function', ...}` items, plus the server-side `web_search` built-in
 * when the model declares the webSearch capability (百炼/OpenAI Responses
 * execute it server-side; the client never sees a function_call for it).
 * Returns undefined when there is nothing to send.
 */
export function buildResponseTools(
  tools: ChatCompletionTool[] | undefined,
  capabilities?: ModelCapabilities,
): Array<Record<string, unknown>> | undefined {
  const items: Array<Record<string, unknown>> = []
  if (tools && tools.length > 0 && capabilities?.tools !== false) {
    for (const t of tools) {
      items.push({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
      })
    }
  }
  if (capabilities?.webSearch === true) {
    items.unshift({ type: 'web_search' })
  }
  return items.length > 0 ? items : undefined
}

/** Extract source links from a web_search_call item's action payload
 *  (百炼 uses `action.sources`; OpenAI uses `action.results` — accept both). */
function extractSources(action: any): WebSearchSource[] {
  const raw = action?.sources ?? action?.results
  if (!Array.isArray(raw)) return []
  const out: WebSearchSource[] = []
  for (const s of raw) {
    const url = typeof s?.url === 'string' ? s.url : ''
    if (!url) continue
    out.push({
      url,
      ...(typeof s?.title === 'string' && s.title ? { title: s.title } : {}),
    })
  }
  return out
}

/**
 * Map one SSE event onto a web-search progress chunk, or null when the event
 * is unrelated. Two wire shapes are covered: generic output_item
 * added/done events carrying a `web_search_call` item (百炼), and the
 * dedicated `response.web_search_call.*` events (OpenAI-style).
 */
export function mapWebSearchEvent(event: any): StreamChunk | null {
  if (!event || typeof event !== 'object') return null

  if (
    event.type === 'response.output_item.added' ||
    event.type === 'response.output_item.done'
  ) {
    const item = event.item
    if (item?.type !== 'web_search_call') return null
    const id = typeof item.id === 'string' ? item.id : 'web-search'
    const query =
      typeof item.action?.query === 'string' ? item.action.query : undefined
    if (event.type === 'response.output_item.added') {
      return {
        type: 'web-search',
        status: 'searching',
        id,
        ...(query ? { query } : {}),
      }
    }
    return {
      type: 'web-search',
      status: 'done',
      id,
      ...(query ? { query } : {}),
      sources: extractSources(item.action),
    }
  }

  if (
    event.type === 'response.web_search_call.searching' ||
    event.type === 'response.web_search_call.completed'
  ) {
    const id =
      typeof event.item_id === 'string' ? event.item_id : 'web-search'
    const searching = event.type === 'response.web_search_call.searching'
    return {
      type: 'web-search',
      status: searching ? 'searching' : 'done',
      id,
      ...(!searching ? { sources: extractSources(event) } : {}),
    }
  }

  return null
}

export class ResponsesProvider implements LLMProvider {
  readonly id = 'openai-responses'

  constructor(private readonly config: ResponsesConfig) {}

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

    const url = baseUrl.replace(/\/+$/, '') + '/responses'
    const { instructions, input } = toResponseInput(messages)
    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
    }
    if (instructions) body.instructions = instructions

    const caps = this.config.capabilities
    const wireTools = buildResponseTools(tools, caps)
    if (wireTools) body.tools = wireTools
    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.maxTokens !== undefined) body.max_output_tokens = options.maxTokens
    if (this.config.maxOutputTokens && typeof body.max_output_tokens === 'number') {
      if (body.max_output_tokens > this.config.maxOutputTokens) {
        body.max_output_tokens = this.config.maxOutputTokens
      }
    }
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
      body.reasoning = { effort: effort[options.thinking] }
    }

    console.debug(
      '[Obsidian AI] LLM request (responses) →',
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
    let hadToolCalls = false
    /** item_id → output index, so argument deltas keep their tool-call slot. */
    const callIndex = new Map<string, number>()

    for await (const data of parseSSE(response)) {
      let event: any
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }

      if (event.type === 'error') {
        throw new LLMError(
          'http',
          event.error?.message ?? event.message ?? 'Responses API 返回错误',
        )
      }

      // Server-side web search progress (web_search_call items) → UI chunk;
      // unrelated events fall through to the normal switch below.
      const ws = mapWebSearchEvent(event)
      if (ws) {
        yield ws
        continue
      }

      switch (event.type) {
        case 'response.output_item.added': {
          const item = event.item
          if (item?.type === 'function_call') {
            hadToolCalls = true
            const index =
              typeof event.output_index === 'number' ? event.output_index : 0
            if (typeof item.id === 'string') callIndex.set(item.id, index)
            yield {
              type: 'tool-call',
              toolCall: {
                index,
                id: item.call_id,
                name: item.name,
                arguments: '',
              },
            }
          }
          break
        }

        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            yield { type: 'text', text: event.delta }
          }
          break

        case 'response.reasoning_summary_text.delta':
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            yield { type: 'thinking', text: event.delta }
          }
          break

        case 'response.function_call_arguments.delta': {
          const index =
            typeof event.output_index === 'number'
              ? event.output_index
              : callIndex.get(event.item_id) ?? 0
          yield {
            type: 'tool-call',
            toolCall: {
              index,
              arguments: typeof event.delta === 'string' ? event.delta : '',
            },
          }
          break
        }

        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed': {
          const r = event.response ?? {}
          finishReason = mapResponseStatus(
            typeof r.status === 'string' ? r.status : '',
            hadToolCalls,
          )
          const u = r.usage
          if (u) {
            usage = {
              promptTokens: u.input_tokens,
              completionTokens: u.output_tokens,
              totalTokens: u.total_tokens,
            }
          }
          break
        }

        // response.created / in_progress / output_text.done / etc.: no-op.
        default:
          break
      }
    }

    // Servers that close without a terminal event still get a finish chunk.
    yield { type: 'finish', reason: finishReason, usage }
  }
}
