// Task #7: contextBudget — nearLimit / isContextLengthError / compactHint.

import { LLMError } from '../../core/llm/errors'
import {
  compactHint,
  isContextLengthError,
  nearLimit,
} from '../contextBudget'

describe('nearLimit', () => {
  it('fires at and above the default 0.8 ratio', () => {
    expect(nearLimit(8000, 10000)).toBe(true)
    expect(nearLimit(9500, 10000)).toBe(true)
    expect(nearLimit(7999, 10000)).toBe(false)
  })

  it('respects a custom ratio', () => {
    expect(nearLimit(500, 1000, 0.5)).toBe(true)
    expect(nearLimit(499, 1000, 0.5)).toBe(false)
  })

  it('returns false when the window is unknown (<= 0)', () => {
    expect(nearLimit(12345, 0)).toBe(false)
    expect(nearLimit(12345, -1)).toBe(false)
  })

  it('handles zero usage', () => {
    expect(nearLimit(0, 10000)).toBe(false)
  })
})

describe('isContextLengthError', () => {
  it("accepts an LLMError with code 'context-length'", () => {
    // The code union is being extended by a parallel change; duck-type it.
    const err = Object.assign(new Error('anything'), {
      name: 'LLMError',
      code: 'context-length',
    })
    expect(isContextLengthError(err)).toBe(true)
  })

  it('accepts a real LLMError with status 400 + context message', () => {
    expect(
      isContextLengthError(
        new LLMError('http', 'This model maximum context length is 8192 tokens', 400),
      ),
    ).toBe(true)
    expect(isContextLengthError(new LLMError('http', '请求超出上下文限制', 400))).toBe(
      true,
    )
  })

  it('rejects an LLMError whose status/message do not match', () => {
    expect(isContextLengthError(new LLMError('http', 'bad request', 400))).toBe(false)
    expect(
      isContextLengthError(new LLMError('http', 'context overflow', 500)),
    ).toBe(false)
    expect(isContextLengthError(new LLMError('rate-limit', 'slow down', 429))).toBe(
      false,
    )
  })

  it('accepts a plain Error via the message regex', () => {
    expect(isContextLengthError(new Error('maximum context length exceeded'))).toBe(true)
    expect(isContextLengthError(new Error('token limit reached'))).toBe(true)
    expect(isContextLengthError(new Error('上下文过长'))).toBe(true)
  })

  it('rejects unrelated errors and non-object throws', () => {
    expect(isContextLengthError(new Error('network timeout'))).toBe(false)
    expect(isContextLengthError('context')).toBe(false)
    expect(isContextLengthError(null)).toBe(false)
    expect(isContextLengthError(undefined)).toBe(false)
    expect(isContextLengthError({ message: 'context' })).toBe(false) // not Error, not LLMError
  })
})

describe('compactHint', () => {
  it('reports the rounded usage percentage', () => {
    expect(compactHint(8200, 10000)).toBe('上下文已用约 82%，可发送 /compact 压缩')
    expect(compactHint(9960, 10000)).toBe('上下文已用约 100%，可发送 /compact 压缩')
    expect(compactHint(0, 10000)).toBe('上下文已用约 0%，可发送 /compact 压缩')
  })

  it('falls back to a plain hint when the window is unknown', () => {
    expect(compactHint(100, 0)).toBe('可发送 /compact 压缩上下文')
  })
})
