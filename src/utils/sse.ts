// Minimal SSE line parser for `text/event-stream` responses, built on the
// WHATWG ReadableStream reader so it works in Obsidian's desktop (Chromium)
// and mobile (Capacitor WebView) environments alike — no Node streams.
//
// Yields each non-empty `data:` payload. Multi-line `data:` fields and
// non-`data` lines (event names, comments/heartbeats, ids) are handled per the
// SSE spec enough for OpenAI/Anthropic chat streams.
//
// Idle watchdog: mobile connections often die silently (no FIN, no error).
// Each `reader.read()` is raced against an idle timer; ANY arriving byte —
// including `:` heartbeat lines, since read() resolves before extractData
// runs — resets it. On expiry we throw a typed `LLMError('network', …)` so
// the error card gives a meaningful diagnosis. Importing errors.ts here is
// safe: errors.ts has no imports of its own, so no circular dependency.

import { LLMError } from '../core/llm/errors'

/**
 * Idle timeout (ms) for an SSE stream before we give up. Exported for tests.
 * 评审修复：60s → 120s——深度思考（reasoning）模型的首字节延迟经常超过
 * 60s，旧值会在模型「想」的时候误杀连接。
 */
export const SSE_IDLE_TIMEOUT_MS = 120_000

export interface ParseSSEOptions {
  /** Idle timeout in ms. Defaults to `SSE_IDLE_TIMEOUT_MS`. */
  idleMs?: number
}

/** Await one read() but reject if no byte arrives within `idleMs`. */
function readWithIdleWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new LLMError(
          'network',
          `响应长时间无数据（超过 ${Math.round(idleMs / 1000)}s），连接可能已中断，请重试`,
        ),
      )
    }, idleMs)
    reader.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export async function* parseSSE(
  response: Response,
  opts?: ParseSSEOptions,
): AsyncGenerator<string> {
  const body = response.body
  if (!body) return

  const idleMs = opts?.idleMs ?? SSE_IDLE_TIMEOUT_MS
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await readWithIdleWatchdog(reader, idleMs)
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Process every complete line currently in the buffer.
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '')
        buffer = buffer.slice(newlineIdx + 1)
        const payload = extractData(line)
        if (payload !== null) yield payload
      }
    }

    // Flush any trailing line left without a final newline.
    const rest = buffer.replace(/\r$/, '')
    const payload = extractData(rest)
    if (payload !== null) yield payload
  } finally {
    // 评审修复：收尾先 cancel() 再 releaseLock()。看门狗超时 / 消费方提前
    // 退出（generator.return）时，底层 fetch 连接还挂着——cancel() 才会真正
    // 释放它；对已读完（done）的流是 no-op。cancel 失败不影响 releaseLock。
    try {
      await reader.cancel()
    } catch {
      // ignore — 已关闭/已释放的 reader cancel 可能抛，收尾不容打断
    }
    reader.releaseLock()
  }
}

/** Return the `data:` payload for a line, or null if the line carries none. */
function extractData(line: string): string | null {
  if (line === '') return null // blank line = event boundary
  if (line.startsWith(':')) return null // comment / heartbeat
  if (line.startsWith('data:')) {
    const data = line.slice(5).replace(/^ /, '')
    return data.length > 0 ? data : null
  }
  return null // event:/id:/retry: etc. — not needed for chat streams
}
