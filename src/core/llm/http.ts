// Shared fetch wrapper: performs the request and, on a non-2xx response,
// converts the provider's error envelope into a typed `LLMError` with a
// friendly Chinese message. On success it returns the raw streaming Response
// for the caller to hand to `parseSSE`.
//
// Weak-network resilience (mobile-first):
// - Connection timeout (manual setTimeout — AbortSignal.timeout is not
//   available in older mobile WebViews).
// - Bounded retries BEFORE any usable Response is returned, i.e. before the
//   stream has produced anything: fetch TypeError (network), HTTP 429 and
//   HTTP 5xx only. Once this function returns a Response the stream is owned
//   by the caller and is never retried here (structural guarantee: every
//   retry path lives inside the attempt loop below, which exits on success).

import { LLMError } from './errors'
import { dlog } from '../../utils/diagnosticLog'

/** Metadata-only host extraction for the diagnostic log (never the key). */
function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '?'
  }
}

/** Connection establishment timeout (ms). Exported for tests. */
export const CONNECT_TIMEOUT_MS = 30_000
/** Default retry count for transient failures (429 / 5xx / network). */
export const DEFAULT_RETRIES = 2
/** Backoff schedule (ms) between retry attempts: 1s → 2s. */
export const RETRY_BACKOFF_MS = [1_000, 2_000]
/** Cap applied to Retry-After headers (s). */
export const RETRY_AFTER_CAP_S = 5

export interface FetchStreamOptions {
  /** Retry count for transient failures. Defaults to `DEFAULT_RETRIES`. */
  retries?: number
  /** Injectable sleep for backoff (tests use fake timers instead). */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

/** Seconds to wait from a Retry-After header, capped at RETRY_AFTER_CAP_S. */
function retryAfterMs(response: Response): number | null {
  let header: string | null = null
  try {
    header = response.headers.get('Retry-After')
  } catch {
    header = null
  }
  if (!header) return null
  const seconds = Number(header.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.min(seconds, RETRY_AFTER_CAP_S) * 1000
}

export async function fetchStream(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  opts?: FetchStreamOptions,
): Promise<Response> {
  const retries = opts?.retries ?? DEFAULT_RETRIES
  const sleep = opts?.sleep ?? defaultSleep
  // Diagnostic metadata (opt-in log, no-op when disabled): host + elapsed.
  const host = urlHost(url)
  const startedAt = Date.now()

  // 评审修复：退避 sleep 必须能被外部 abort 穿透——用户点「停止」时不该
  // 干等最长 5s 退避。signal abort 后立即 resolve，让循环顶部的 aborted 判定
  // 抛出 '已停止'。无 signal 时保持原行为（可注入 sleep 原样透传）。
  const interruptibleSleep = async (ms: number): Promise<void> => {
    if (!signal) {
      await sleep(ms)
      return
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort)
      const done = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      void sleep(ms).then(done, done)
    })
  }

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      throw new LLMError('aborted', '已停止')
    }

    // Inner controller: external abort and connection timeout both route
    // through it so fetch always has a single signal to observe.
    const controller = new AbortController()
    let timedOut = false
    const onExternalAbort = () => controller.abort()
    signal?.addEventListener('abort', onExternalAbort)
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CONNECT_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, { ...init, signal: controller.signal })
    } catch (err) {
      // External abort takes precedence over everything, incl. timeout.
      if (signal?.aborted) {
        throw new LLMError('aborted', '已停止')
      }
      dlog(
        'warn',
        'llm',
        `fetch failed host=${host} attempt=${attempt} ${timedOut ? 'timeout' : 'network-error'}`,
      )
      if (timedOut) {
        throw new LLMError(
          'network',
          `连接超时（${CONNECT_TIMEOUT_MS / 1000}s），请检查网络后重试`,
        )
      }
      // CORS 拦截在浏览器 fetch 里同样表现为 TypeError（Failed to fetch）——
      // 部分服务商只对 chat 端点开放跨域、图片/嵌入端点未开，容易误判为网络故障。
      if (err instanceof TypeError && attempt < retries) {
        await interruptibleSleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)])
        continue
      }
      throw new LLMError(
        'network',
        '网络连接失败，请检查网络或代理设置；若接口未开启跨域访问（CORS），也会出现此错误',
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }

    // Retryable HTTP statuses — only here, before any Response escapes, so a
    // stream that already started delivering content can never be replayed.
    const retryableStatus =
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599)
    if (!response.ok && retryableStatus && attempt < retries) {
      if (signal?.aborted) {
        throw new LLMError('aborted', '已停止')
      }
      dlog(
        'warn',
        'llm',
        `retry host=${host} status=${response.status} attempt=${attempt}`,
      )
      const fromHeader = retryAfterMs(response)
      const backoff =
        response.status === 429 && fromHeader !== null
          ? fromHeader
          : RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]
      // Drain/cancel the error body so the socket is released before retry.
      try {
        response.body?.cancel()
      } catch {
        // ignore
      }
      await interruptibleSleep(backoff)
      continue
    }

    if (!response.ok) {
      dlog('error', 'llm', `http ${response.status} host=${host}`)
      await throwHttpError(response)
    }
    dlog(
      'info',
      'llm',
      `ok host=${host} status=${response.status} elapsed=${Date.now() - startedAt}ms`,
    )
    return response
  }
}

