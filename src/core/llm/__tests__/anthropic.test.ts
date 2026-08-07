// Anthropic adapter — request body construction, focused on the max_tokens
// priority chain: caller options.maxTokens > config.maxOutputTokens > 4096.
// Uses a fake fetch that replays a minimal SSE stream, so no network is hit.

import { AnthropicProvider } from '../anthropic'
import type { ChatMessage, StreamChunk } from '../base'

const DEFAULT_MAX_TOKENS = 4096

/** Minimal SSE stream that completes the provider's event loop cleanly. */
const SSE_BODY = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
  '',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  '',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

/** Builds a WHATWG-ish Response whose body streams the SSE payload. */
function sseResponse(): Response {
  const encoder = new TextEncoder()
  const chunk = encoder.encode(SSE_BODY)
  let delivered = false
  const reader = {
    async read(): Promise<{ done: boolean; value: Uint8Array | undefined }> {
      if (!delivered) {
        delivered = true
        return { done: false, value: chunk }
      }
      return { done: true, value: undefined }
    },
    releaseLock(): void {},
  }
  return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response
}

const userMsg: ChatMessage[] = [{ role: 'user', content: 'hi' }]

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('AnthropicProvider max_tokens priority', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  /** Runs streamChat and returns the parsed request body JSON. */
  async function captureBody(
    config: { maxOutputTokens?: number },
    options?: { maxTokens?: number },
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined
    global.fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body))
      return sseResponse()
    }) as unknown as typeof fetch

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      model: 'claude-test',
      ...config,
    })
    await collect(provider.streamChat(userMsg, undefined, options))

    expect(captured).toBeDefined()
    return captured as Record<string, unknown>
  }

  it('defaults to 4096 when neither options nor config supply a cap', async () => {
    const body = await captureBody({})
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('uses config.maxOutputTokens when no per-call maxTokens is given', async () => {
    const body = await captureBody({ maxOutputTokens: 2048 })
    expect(body.max_tokens).toBe(2048)
  })

  it('prefers options.maxTokens over config.maxOutputTokens', async () => {
    const body = await captureBody({ maxOutputTokens: 2048 }, { maxTokens: 512 })
    expect(body.max_tokens).toBe(512)
  })
})
