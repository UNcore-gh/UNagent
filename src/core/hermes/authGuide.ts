// M2-T3 首次认证引导：hermes 未配置任何 provider 凭据时给用户出路。
// 本模块全部为纯函数（auth_methods 解析 / 无凭据判定 / 指引文案构造），
// 由 acpConnection（initialize 解析处）、Hermes 设置选项卡与 useAgent 的
// 失败提示共用。
//
// 红线：指引端点唯一合法来源是设置项 localAgent.guidedEndpoint（M3 托管
// 端点预留）——本模块与任何调用方都**不得硬编码 URL**，buildAuthGuideText
// 只消费传入的端点字符串。
//
// 与 M2-T6 三分类的关系：这是叠加在 not_installed / launch_failed 之上的
// 进一步提示（连接失败但「看起来是缺凭据」→ 附配置指引），不改写三分类。

import type { AcpAuthMethod } from './types'

/** hermes 恒通告的「终端交互式配置」auth method id
 *  （hermes 侧 acp_adapter/auth.py 的 TERMINAL_SETUP_AUTH_METHOD_ID）。
 *  它只是「去配置」入口，不代表已有凭据。 */
export const HERMES_SETUP_AUTH_METHOD_ID = 'hermes-setup'

/**
 * 宽容解析 initialize 响应的 authMethods：只保留有字符串 id 的对象条目，
 * 其余噪声丢弃。老版 hermes 不带此字段（undefined）→ 返回空数组，
 * 调用方据此区分「未知」与「明确无凭据」。
 */
export function parseAuthMethods(raw: unknown): AcpAuthMethod[] {
  if (!Array.isArray(raw)) return []
  const out: AcpAuthMethod[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || !rec.id) continue
    const m: AcpAuthMethod = { id: rec.id }
    if (typeof rec.name === 'string') m.name = rec.name
    if (typeof rec.description === 'string') m.description = rec.description
    if (typeof rec.type === 'string') m.type = rec.type
    if (Array.isArray(rec.args)) {
      m.args = rec.args.filter((a): a is string => typeof a === 'string')
    }
    out.push(m)
  }
  return out
}

/** auth_methods 是否通告了可用的运行时凭据（agent 管理的 provider 方法）。
 *  hermes-setup 终端方法不计入——它只说明「可以去配置」。 */
export function hasRuntimeCredential(authMethods: AcpAuthMethod[]): boolean {
  return authMethods.some(
    (m) => m.id && m.id !== HERMES_SETUP_AUTH_METHOD_ID,
  )
}

/**
 * 是否「明确」无可用凭据：initialize 给了 auth_methods 列表且只剩终端
 * 配置入口。未通告该字段（null/undefined/空数组，老版 hermes）返回
 * false——未知 ≠ 无凭据，不误报。
 */
export function needsCredentialSetup(
  authMethods: AcpAuthMethod[] | null | undefined,
): boolean {
  if (!authMethods || authMethods.length === 0) return false
  return !hasRuntimeCredential(authMethods)
}

/** 「错误信息闻起来像缺凭据」的启发式——initialize 之前连接就失败
 *  （拿不到 auth_methods）时的补充判定。只用于决定是否**追加**指引，
 *  误报成本极低。 */
export function looksLikeCredentialError(message: string): boolean {
  if (!message) return false
  return CREDENTIAL_ERROR_RE.test(message)
}

const CREDENTIAL_ERROR_RE =
  /(缺少[^。]{0,8}(密钥|凭据)|未配置[^。]{0,10}(模型|密钥|provider)|api[ _-]?key|provider[^。\n]{0,24}(credential|not configured|missing)|no (available )?provider|credential|authentication (required|failed)|unauthorized)/i

/**
 * 构造配置指引文案（设置页与失败提示共用同一份措辞）。
 * @param guidedEndpoint 设置项 localAgent.guidedEndpoint；'' = 只给本机
 *   终端自助步骤。端点仅从设置传入，本函数不含任何内置 URL。
 */
export function buildAuthGuideText(guidedEndpoint: string): string {
  const steps =
    'Hermes 需要配置至少一个模型服务商凭据（API key）才能工作：\n' +
    '1. 在终端运行 `hermes --setup`，进入交互式 provider/模型配置；\n' +
    '2. 或手动编辑 hermes 的 config.yaml 填入服务商密钥，然后重新开始会话；\n' +
    '3. 配置完成后用「设置 → Hermes → 检测」验证。'
  const endpoint = (guidedEndpoint ?? '').trim()
  return endpoint ? `${steps}\n配置指引入口：${endpoint}` : steps
}

/**
 * hermes 轮次失败时是否附配置指引：initialize 明确无凭据（noCredentials）
 * 或错误信息命中缺凭据启发式 → 返回指引段（带换行前缀，直接拼在报错后）；
 * 否则返回 ''。纯函数，便于单测。
 */
export function failureAuthHint(opts: {
  errorMessage?: string
  noCredentials?: boolean
  guidedEndpoint?: string
}): string {
  const credentialRelated =
    opts.noCredentials === true ||
    looksLikeCredentialError(opts.errorMessage ?? '')
  if (!credentialRelated) return ''
  return `\n\n【配置指引】\n${buildAuthGuideText(opts.guidedEndpoint ?? '')}`
}
