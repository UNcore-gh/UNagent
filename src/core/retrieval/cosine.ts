// cosine — brute-force cosine similarity + top-k over a vector matrix.
//
// 个人库规模（数千~数万块）下暴力点积是毫秒级，不需要 ANN 索引；
// Float32Array 点积走引擎优化的数值循环，纯函数可测。

export interface TopKHit {
  index: number
  score: number
}

/** Cosine similarity of two equal-length vectors; 0 on degenerate input. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Top-k indices of `matrix` rows most similar to `query`, best first.
 * Rows shorter than the query (dimension drift mid-rebuild) score 0.
 */
export function topK(
  query: Float32Array,
  matrix: Float32Array[],
  k: number,
): TopKHit[] {
  const hits: TopKHit[] = []
  for (let i = 0; i < matrix.length; i++) {
    const score = cosineSim(query, matrix[i])
    if (score > 0) hits.push({ index: i, score })
  }
  hits.sort((x, y) => y.score - x.score)
  return hits.slice(0, k)
}
