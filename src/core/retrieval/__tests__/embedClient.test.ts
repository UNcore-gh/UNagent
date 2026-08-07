// embedClient: OpenAI-compatible /embeddings over mocked global.fetch.
// Verifies URL shaping, auth header, index re-ordering, error mapping and
// EMBED_BATCH_SIZE batching.

import { embedBatch, embedTexts, EMBED_BATCH_SIZE } from '../embedClient'

const cfg = { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-test', model: 'emb-1' }

function mockJson(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response
}

describe('embedBatch', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('POSTs to {baseUrl}/embeddings with bearer auth and aligns by index', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init as RequestInit }
      // Server replies out of order — client must re-sort by index.
      return mockJson({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      })
    }) as typeof fetch

    const out = await embedBatch(cfg, ['a', 'b'])
    expect(captured!.url).toBe('https://api.example.com/v1/embeddings')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(captured!.init.body as string)
    expect(body).toEqual({ model: 'emb-1', input: ['a', 'b'] })
    expect(out).toHaveLength(2)
    expect(Array.from(out[0])).toEqual([1, 2])
    expect(Array.from(out[1])).toEqual([3, 4])
  })

  it('omits Authorization when the key is blank', async () => {
    let capturedHeaders: Record<string, string> = {}
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init as RequestInit).headers as Record<string, string>
      return mockJson({ data: [{ index: 0, embedding: [1] }] })
    }) as typeof fetch
    await embedBatch({ ...cfg, apiKey: '  ' }, ['a'])
    expect(capturedHeaders.Authorization).toBeUndefined()
  })

  it('maps 401/403 to a credentials error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })) as unknown as typeof fetch
    await expect(embedBatch(cfg, ['a'])).rejects.toThrow('凭据无效')
  })

  it('maps network TypeError to a connectivity/CORS error', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(embedBatch(cfg, ['a'])).rejects.toThrow('网络连接失败')
  })

  it('rejects when the vector count mismatches the input', async () => {
    global.fetch = jest.fn(async () =>
      mockJson({ data: [{ index: 0, embedding: [1] }] }),
    ) as typeof fetch
    await expect(embedBatch(cfg, ['a', 'b'])).rejects.toThrow('数量不匹配')
  })

  it('rejects on empty vectors and missing data array', async () => {
    global.fetch = jest.fn(async () =>
      mockJson({ data: [{ index: 0, embedding: [] }] }),
    ) as typeof fetch
    await expect(embedBatch(cfg, ['a'])).rejects.toThrow('空向量')

    global.fetch = jest.fn(async () => mockJson({})) as typeof fetch
    await expect(embedBatch(cfg, ['a'])).rejects.toThrow('data 数组')
  })
})

describe('embedTexts batching', () => {
  it('splits into batches of EMBED_BATCH_SIZE keeping input order', async () => {
    const calls: number[] = []
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit).body as string)
      calls.push(body.input.length)
      return mockJson({
        data: body.input.map((t: string, i: number) => ({
          index: i,
          embedding: [Number(t)],
        })),
      })
    }) as typeof fetch

    const texts = Array.from({ length: EMBED_BATCH_SIZE + 2 }, (_, i) => String(i))
    const out = await embedTexts(cfg, texts)
    expect(calls).toEqual([EMBED_BATCH_SIZE, 2])
    expect(out.map((v) => v[0])).toEqual(texts.map(Number))
  })
})
