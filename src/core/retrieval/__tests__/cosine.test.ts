// cosine: brute-force similarity + top-k ordering/filtering. Pure math.

import { cosineSim, topK } from '../cosine'

const f = (...xs: number[]): Float32Array => Float32Array.from(xs)

describe('cosineSim', () => {
  it('identical vectors score 1', () => {
    expect(cosineSim(f(1, 2, 3), f(1, 2, 3))).toBeCloseTo(1, 5)
  })

  it('orthogonal vectors score 0', () => {
    expect(cosineSim(f(1, 0), f(0, 1))).toBe(0)
  })

  it('opposite vectors score -1', () => {
    expect(cosineSim(f(1, 2), f(-1, -2))).toBeCloseTo(-1, 5)
  })

  it('degenerate input (empty / dim mismatch / zero norm) scores 0', () => {
    expect(cosineSim(f(), f())).toBe(0)
    expect(cosineSim(f(1, 2), f(1))).toBe(0)
    expect(cosineSim(f(0, 0), f(1, 1))).toBe(0)
  })

  it('is scale-invariant', () => {
    expect(cosineSim(f(1, 2), f(10, 20))).toBeCloseTo(1, 5)
  })
})

describe('topK', () => {
  const matrix = [f(1, 0), f(0.7, 0.7), f(0, 1), f(0, 0)]

  it('returns best-first and respects k', () => {
    const hits = topK(f(1, 0), matrix, 2)
    expect(hits.map((h) => h.index)).toEqual([0, 1])
    expect(hits[0].score).toBeCloseTo(1, 5)
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it('filters zero-score rows (degenerate / orthogonal)', () => {
    const hits = topK(f(1, 0), matrix, 10)
    // row 3 is zero-norm (score 0); row 2 is orthogonal (score 0).
    expect(hits.map((h) => h.index)).toEqual([0, 1])
  })

  it('handles empty matrix and k=0', () => {
    expect(topK(f(1, 0), [], 5)).toEqual([])
    expect(topK(f(1, 0), matrix, 0)).toEqual([])
  })
})