async function throwHttpError(response: Response): Promise<never> {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    // ignore body read failures
  }

  // Provider error envelopes differ; try common shapes, fall back to raw text.
  let message = bodyText.trim()
  let parsed: any = null
  try {
    parsed = JSON.parse(bodyText)
    message =
      parsed?.error?.message ??
      parsed?.message ??
      parsed?.error ??
      message
  } catch {
    // not JSON — keep raw text
  }

  // Quota exhaustion is a distinct, common case (esp. 百炼 free tier). It's
  // often returned as a 403 with an `insufficient_quota` code/type — surfacing
  // it as "API Key 无效" would mislead the user into debugging the wrong thing.
  const quotaLike =
    /insufficient_quota|quota|额度|余额|free tier|exhausted/i.test(message) ||
    /insufficient_quota|quota/i.test(parsed?.error?.code ?? '') ||
    /insufficient_quota|quota/i.test(parsed?.code ?? '')

  const status = response.status
  if (quotaLike) {
    throw new LLMError('quota', message || '额度不足，请检查账户余额或免费额度。', status, message)
  }
  switch (status) {
    case 400: {
      // Context overflow is the most actionable 400 — the user can compact
      // the conversation. Must be checked before the tool-related heuristic.
      const contextLike =
        /context length|maximum context|too many tokens|token.*limit|上下文/i.test(message)
      if (contextLike) {
        throw new LLMError(
          'context-length',
          `上下文超出模型限制，请发送 /compact 压缩上下文后重试，或开启新对话。${
            truncate(message, 120) ? `（${truncate(message, 120)}）` : ''
          }`,
          status,
          message,
        )
      }
      // A 400 mentioning tools/functions almost always means the model (or a
      // proxy) doesn't support function calling — the most actionable hint.
      const toolRelated = /tool|function[ _]?call/i.test(message)
      const detail = truncate(message, 200)
      throw new LLMError(
        'http',
        toolRelated
          ? `该模型或服务可能不支持工具调用（function calling），请更换支持工具的模型。${detail ? `（${detail}）` : ''}`
          : `请求被拒绝（400）${detail ? `：${detail}` : ''}`,
        status,
        message,
      )
    }
    case 401:
      throw new LLMError(
        'api-key-invalid',
        message || 'API Key 无效或已过期（401）',
        status,
        message,
      )
    case 403:
      throw new LLMError(
        'api-key-invalid',
        message || '无访问权限（403）',
        status,
        message,
      )
    case 404:
      throw new LLMError(
        'model-not-found',
        message || '模型或接口不存在，请检查模型名与 Base URL（404）',
        status,
        message,
      )
    case 429:
      throw new LLMError(
        'rate-limit',
        message || '请求过于频繁或额度用尽，请稍后再试（429）',
        status,
        message,
      )
    default:
      throw new LLMError('http', message || `请求失败（${status}）`, status, message)
  }
}
