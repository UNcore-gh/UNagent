// mcpTools — name sanitization, result text extraction, 20K truncation and
// error mapping. Network is faked at the fetch layer (mcpCallTool flow).

import { sanitizeNameSegment, toolNameFor, extractMcpText, makeMcpTool } from '../mcpTools'
import type { McpService } from '../../../settings/settings'
import type { ToolContext } from '../../agent/types'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

function mkService(over: Partial<McpService> = {}): McpService {
  return {
    id: 'mcp-abc123def',
    name: 'bailian-websearch',
    baseUrl: 'https://x/mcp',
    authHeader: 'Bearer sk-a',
    enabled: true,
    ...over,
  }
}

/** Enough fake Responses to satisfy initialize + notification + tools/call. */
function jsonRpc(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response
}

function accepted(): Response {
  return {
    ok: true,
    status: 202,
    headers: { get: () => null },
    text: async () => '',
  } as unknown as Response
}

const ctx = {} as ToolContext

describe('sanitizeNameSegment / toolNameFor', () => {
  it('keeps [a-zA-Z0-9_-] and collapses the rest into single underscores', () => {
    expect(sanitizeNameSegment('Web.Search/v2!')).toBe('Web_Search_v2')
    expect(sanitizeNameSegment('__a__b__')).toBe('a_b')
  })

  it('builds {service}__{tool} names', () => {
    expect(toolNameFor(mkService(), 'bailian_web_search')).toBe(
      'bailian-websearch__bailian_web_search',
    )
  })

  it('falls back to an id-derived segment for non-ascii service names', () => {
    const svc = mkService({ name: '百炼搜索' })
    expect(toolNameFor(svc, 'search')).toBe('svc_123def__search')
  })

  it('caps the full tool name at 64 schema-safe chars', () => {
    const svc = mkService({ name: 'service' })
    const name = toolNameFor(svc, 'x'.repeat(200))
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})

describe('extractMcpText', () => {
  it('joins text content items with newlines', () => {
    expect(
      extractMcpText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', url: 'ignored' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb')
  })

  it('falls back to JSON.stringify when there is no text content', () => {
    expect(extractMcpText({ structuredContent: { n: 1 } })).toBe(
      '{"structuredContent":{"n":1}}',
    )
  })
})

describe('makeMcpTool run', () => {
  it('carries the owning service id in metadata (追加87 agent-level switch)', () => {
    const tool = makeMcpTool(mkService({ id: 'mcp-websearch' }), {
      name: 'search',
    })
    expect(tool.metadata.mcpServiceId).toBe('mcp-websearch')
  })

  it('maps a successful call into ok/summary/text output', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonRpc({ protocolVersion: '2025-03-26' }))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        jsonRpc({ content: [{ type: 'text', text: '搜索结果正文' }] }),
      ) as unknown as typeof fetch

    const tool = makeMcpTool(mkService(), { name: 'bailian_web_search' })
    const res = await tool.run({ query: '天气' }, ctx)
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('完成')
    expect((res.output as any).text).toBe('搜索结果正文')
    expect((res.output as any).truncated).toBe(false)
  })

  it('truncates results over 20000 chars', async () => {
    const huge = 'x'.repeat(20_500)
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonRpc({}))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(jsonRpc({ content: [{ type: 'text', text: huge }] })) as unknown as typeof fetch

    const tool = makeMcpTool(mkService(), { name: 'search' })
    const res = await tool.run({}, ctx)
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('已截断')
    expect((res.output as any).text.length).toBe(20_000)
    expect((res.output as any).truncated).toBe(true)
  })

  it('reports isError results as failed tool runs', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonRpc({}))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        jsonRpc({ isError: true, content: [{ type: 'text', text: '查询配额用尽' }] }),
      ) as unknown as typeof fetch

    const tool = makeMcpTool(mkService(), { name: 'search' })
    const res = await tool.run({}, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('执行失败')
  })

  it('never throws — transport failures become failed results', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch

    const tool = makeMcpTool(mkService(), { name: 'search' })
    const res = await tool.run({}, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('调用失败')
  })
})
