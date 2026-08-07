// keywordScore: tokenization, CJK bigrams and field-weighted scoring —
// the recall/ranking fixes behind search_notes.

import { tokenize, cjkBigrams, scoreTokens, ScoreFields } from '../keywordScore'

const emptyFields = (over: Partial<ScoreFields> = {}): ScoreFields => ({
  basename: '',
  tags: '',
  headings: '',
  path: '',
  frontmatter: '',
  ...over,
})

describe('tokenize', () => {
  it('splits on whitespace and CJK/ASCII punctuation, lowercases, dedups', () => {
    expect(tokenize('Hello, 世界！ Test')).toEqual(['hello', '世界', 'test'])
    expect(tokenize('a、b；c（d）')).toEqual(['a', 'b', 'c', 'd'])
    expect(tokenize('dup dup DUP')).toEqual(['dup'])
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('cjkBigrams', () => {
  it('emits sliding bigrams for 2–4 char pure-CJK tokens', () => {
    expect(cjkBigrams('向量')).toEqual(['向量'])
    expect(cjkBigrams('语义检索')).toEqual(['语义', '义检', '检索'])
  })

  it('returns nothing for 1-char, >4-char or non-CJK tokens', () => {
    expect(cjkBigrams('我')).toEqual([])
    expect(cjkBigrams('语义检索啊')).toEqual([])
    expect(cjkBigrams('abcd')).toEqual([])
    expect(cjkBigrams('语a')).toEqual([])
  })
})

describe('scoreTokens', () => {
  it('weights basename highest (3) and returns 0 on total miss', () => {
    expect(scoreTokens(['alpha'], emptyFields({ basename: 'alpha' }))).toBe(3)
    expect(scoreTokens(['alpha'], emptyFields({ tags: 'alpha' }))).toBe(2)
    expect(scoreTokens(['alpha'], emptyFields({ path: 'alpha' }))).toBe(1)
    expect(scoreTokens(['zebra'], emptyFields({ basename: 'alpha' }))).toBe(0)
  })

  it('adds +0.25 per extra matched field for the same token', () => {
    const score = scoreTokens(['alpha'], emptyFields({ basename: 'alpha', tags: 'alpha' }))
    expect(score).toBe(3.25)
  })

  it('applies the multi-token bonus ×(1 + 0.25·(n−1))', () => {
    const single = scoreTokens(['alpha'], emptyFields({ basename: 'alpha beta' }))
    const both = scoreTokens(
      ['alpha', 'beta'],
      emptyFields({ basename: 'alpha beta' }),
    )
    expect(both).toBeCloseTo(single * 2 * 1.25, 5)
  })

  it('CJK bigram fallback counts at half field weight', () => {
    // '知识管理' never appears verbatim, but its bigram 知识 does — half
    // of the basename weight.
    const score = scoreTokens(['知识管理'], emptyFields({ basename: '管理我的知识' }))
    expect(score).toBe(1.5)
  })

  it('exact match outranks bigram fallback', () => {
    const exact = scoreTokens(['知识管理'], emptyFields({ basename: '知识管理系统' }))
    const bigram = scoreTokens(['知识管理'], emptyFields({ basename: '管理我的知识' }))
    expect(exact).toBeGreaterThan(bigram)
  })
})
