// Task #7: context-window budget helpers — detect when a conversation is
// approaching the model's context limit, recognize context-length errors
// from the provider, and suggest the /compact command.

/**
 * Duck-typed view of core/llm/errors.ts's LLMError. We deliberately do NOT
 * import that class: a teammate is adding a 'context-length' code there and
 * importing would couple this module to whether that change has landed.
 * `name === 'LLMError'` + a `code` field is enough at runtime.
 */
interface LLMErrorLike {
  name?: string
  code?: string
  status?: number
  message?: string
}

/** Provider messages that indicate a context/token overflow. */
const CONTEXT_MSG_RE = /context|token.*limit|上下文/i

/** True when `used` reaches `ratio` of `window` (window ≤ 0 → unknown → false). */
export function nearLimit(used: number, window: number, ratio = 0.8): boolean {
  if (window <= 0) return false
  return used / window >= ratio
}

/**
 * Recognize a "context too long" failure from any thrown value:
 * - LLMError with code === 'context-length' (new dedicated code), OR
 * - LLMError with status 400 whose message matches the regex (legacy path),
 *   OR
 * - a plain Error whose message matches the regex.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as LLMErrorLike
  if (e.name === 'LLMError') {
    if (e.code === 'context-length') return true
    if (e.status === 400 && CONTEXT_MSG_RE.test(e.message ?? '')) return true
    return false
  }
  if (err instanceof Error) return CONTEXT_MSG_RE.test(err.message)
  return false
}

/** Human-readable hint, e.g. 「上下文已用约 82%，可发送 /compact 压缩」. */
export function compactHint(used: number, window: number): string {
  if (window <= 0) return '可发送 /compact 压缩上下文'
  const pct = Math.round((used / window) * 100)
  return `上下文已用约 ${pct}%，可发送 /compact 压缩`
}
