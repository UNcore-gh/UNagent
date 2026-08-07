// Cheap token estimation for the header's context-usage chip (追加⑯).
// No tiktoken (bundle weight, mobile) — CJK characters count ~1 token each,
// other text ~4 chars per token. Deliberately rough: the chip only signals
// how full the window is, it is not a bill.

/** CJK radicals → unified ideographs (incl. kana / hangul / CJK punct). */
const CJK_RE = /[⺀-﹏]/g

/**
 * Estimated token count of one text: CJK characters at ~1 token each,
 * everything else at ~1/4 token per character (rounded up).
 */
export function estimateTokens(text: string): number {
  const t = text ?? ''
  const cjk = (t.match(CJK_RE) ?? []).length
  const rest = t.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/** Per-message framing overhead (role + delimiters) — the OpenAI cookbook
 *  rule of thumb, added once per message on top of the content estimate. */
export const MSG_OVERHEAD = 4

/**
 * The system prompt (tool schemas + skills + memory snapshot) eats a chunk
 * of the window before any message does. A fixed budget keeps the chip
 * honest without shipping a prompt-size model.
 */
export const SYSTEM_PROMPT_OVERHEAD = 800

/** Estimated token sum over a list of message texts (content only — the
 *  caller skips ephemeral asides, which never enter the context). */
export function estimateMessagesTokens(texts: string[]): number {
  let total = 0
  for (const t of texts) total += estimateTokens(t) + MSG_OVERHEAD
  return total
}

/** Human formatting for the chip: 487, 1.2k, 15k — little room up there. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) {
    const s = (n / 1000).toFixed(1)
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'k'
  }
  return `${Math.round(n / 1000)}k`
}
