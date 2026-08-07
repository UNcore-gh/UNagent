// Anthropic Messages API adapter.
//
// Wire format (POST {baseUrl}/v1/messages, native fetch + hand-written SSE):
//   headers: Content-Type, x-api-key, anthropic-version: 2023-06-01
//   body:    { model, max_tokens (required), stream, messages, system?, tools? }
//   system messages are hoisted to the top-level `system` param.
//
// SSE events: message_start (usage.input_tokens) -> content_block_start
// (text | tool_use{id,name}) -> content_block_delta (text_delta | input_json_delta)
// -> content_block_stop -> message_delta (stop_reason, usage.output_tokens)
// -> message_stop. Errors arrive as an { type:"error", error:{type,message} } event.

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

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MAX_TOKENS = 4096

export interface AnthropicConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Per-model max output tokens cap (default when the caller passes none). */
  maxOutputTokens?: number
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
}

interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

export function toWireMessages(messages: ChatMessage[]): {
  system?: string
  messages: AnthropicWireMessage[]
} {
  const systemParts: string[] = []
  const turns: AnthropicWireMessage[] = []

  const push = (role: 'user' | 'assistant', block: AnthropicContentBlock) => {
    const last = turns[turns.length - 1]
    // Anthropic requires alternating user/assistant turns — merge adjacent
    // same-role blocks (e.g. several tool_result messages into one user turn).
    if (last && last.role === role) {
      last.content.push(block)
    } else {
      turns.push({ role, content: [block] })
    }
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      push('user', {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      })
      continue
    }
    if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = tc.arguments ? JSON.parse(tc.arguments) : {}
        } catch {
          input = {}
        }
        push('assistant', {
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input,
        })
      }
      continue
    }
    // user
    push('user', { type: 'text', text: m.content })
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: turns,
  }
}

function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool-calls'
    case 'refusal':
      return 'content-filter'
    default:
      return 'other'
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic'

  constructor(private readonly config: AnthropicConfig) {}

  async *streamChat(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    options?: StreamChatOptions,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = this.config.apiKey.trim()
    const model = this.config.model.trim()
    if (!apiKey) {
      throw new LLMError('api-key-missing', '请先在设置中填写 API Key')
    }
    if (!model) {
      throw new LLMError('model-missing', '请先在设置中填写模型名称')
    }

    const baseUrl = (
      this.config.baseUrl.trim() || DEFAULT_BASE_URL
    ).replace(/\/+$/, '')
    const url = baseUrl + '/v1/messages'

    const { system, messages: wireMessages } = toWireMessages(messages)
    const body: Record<string, unknown> = {
      model,
      max_tokens: options?.maxTokens ?? this.config.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages: wireMessages,
    }
    if (system) body.system = system
    // Any non-off level enables adaptive extended thinking; the model sizes
    // its own budget, so the three levels differ mainly in intent signaling.
    const thinkingOn = options?.thinking !== undefined && options.thinking !== 'off'
    if (thinkingOn) body.thinking = { type: 'adaptive' }
    // temperature is rejected while extended thinking is active.
    if (!thinkingOn && options?.temperature !== undefined) {
      body.temperature = options.temperature
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? {
          type: 'object',
          properties: {},
        },
      }))
    }

    const response = await fetchStream(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.signal,
    )

    let finishReason: FinishReason = 'stop'
    let inputTokens: number | undefined
    let outputTokens: number | undefined

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
          event.error?.message ?? 'Anthropic 返回错误',
        )
      }

      switch (event.type) {
        case 'message_start':
          inputTokens = event.message?.usage?.input_tokens
          break

        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            yield {
              type: 'tool-call',
              toolCall: {
                index: event.index ?? 0,
                id: event.content_block.id,
                name: event.content_block.name,
                arguments: '',
              },
            }
          } else if (event.content_block?.type === 'redacted_thinking') {
            // Encrypted thinking block — the raw content is intentionally
            // withheld by the API; surface a placeholder so the user knows
            // reasoning happened but isn't viewable.
            yield { type: 'thinking', text: '[此段思考内容已加密，不可查看]' }
          }
          break

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text', text: event.delta.text }
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            yield { type: 'thinking', text: event.delta.thinking }
          } else if (event.delta?.type === 'input_json_delta') {
            yield {
              type: 'tool-call',
              toolCall: {
                index: event.index ?? 0,
                arguments: event.delta.partial_json ?? '',
              },
            }
          }
          break

        case 'message_delta':
          if (typeof event.delta?.stop_reason === 'string') {
            finishReason = mapStopReason(event.delta.stop_reason)
          }
          if (event.usage?.output_tokens != null) {
            outputTokens = event.usage.output_tokens
          }
          break

        // message_stop / content_block_stop / ping: nothing to do.
        default:
          break
      }
    }

    const usage: TokenUsage | undefined =
      inputTokens != null || outputTokens != null
        ? {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens:
              (inputTokens ?? 0) + (outputTokens ?? 0) || undefined,
          }
        : undefined

    yield { type: 'finish', reason: finishReason, usage }
  }
}
