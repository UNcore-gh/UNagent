// Provider request-body construction: the pure message → wire-format mapping
// each adapter performs before POSTing. These mappings are the highest-risk
// per-provider code (tool roles, alternating turns), hence direct coverage.

import type { ChatMessage } from '../base'
import { toWireMessages as toOpenAIWire } from '../openaiCompatible'
import { toWireMessages as toAnthropicWire } from '../anthropic'

describe('OpenAI-compatible wire mapping', () => {
  it('maps tool-role messages to {role:tool, tool_call_id}', () => {
    const msgs: ChatMessage[] = [
      { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
    ]
    expect(toOpenAIWire(msgs)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ])
  })

  it('maps assistant tool calls and nulls empty content', () => {
    const wire = toOpenAIWire([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_note', arguments: '{"path":"a.md"}' },
        ],
      },
    ])
    expect(wire[0].content).toBeNull()
    expect(wire[0].tool_calls).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'read_note', arguments: '{"path":"a.md"}' },
      },
    ])
  })

  it('passes plain user/assistant turns through unchanged', () => {
    expect(
      toOpenAIWire([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })
})

describe('Anthropic wire mapping', () => {
  it('hoists system messages to the top-level system param', () => {
    const out = toAnthropicWire([
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'hi' },
    ])
    expect(out.system).toBe('S1\n\nS2')
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
  })

  it('omits system when there are no system messages', () => {
    const out = toAnthropicWire([{ role: 'user', content: 'hi' }])
    expect(out.system).toBeUndefined()
  })

  it('turns tool results into user tool_result blocks, merging adjacent turns', () => {
    const out = toAnthropicWire([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 'c1', name: 'read_note', arguments: '{"path":"a.md"}' }],
      },
      // Two consecutive tool messages must merge into ONE user turn —
      // Anthropic requires strictly alternating user/assistant roles.
      { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
      { role: 'tool', content: '{"ok":false}', toolCallId: 'c2' },
    ])
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'read_note',
            input: { path: 'a.md' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'c2', content: '{"ok":false}' },
        ],
      },
    ])
  })

  it('falls back to {} input when tool-call arguments are invalid JSON', () => {
    const out = toAnthropicWire([
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c9', name: 't', arguments: 'not-json' }],
      },
    ])
    expect(out.messages[1].content).toEqual([
      { type: 'tool_use', id: 'c9', name: 't', input: {} },
    ])
  })
})

/* ── Multimodal: images → image_url content array ─────────────── */

describe('OpenAI-compatible multimodal wire mapping', () => {
  it('emits array content with text + image_url parts when images are present', () => {
    const wire = toOpenAIWire([
      { role: 'user', content: 'What is this?', images: ['data:image/png;base64,iVBOR='] },
    ])
    expect(wire).toHaveLength(1)
    expect(wire[0].role).toBe('user')
    expect(Array.isArray(wire[0].content)).toBe(true)
    const parts = wire[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'text', text: 'What is this?' })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR=' } })
  })

  it('emits multiple image_url parts for multiple images', () => {
    const wire = toOpenAIWire([
      {
        role: 'user',
        content: 'Compare these',
        images: ['data:image/png;base64,AAA=', 'data:image/jpeg;base64,BBB='],
      },
    ])
    const parts = wire[0].content as Array<{ type: string }>
    expect(parts).toHaveLength(3) // 1 text + 2 image_url
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2)
  })

  it('falls back to plain string content when no images', () => {
    const wire = toOpenAIWire([
      { role: 'user', content: 'just text' },
    ])
    expect(typeof wire[0].content).toBe('string')
    expect(wire[0].content).toBe('just text')
  })

  it('treats empty images array as no images', () => {
    const wire = toOpenAIWire([
      { role: 'user', content: 'text only', images: [] },
    ])
    expect(typeof wire[0].content).toBe('string')
  })
})
