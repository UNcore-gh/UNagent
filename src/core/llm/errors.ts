// Typed LLM errors so the UI can render friendly, actionable messages
// (e.g. "please set your API key in settings") instead of raw stack traces.

export type LLMErrorCode =
  | 'api-key-missing'
  | 'api-key-invalid'
  | 'base-url-missing'
  | 'model-missing'
  | 'rate-limit'
  | 'quota'
  | 'context-length'
  | 'model-not-found'
  | 'network'
  | 'aborted'
  | 'http'
  | 'unknown'

export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly status?: number
  /** Full (untruncated) provider error body/message, for diagnosis. */
  readonly detail?: string

  constructor(
    code: LLMErrorCode,
    message: string,
    status?: number,
    detail?: string,
  ) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/** Map any thrown value to a user-facing Chinese message. */
export function friendlyMessage(err: unknown): string {
  if (err instanceof LLMError) return err.message
  if (err instanceof Error && err.name === 'AbortError') return '已停止'
  if (err instanceof Error && err.message) return err.message
  return '发生未知错误'
}

/** Structured error advice for a professional, diagnosable error card. */
export interface ErrorAdvice {
  code: LLMErrorCode
  title: string
  message: string
  suggestion?: string
  status?: number
  raw?: string
}

const ERROR_ADVICE: Record<LLMErrorCode, { title: string; suggestion?: string }> = {
  'api-key-missing': {
    title: '认证失败 · 未配置 API Key',
    suggestion: '请到「设置 → 模型」为该模型档案填写 API Key 后重试。',
  },
  'api-key-invalid': {
    title: '认证失败 · API Key 无效或已过期',
    suggestion: '请到「设置 → 模型」核对 API Key 是否正确、是否过期或被停用。',
  },
  'base-url-missing': {
    title: '配置缺失 · 未填写接口地址',
    suggestion: '请到「设置 → 模型」填写 Base URL（如 https://api.openai.com/v1）。',
  },
  'model-missing': {
    title: '配置缺失 · 未填写模型',
    suggestion: '请到「设置 → 模型」填写要使用的模型名。',
  },
  'rate-limit': {
    title: '请求受限（429）',
    suggestion: '请求过于频繁或额度用尽，请稍后重试，或检查账户余额与限额。',
  },
  quota: {
    title: '额度不足 · 免费额度已用尽',
    suggestion:
      '当前服务/实例的免费额度已耗尽。请在百炼控制台为该实例充值，或关闭「仅使用免费额度」模式后重试。',
  },
  'context-length': {
    title: '上下文超限 · 对话太长',
    suggestion:
      '当前对话加上系统提示已超过模型的上下文窗口。请发送 /compact 压缩上下文后重试，或开启新对话。',
  },
  'model-not-found': {
    title: '模型/接口不存在（404）',
    suggestion: '请核对模型名拼写，并确认 Base URL 与模型属于同一服务。',
  },
  'network': {
    title: '网络连接失败',
    suggestion: '请检查网络或代理设置，确认能访问服务地址后重试。',
  },
  aborted: { title: '已停止' },
  http: {
    title: '服务请求失败',
    suggestion: '请展开下方「详情」查看服务返回信息；可稍后重试，或更换模型/服务。',
  },
  unknown: {
    title: '发生未知错误',
    suggestion: '请稍后重试；若反复出现，请展开下方「详情」排查。',
  },
}

/** Describe any thrown value as a professional, diagnosable error card. */
export function describeError(err: unknown): ErrorAdvice {
  if (err instanceof LLMError) {
    const advice = ERROR_ADVICE[err.code] ?? ERROR_ADVICE.unknown
    return {
      code: err.code,
      title: advice.title,
      message: err.message,
      suggestion: advice.suggestion,
      status: err.status,
      raw: err.detail,
    }
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'aborted', title: '已停止', message: '已停止' }
  }
  const advice = ERROR_ADVICE.unknown
  const raw = err instanceof Error ? err.message : String(err)
  return {
    code: 'unknown',
    title: advice.title,
    message: raw,
    suggestion: advice.suggestion,
    raw,
  }
}
