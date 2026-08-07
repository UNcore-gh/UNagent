// Responses API adapter — pure mapping function tests (追加㉒).

import {
  buildResponseTools,
  mapWebSearchEvent,
  mapResponseStatus,
  toResponseInput,
} from '../responses'
import type { ChatMessage, ChatCompletionTool } from '../base'

describe('toResponseInput', () => {
  it('hoists system messages into instructions', () => {
    const { instructions, input } = toResponseInput([
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hi' },
    ])
    expect(instructions).toBe('You are helpful.\n\nBe concise.')
    expect(input).toEqual([{ type: 'message', role: 'user', content: 'Hi' }])
  })

  it('returns undefined instructions when there is no system message', () => {
    const { instructions, input } = toResponseInput([
      { role: 'user', content: 'Hi' },
    ])
    expect(instructions).toBeUndefined()
    expect(input).toHaveLength(1)
  })

  it('maps assistant text + tool calls into message and function_call items', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ id: 'call-1', name: 'search_notes', arguments: '{"q":"a"}' }],
      },
      { role: 'tool', content: 'found 3 notes', toolCallId: 'call-1' },
    ]
    const { input } = toResponseInput(messages)
    expect(input).toEqual([
      { type: 'message', role: 'assistant', content: 'Let me check.' },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'search_notes',
        arguments: '{"q":"a"}',
      },
      { type: 'function_call_output', call_id: 'call-1', output: 'found 3 notes' },
    ])
  })

  it('skips an empty assistant text but keeps its tool calls', () => {
    const { input } = toResponseInput([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c', name: 't', arguments: '{}' }],
      },
    ])
    expect(input).toHaveLength(1)
    expect(input[0].type).toBe('function_call')
  })

  it('emits input_text/input_image parts for user images', () => {
    const { input } = toResponseInput([
      {
        role: 'user',
        content: 'What is this?',
        images: ['data:image/png;base64,AAA'],
      },
    ])
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      },
    ])
  })
})

describe('mapResponseStatus', () => {
  it('tool calls win over any status', () => {
    expect(mapResponseStatus('completed', true)).toBe('tool-calls')
  })
  it('completed → stop', () => {
    expect(mapResponseStatus('completed', false)).toBe('stop')
  })
  it('incomplete → length', () => {
    expect(mapResponseStatus('incomplete', false)).toBe('length')
  })
  it('content_filter → content-filter', () => {
    expect(mapResponseStatus('content_filter', false)).toBe('content-filter')
  })
  it('unknown/failed → other', () => {
    expect(mapResponseStatus('failed', false)).toBe('other')
    expect(mapResponseStatus('', false)).toBe('other')
  })
})

describe('buildResponseTools', () => {
  const fnTool: ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Search notes',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
  }

  it('returns undefined when there are no tools and no webSearch capability', () => {
    expect(buildResponseTools(undefined)).toBeUndefined()
    expect(buildResponseTools([])).toBeUndefined()
    expect(buildResponseTools([fnTool], {})).toEqual([
      expect.objectContaining({ type: 'function', name: 'search_notes' }),
    ])
  })

  it('maps function tools and strips them when tools capability is false', () => {
    const items = buildResponseTools([fnTool], { tools: false })
    expect(items).toBeUndefined()
  })

  it('injects the server-side web_search item when webSearch is set', () => {
    const items = buildResponseTools(undefined, { webSearch: true })
    expect(items).toEqual([{ type: 'web_search' }])
  })

  it('keeps web_search alongside function tools (pure-chat rounds included)', () => {
    const withFn = buildResponseTools([fnTool], { webSearch: true })
    expect(withFn?.[0]).toEqual({ type: 'web_search' })
    expect(withFn?.[1]).toEqual(
      expect.objectContaining({ type: 'function', name: 'search_notes' }),
    )
    // Empty tool list (e.g. /btw) still gets the built-in search tool.
    expect(buildResponseTools([], { webSearch: true })).toEqual([
      { type: 'web_search' },
    ])
  })

  it('does not inject web_search unless the flag is explicitly true', () => {
    expect(buildResponseTools([fnTool], { webSearch: false })).toEqual([
      expect.objectContaining({ type: 'function' }),
    ])
    expect(buildResponseTools(undefined, { tools: true })).toBeUndefined()
  })
})

describe('mapWebSearchEvent', () => {
  it('maps output_item.added of a web_search_call to a searching chunk', () => {
    const chunk = mapWebSearchEvent({
      type: 'response.output_item.added',
      item: { type: 'web_search_call', id: 'ws_1', action: { query: '杭州天气' } },
    })
    expect(chunk).toEqual({
      type: 'web-search',
      status: 'searching',
      id: 'ws_1',
      query: '杭州天气',
    })
  })

  it('maps output_item.done to a done chunk carrying action.sources', () => {
    const chunk = mapWebSearchEvent({
      type: 'response.output_item.done',
      item: {
        type: 'web_search_call',
        id: 'ws_1',
        action: {
          query: '杭州天气',
          sources: [
            { url: 'https://a.com/x', title: '天气网' },
            { url: 'https://b.com/y' },
            { notAUrl: true },
          ],
        },
      },
    })
    expect(chunk).toEqual({
      type: 'web-search',
      status: 'done',
      id: 'ws_1',
      query: '杭州天气',
      sources: [
        { url: 'https://a.com/x', title: '天气网' },
        { url: 'https://b.com/y' },
      ],
    })
  })

  it('also accepts OpenAI-style results on the dedicated events', () => {
    const searching = mapWebSearchEvent({
      type: 'response.web_search_call.searching',
      item_id: 'ws_9',
    })
    expect(searching).toMatchObject({
      type: 'web-search',
      status: 'searching',
      id: 'ws_9',
    })
    const completed = mapWebSearchEvent({
      type: 'response.web_search_call.completed',
      item_id: 'ws_9',
      results: [{ url: 'https://c.com/z', title: 'C' }],
    })
    expect(completed).toMatchObject({
      type: 'web-search',
      status: 'done',
      sources: [{ url: 'https://c.com/z', title: 'C' }],
    })
  })

  it('returns null for unrelated events', () => {
    expect(mapWebSearchEvent({ type: 'response.output_text.delta', delta: 'x' })).toBeNull()
    expect(
      mapWebSearchEvent({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1' },
      }),
    ).toBeNull()
    expect(mapWebSearchEvent(null)).toBeNull()
  })
})
