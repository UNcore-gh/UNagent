// Token-estimation helpers behind the header's context-usage chip: a
// deliberately rough CJK-aware estimate (no tiktoken — mobile), message
// sums with per-message overhead, and the compact "1.2k" formatter.

import {
  MSG_OVERHEAD,
  SYSTEM_PROMPT_OVERHEAD,
  estimateMessagesTokens,
  estimateTokens,
  formatTokens,
} from '../tokens'

describe('estimateTokens', () => {
  it('counts CJK characters at ~1 token each', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('counts ASCII at ~4 chars per token, rounded up', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars → ceil(12/4)
    expect(estimateTokens('abc')).toBe(1)
  })

  it('mixes both scripts in one text', () => {
    // 'ab' → ceil(2/4) = 1 ; '中文' → 2 ; total 3
    expect(estimateTokens('ab中文')).toBe(3)
  })

  it('is zero for empty or missing text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens(undefined as unknown as string)).toBe(0)
  })
})

describe('estimateMessagesTokens', () => {
  it('adds the per-message overhead to every text', () => {
    expect(estimateMessagesTokens(['你好', '世界'])).toBe(
      2 + MSG_OVERHEAD + (2 + MSG_OVERHEAD),
    )
  })

  it('is zero for an empty list', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })
})

describe('formatTokens', () => {
  it('keeps small counts raw', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(487)).toBe('487')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses one decimal under 10k, dropping a trailing .0', () => {
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2000)).toBe('2k')
  })

  it('rounds to whole k from 10k up', () => {
    expect(formatTokens(15_400)).toBe('15k')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(1_000_000)).toBe('1000k')
  })

  it('clamps nonsense to zero', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('overhead constants', () => {
  it('ship sane positive budgets', () => {
    expect(MSG_OVERHEAD).toBeGreaterThan(0)
    expect(SYSTEM_PROMPT_OVERHEAD).toBeGreaterThan(0)
  })
})
