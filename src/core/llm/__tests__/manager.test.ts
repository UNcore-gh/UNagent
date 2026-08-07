// Provider factory — connection-field passthrough. Focuses on the Anthropic
// branch wiring maxOutputTokens through to the adapter config (parity with
// the two openai-compatible branches).

import { createLLMProvider } from '../manager'
import { AnthropicProvider } from '../anthropic'

describe('createLLMProvider', () => {
  it('passes maxOutputTokens into the anthropic provider config', () => {
    const provider = createLLMProvider({
      provider: 'anthropic',
      model: 'claude-test',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      maxOutputTokens: 2048,
    })
    expect(provider).toBeInstanceOf(AnthropicProvider)
    const config = (provider as unknown as { config: { maxOutputTokens?: number } }).config
    expect(config.maxOutputTokens).toBe(2048)
  })

  it('leaves maxOutputTokens undefined when not provided', () => {
    const provider = createLLMProvider({
      provider: 'anthropic',
      model: 'claude-test',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
    })
    const config = (provider as unknown as { config: { maxOutputTokens?: number } }).config
    expect(config.maxOutputTokens).toBeUndefined()
  })
})
