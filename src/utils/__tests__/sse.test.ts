// parseSSE (Task #3): idle watchdog behavior + basic parsing regression.
// Uses a hand-rolled controllable reader so we can hold read() pending and
// let fake timers expire the watchdog at exact moments.

import { parseSSE, SSE_IDLE_TIMEOUT_MS } from '../sse'
import { LLMError } from '../../core/llm/errors'

type ReadResult = { done: boolean; value?: Uint8Array }

class Deferred<T> {
  promise: Promise<T>
  resolve!: (v: T) => void
  reject!: (e: unknown) => void
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res
      this.reject = rej
    })
  }
}

function fakeResponse() {
  const reads: Array<Deferred<ReadResult>> = []
  const releaseLock = jest.fn()
  const cancel = jest.fn(async () => {})
  const reader = {
    read: () => {
      const d = new Deferred<ReadResult>()
      reads.push(d)
      return d.promise
    },
    releaseLock,
    cancel,
  }
  const response = { body: { getReader: () => reader } } as unknown as Response
  return { reads, releaseLock, cancel, response }
}

const enc = new TextEncoder()

async function collect(
  gen: AsyncGenerator<string>,
): Promise<{ values: string[]; error?: unknown }> {
  const values: string[] = []
  try {
    for (;;) {
      const { done, value } = await gen.next()
      if (done) break
      values.push(value)
    }
  } catch (error) {
    return { values, error }
  }
  return { values }
}

describe('parseSSE idle watchdog', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('throws a typed network LLMError when no byte arrives within idleMs', async () => {
    const { response, releaseLock, cancel } = fakeResponse()
    const gen = parseSSE(response, { idleMs: 1_000 })
    const settled = collect(gen)
    await jest.advanceTimersByTimeAsync(1_001)
    const { error } = await settled
    expect(error).toBeInstanceOf(LLMError)
    expect((error as LLMError).code).toBe('network')
    expect((error as LLMError).message).toContain('无数据')
    // Watchdog expiry must release the underlying connection (cancel) and
    // then release the reader (finally path).
    expect(cancel).toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalled()
  })

  it('defaults the idle timeout to SSE_IDLE_TIMEOUT_MS (120s)', async () => {
    // 评审修复：60s → 120s，深度思考模型首字节可能 >60s。
    expect(SSE_IDLE_TIMEOUT_MS).toBe(120_000)
    const { response } = fakeResponse()
    const gen = parseSSE(response)
    const settled = collect(gen)
    await jest.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS - 10)
    let rejected = false
    settled.then(({ error }) => {
      rejected = error !== undefined
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(rejected).toBe(false)
    await jest.advanceTimersByTimeAsync(11)
    const { error } = await settled
    expect((error as LLMError).code).toBe('network')
  })

  it('any byte — including a `:` heartbeat — resets the idle timer', async () => {
    const { reads, response } = fakeResponse()
    const gen = parseSSE(response, { idleMs: 1_000 })
    const next = gen.next()
    // At t=800ms a heartbeat arrives — total elapsed already exceeds half
    // the window; without a reset the timer armed at t=0 would fire at 1s.
    await jest.advanceTimersByTimeAsync(800)
    reads[0].resolve({ done: false, value: enc.encode(':heartbeat\n') })
    await jest.advanceTimersByTimeAsync(0) // flush microtasks, arm read #2
    expect(reads).toHaveLength(2)
    // t=1600ms: 800ms since the heartbeat — still under the 1s window.
    await jest.advanceTimersByTimeAsync(800)
    reads[1].resolve({ done: false, value: enc.encode('data: hello\n') })
    await jest.advanceTimersByTimeAsync(0)
    await expect(next).resolves.toEqual({ done: false, value: 'hello' })
    // Generator is suspended at the yield — no watchdog timer left armed.
    await gen.return(undefined)
  })
})

describe('parseSSE parsing (regression)', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('yields data payloads across chunk boundaries and skips heartbeats', async () => {
    const { reads, response } = fakeResponse()
    const gen = parseSSE(response, { idleMs: 60_000 })
    const settled = collect(gen)
    // Split "data: abc" across two chunks; throw in a comment line.
    await jest.advanceTimersByTimeAsync(0)
    reads[0].resolve({ done: false, value: enc.encode('data: ab') })
    await jest.advanceTimersByTimeAsync(0)
    reads[1].resolve({ done: false, value: enc.encode('c\ndata: x\n:ping\n') })
    await jest.advanceTimersByTimeAsync(0)
    // Trailing line without a final newline is flushed on done.
    reads[2].resolve({ done: false, value: enc.encode('data: last') })
    await jest.advanceTimersByTimeAsync(0)
    reads[3].resolve({ done: true })
    const { values, error } = await settled
    expect(error).toBeUndefined()
    expect(values).toEqual(['abc', 'x', 'last'])
  })

  it('calls reader.cancel() on normal completion before releasing the lock', async () => {
    // 评审修复回归：收尾 cancel() 对已读完的流是 no-op，但必须被调用
    //（看门狗超时 / 提前退出时它才真正释放底层连接）。
    const { reads, response, cancel, releaseLock } = fakeResponse()
    const gen = parseSSE(response, { idleMs: 60_000 })
    const settled = collect(gen)
    await jest.advanceTimersByTimeAsync(0)
    reads[0].resolve({ done: false, value: enc.encode('data: hi\n') })
    await jest.advanceTimersByTimeAsync(0)
    reads[1].resolve({ done: true })
    const { values, error } = await settled
    expect(error).toBeUndefined()
    expect(values).toEqual(['hi'])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('returns immediately for a response without a body', async () => {
    const response = { body: null } as unknown as Response
    const { values, error } = await collect(parseSSE(response))
    expect(values).toEqual([])
    expect(error).toBeUndefined()
  })
})
