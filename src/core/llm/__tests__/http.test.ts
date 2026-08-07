// fetchStream resilience (Task #3): connection timeout, bounded retries that
// only happen BEFORE any usable Response escapes, Retry-After backoff,
// external-abort precedence, and 400 → context-length classification.

import { fetchStream, CONNECT_TIMEOUT_MS } from '../http'
import { LLMError, describeError } from '../errors'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** Feed fetch a sequence of responses/errors (last entry repeats). */
function mockFetchSequence(results: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  global.fetch = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init: init as RequestInit })
    const next = results[Math.min(calls.length - 1, results.length - 1)]
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return calls
}

const recordSleep = () => jest.fn(async (_ms: number) => {})

describe('fetchStream retries', () => {
  it('succeeds after a single 429 with 1s backoff', async () => {
    const calls = mockFetchSequence([
      jsonResponse(429, { error: { message: 'slow down' } }),
      jsonResponse(200, { ok: 1 }),
    ])
    const sleep = recordSleep()
    const res = await fetchStream('https://x', {}, undefined, { sleep })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(1_000)
  })

  it('succeeds after two network TypeErrors with 1s→2s backoff', async () => {
    const calls = mockFetchSequence([
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
      jsonResponse(200, { ok: 1 }),
    ])
    const sleep = recordSleep()
    const res = await fetchStream('https://x', {}, undefined, { sleep })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 2_000])
  })

  it('retries: 0 throws immediately on 429 (legacy immediate-fail behavior)', async () => {
    const calls = mockFetchSequence([
      jsonResponse(429, { error: { message: 'rate limited' } }),
    ])
    const sleep = recordSleep()
    await expect(
      fetchStream('https://x', {}, undefined, { retries: 0, sleep }),
    ).rejects.toMatchObject({ code: 'rate-limit' })
    expect(calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries: 0 throws immediately on network failure', async () => {
    const calls = mockFetchSequence([new TypeError('Failed to fetch')])
    const sleep = recordSleep()
    await expect(
      fetchStream('https://x', {}, undefined, { retries: 0, sleep }),
    ).rejects.toMatchObject({ code: 'network' })
    expect(calls).toHaveLength(1)
  })

  it('honors Retry-After seconds on 429', async () => {
    mockFetchSequence([
      jsonResponse(429, {}, { 'Retry-After': '3' }),
      jsonResponse(200, { ok: 1 }),
    ])
    const sleep = recordSleep()
    await fetchStream('https://x', {}, undefined, { sleep })
    expect(sleep).toHaveBeenCalledWith(3_000)
  })

  it('caps Retry-After at 5s', async () => {
    mockFetchSequence([
      jsonResponse(429, {}, { 'Retry-After': '120' }),
      jsonResponse(200, { ok: 1 }),
    ])
    const sleep = recordSleep()
    await fetchStream('https://x', {}, undefined, { sleep })
    expect(sleep).toHaveBeenCalledWith(5_000)
  })

  it('retries 5xx, then surfaces the http error after exhausting retries', async () => {
    const calls = mockFetchSequence([
      jsonResponse(503, { error: 'unavailable' }),
      jsonResponse(503, { error: 'unavailable' }),
      jsonResponse(503, { error: 'unavailable' }),
    ])
    const sleep = recordSleep()
    await expect(
      fetchStream('https://x', {}, undefined, { sleep }),
    ).rejects.toMatchObject({ code: 'http', status: 503 })
    expect(calls).toHaveLength(3) // 1 + DEFAULT_RETRIES(2)
  })

  it('does not retry non-retryable statuses (401)', async () => {
    const calls = mockFetchSequence([jsonResponse(401, { error: 'bad key' })])
    const sleep = recordSleep()
    await expect(
      fetchStream('https://x', {}, undefined, { sleep }),
    ).rejects.toMatchObject({ code: 'api-key-invalid' })
    expect(calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('throws aborted when the signal is already aborted', async () => {
    const calls = mockFetchSequence([jsonResponse(200, {})])
    const ac = new AbortController()
    ac.abort()
    await expect(fetchStream('https://x', {}, ac.signal)).rejects.toMatchObject({
      code: 'aborted',
    })
    expect(calls).toHaveLength(0)
  })

  it('abort during retry backoff rejects immediately (sleep is interruptible)', async () => {
    // 评审修复回归：退避 sleep 期间用户点停止——不得干等完整退避（最坏 5s），
    // abort 立即穿透 sleep，落到循环顶部的 aborted 判定。
    mockFetchSequence([
      jsonResponse(429, { error: { message: 'slow down' } }),
      jsonResponse(200, { ok: 1 }),
    ])
    // 注入一个永不 resolve 的 sleep：若 abort 穿不透它，请求会永远挂着。
    const sleep = jest.fn(() => new Promise<void>(() => {}))
    const ac = new AbortController()
    const p = fetchStream('https://x', {}, ac.signal, { sleep })
    p.catch(() => {})
    // 让第一次 fetch（429）跑完、进入退避 sleep（微任务冲刷至 sleep 被调用）。
    for (let i = 0; i < 20 && sleep.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(sleep).toHaveBeenCalledTimes(1)
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    // 退避被打断：没有第二次 fetch。
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('connection timeout', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** fetch that hangs until its signal aborts (like a dead connection). */
  function hangUntilAbort() {
    global.fetch = jest.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('abort')),
          )
        }),
    ) as unknown as typeof fetch
  }

  it('aborts with a network timeout after CONNECT_TIMEOUT_MS', async () => {
    hangUntilAbort()
    const p = fetchStream('https://x', {}, undefined, { retries: 0 })
    p.catch(() => {})
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
    const err: LLMError = await p.then(
      () => {
        throw new Error('should have timed out')
      },
      (e) => e,
    )
    expect(err.code).toBe('network')
    expect(err.message).toContain('连接超时')
  })

  it('external abort takes precedence over the timeout', async () => {
    hangUntilAbort()
    const ac = new AbortController()
    const p = fetchStream('https://x', {}, ac.signal, { retries: 0 })
    p.catch(() => {})
    await jest.advanceTimersByTimeAsync(5_000)
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('context-length classification', () => {
  it('maps a 400 mentioning maximum context length to context-length', async () => {
    mockFetchSequence([
      jsonResponse(400, {
        error: {
          message:
            "This model's maximum context length is 8192 tokens. However, you requested 12000 tokens.",
        },
      }),
    ])
    const err: LLMError = await fetchStream('https://x', {}, undefined, {
      retries: 0,
    }).then(
      () => {
        throw new Error('should have thrown')
      },
      (e) => e,
    )
    expect(err.code).toBe('context-length')
    expect(err.status).toBe(400)
    expect(err.message).toContain('/compact')
    expect(err.detail).toContain('maximum context length')
  })

  it('matches Chinese 上下文 wording too', async () => {
    mockFetchSequence([jsonResponse(400, { message: '输入内容过长，超出上下文限制' })])
    await expect(
      fetchStream('https://x', {}, undefined, { retries: 0 }),
    ).rejects.toMatchObject({ code: 'context-length' })
  })

  it('still classifies a tool-related 400 as http (context check runs first but misses)', async () => {
    mockFetchSequence([
      jsonResponse(400, { error: { message: 'unsupported tool call' } }),
    ])
    await expect(
      fetchStream('https://x', {}, undefined, { retries: 0 }),
    ).rejects.toMatchObject({ code: 'http' })
  })

  it('describeError exposes the /compact advice for context-length', () => {
    const advice = describeError(new LLMError('context-length', 'm'))
    expect(advice.code).toBe('context-length')
    expect(advice.title).toContain('上下文超限')
    expect(advice.suggestion).toContain('/compact')
  })
})
