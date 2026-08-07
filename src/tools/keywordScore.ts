// keywordScore — pure query tokenization + field-weighted scoring for
// search_notes. Fixes the v1 "whole-string substring" weakness:
//   1. multi-token queries match ANY token (no more 0-hit full phrases);
//   2. hits are ranked by weighted fields instead of vault order;
//   3. short CJK tokens get a bigram fallback for near-miss recall.

/** Field weights for one exact token hit (basename matters most). */
export const FIELD_WEIGHTS = {
  basename: 3,
  tags: 2,
  headings: 2,
  path: 1,
  frontmatter: 1,
} as const

export type ScoreFields = Record<keyof typeof FIELD_WEIGHTS, string>

/**
 * Split a user query into lowercase tokens on whitespace and common CJK/ASCII
 * punctuation; empty fragments dropped, order-preserving dedup.
 */
export function tokenize(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of query.toLowerCase().split(/[\s,，。、；;：:！!？?（）()【】\[\]"'`|/\\]+/)) {
    const t = raw.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

const CJK_RE = /^[\u4e00-\u9fff]+$/

/**
 * Consecutive 2-char grams of a short (2–4 char) pure-CJK token — recall
 * fallback when the exact token misses. Longer tokens embed too many
 * spurious grams; non-CJK tokens have no bigram fallback.
 */
export function cjkBigrams(token: string): string[] {
  if (!CJK_RE.test(token) || token.length < 2 || token.length > 4) return []
  const grams: string[] = []
  for (let i = 0; i + 2 <= token.length; i++) grams.push(token.slice(i, i + 2))
  return grams
}

/** Pre-extracted field keys (avoids re-allocating the array per token). */
const FIELD_KEYS = Object.keys(FIELD_WEIGHTS) as Array<keyof ScoreFields>

/**
 * Score one note against query tokens. Per token: best (highest-weight)
 * matched field counts fully, each extra matched field +0.25; CJK bigram
 * fallback counts at half weight. All-token bonus: ×(1 + 0.25·(n−1)) when n
 * tokens matched. 0 = no token matched at all.
 */
export function scoreTokens(tokens: string[], fields: ScoreFields): number {
  let total = 0
  let matched = 0
  for (const tok of tokens) {
    let best = 0
    let bonus = 0
    for (const key of FIELD_KEYS) {
      if (!fields[key].includes(tok)) continue
      const w = FIELD_WEIGHTS[key]
      if (w > best) best = w
      else bonus += 0.25
    }
    if (best === 0) {
      for (const gram of cjkBigrams(tok)) {
        for (const key of FIELD_KEYS) {
          if (fields[key].includes(gram)) {
            const half = FIELD_WEIGHTS[key] * 0.5
            if (half > best) best = half
          }
        }
      }
    }
    if (best > 0) {
      matched += 1
      total += best + bonus
    }
  }
  if (matched > 1) total *= 1 + 0.25 * (matched - 1)
  return Math.round(total * 100) / 100
}
