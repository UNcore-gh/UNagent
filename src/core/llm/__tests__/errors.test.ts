// Structured error description (追加⑱ 补刀): every error maps to a
// professional card — category title + actionable suggestion + raw provider
// detail — so the user can diagnose WHERE a request failed, not just see a
// bare red box.

import { LLMError, describeError, friendlyMessage } from '../errors'

describe('friendlyMessage', () => {
  it('returns the LLMError message', () => {
    expect(friendlyMessage(new LLMError('network', '网络连接失败'))).toBe(
      '网络连接失败',
    )
  })

  it('maps an abort to 已停止', () => {
    const e = new Error('x')
    e.name = 'AbortError'
    expect(friendlyMessage(e)).toBe('已停止')
  })
})

describe('describeError', () => {
  it('maps a typed LLMError to title + suggestion + status + raw', () => {
    const advice = describeError(
      new LLMError('api-key-invalid', 'API Key 无效（401）', 401, 'raw body'),
    )
    expect(advice.code).toBe('api-key-invalid')
    expect(advice.title).toContain('认证失败')
    expect(advice.suggestion).toContain('API Key')
    expect(advice.status).toBe(401)
    expect(advice.raw).toBe('raw body')
    expect(advice.message).toBe('API Key 无效（401）')
  })

  it('gives every error code a non-empty title', () => {
    const codes = [
      'api-key-missing',
      'api-key-invalid',
      'base-url-missing',
      'model-missing',
      'rate-limit',
      'context-length',
      'model-not-found',
      'network',
      'http',
      'unknown',
    ] as const
    for (const code of codes) {
      expect(describeError(new LLMError(code, 'm')).title).toBeTruthy()
    }
  })

  it('maps an unknown Error to an unknown card with raw detail', () => {
    const advice = describeError(new Error('boom'))
    expect(advice.code).toBe('unknown')
    expect(advice.raw).toBe('boom')
    expect(advice.suggestion).toBeTruthy()
  })

  it('maps an abort to 已停止 without a suggestion', () => {
    const e = new Error('x')
    e.name = 'AbortError'
    expect(describeError(e).title).toBe('已停止')
  })
})
