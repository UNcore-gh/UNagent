// mcpClient — JSON-RPC over streamableHttp: response shape parsing (JSON vs
// SSE), session id pass-through, error envelope mapping. No real network.

import { mcpRequest, mcpListTools, mcpCallTool } from '../mcpClient'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

/** Fake WHATWG-ish Response with JSON body. */
function jsonResponse(
  body: unknown,
  opts?: { status?: number; sessionId?: string },
): Response {
  const status = opts?.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase()
        if (key === 'content-type') return 'application/json'
        if (key === 'mcp-session-id') return opts?.sessionId ?? null
        return null
      },
    },
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** Fake Response streaming one SSE data frame per line pair. */
function sseResponse(frames: string[], sessionId?: string): Response {
  const payload = frames.map((f) => `data: ${f}`).join('\n') + '\n\n'
  const encoder = new TextEncoder()
  const chunk = encoder.encode(payload)
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
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase()
        if (key === 'content-type') return 'text/event-stream'
        if (key === 'mcp-session-id') return sessionId ?? null
        return null
      },
    },
    body: { getReader: () => reader },
  } as unknown as Response
}

function mockFetchSequence(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  global.fetch = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init: init as RequestInit })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return calls
}

describe('mcpRequest response parsing', () => {
  it('parses an application/json body and returns the result', async () => {
    mockFetchSequence([jsonResponse({ jsonrpc: '2.0', id: 1, result: { a: 1 } })])
    const { result } = await mcpRequest('https://x/mcp', '', 'tools/list', {})
    expect(result).toEqual({ a: 1 })
  })

  it('parses a text/event-stream body and takes the first result frame', async () => {
    mockFetchSequence([
      sseResponse([
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      ]),
    ])
    const { result } = await mcpRequest('https://x/mcp', '', 'tools/list', {})
    expect(result).toEqual({ tools: [] })
  })

  it('returns 202 Accepted as a null result (notification path)', async () => {
    mockFetchSequence([jsonResponse(null, { status: 202 })])
    const { result } = await mcpRequest('https://x/mcp', '', 'notifications/initialized', {})
    expect(result).toBeNull()
  })

  it('throws with the server message on a JSON-RPC error envelope', async () => {
    mockFetchSequence([
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }),
    ])
    await expect(mcpRequest('https://x/mcp', '', 'tools/list', {})).rejects.toThrow('nope')
  })

  it('throws on non-2xx HTTP with status and body excerpt', async () => {
    mockFetchSequence([jsonResponse({ code: 'InvalidApiKey' }, { status: 401 })])
    await expect(mcpRequest('https://x/mcp', '', 'tools/list', {})).rejects.toThrow(
      'HTTP 401',
    )
  })

  it('maps a fetch TypeError to the network/CORS hint', async () => {
    mockFetchSequence([new TypeError('Failed to fetch')])
    await expect(mcpRequest('https://x/mcp', '', 'tools/list', {})).rejects.toThrow(
      'CORS',
    )
  })
})

describe('mcpRequest session handling', () => {
  it('captures Mcp-Session-Id and sends Authorization + session on later calls', async () => {
    const calls = mockFetchSequence([
      jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { sessionId: 'sess-1' }),
      jsonResponse({ jsonrpc: '2.0', id: 2, result: { ok: true } }),
    ])
    const first = await mcpRequest('https://x/mcp', 'Bearer sk-a', 'initialize', {})
    expect(first.sessionId).toBe('sess-1')

    await mcpRequest('https://x/mcp', 'Bearer sk-a', 'tools/list', {}, first.sessionId)
    const headers = calls[1].init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-a')
    expect(headers['Mcp-Session-Id']).toBe('sess-1')
  })
})

describe('mcpListTools / mcpCallTool', () => {
  it('discovers tools, keeping name/description/inputSchema', async () => {
    mockFetchSequence([
      jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { sessionId: 's1' }),
      jsonResponse({ jsonrpc: '2.0', id: 2, result: null }, { status: 202 }),
      jsonResponse({
        jsonrpc: '2.0',
        id: 3,
        result: {
          tools: [
            {
              name: 'bailian_web_search',
              description: '搜索',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
            { name: '' }, // filtered out
          ],
        },
      }),
    ])
    const tools = await mcpListTools('https://x/mcp', 'Bearer sk-a')
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('bailian_web_search')
    expect(tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    })
  })

  it('mcpCallTool returns the raw tools/call result', async () => {
    mockFetchSequence([
      jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { sessionId: 's1' }),
      jsonResponse({ jsonrpc: '2.0', id: 2, result: null }, { status: 202 }),
      jsonResponse({
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: '搜索结果' }] },
      }),
    ])
    const result = await mcpCallTool('https://x/mcp', '', 'bailian_web_search', {
      query: '天气',
    })
    expect((result as any).content[0].text).toBe('搜索结果')
  })
})
