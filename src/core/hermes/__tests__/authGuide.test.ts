// M2-T3 首次认证引导：纯函数单测——auth_methods 解析、无凭据判定、
// 指引文案构造（含「端点来自设置项而非硬编码」断言）、失败提示拼接判定。
// 对照 hermes 侧真实结构：acp_adapter/auth.py build_auth_methods() ——
// 已配凭据 = provider 运行时方法 + 恒有的 hermes-setup 终端方法；
// 未配凭据 = 只剩 hermes-setup。

import {
  HERMES_SETUP_AUTH_METHOD_ID,
  parseAuthMethods,
  hasRuntimeCredential,
  needsCredentialSetup,
  looksLikeCredentialError,
  buildAuthGuideText,
  failureAuthHint,
} from '../authGuide'
import { classifyConnectionFailure } from '../acpConnection'
import type { AcpAuthMethod } from '../types'

/* ── hermes 真实帧样本（acp_adapter/auth.py 的线上形状） ─────────────── */

const TERMINAL_ONLY = [
  {
    id: 'hermes-setup',
    name: 'Configure Hermes provider',
    description:
      "Open Hermes' interactive model/provider setup in a terminal. " +
      'Use this when Hermes has not been configured on this machine yet.',
    type: 'terminal',
    args: ['--setup'],
  },
]

const WITH_PROVIDER = [
  {
    id: 'openrouter',
    name: 'openrouter runtime credentials',
    description:
      'Authenticate Hermes using the currently configured openrouter runtime credentials.',
  },
  ...TERMINAL_ONLY,
]

describe('parseAuthMethods（宽容解析）', () => {
  it('完整解析 hermes 真实形状（id/name/description/type/args）', () => {
    const parsed = parseAuthMethods(WITH_PROVIDER)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({
      id: 'openrouter',
      name: 'openrouter runtime credentials',
      description: expect.stringContaining('openrouter runtime'),
    })
    expect(parsed[1]).toEqual({
      id: 'hermes-setup',
      name: 'Configure Hermes provider',
      description: expect.stringContaining('terminal'),
      type: 'terminal',
      args: ['--setup'],
    })
  })

  it('非数组 / undefined / null → 空数组（老版 hermes 不带该字段）', () => {
    expect(parseAuthMethods(undefined)).toEqual([])
    expect(parseAuthMethods(null)).toEqual([])
    expect(parseAuthMethods('hermes-setup')).toEqual([])
    expect(parseAuthMethods({ id: 'x' })).toEqual([])
  })

  it('丢弃无 id / 非对象条目，args 只留字符串', () => {
    const parsed = parseAuthMethods([
      null,
      'noise',
      42,
      { name: 'no-id' },
      { id: '' },
      { id: 'ok', args: ['--setup', 7, null, 'x'] },
    ])
    expect(parsed).toEqual([{ id: 'ok', args: ['--setup', 'x'] }])
  })
})

describe('无凭据判定（needsCredentialSetup）', () => {
  it('只剩 hermes-setup 终端入口 → 明确无凭据', () => {
    expect(needsCredentialSetup(parseAuthMethods(TERMINAL_ONLY))).toBe(true)
    expect(hasRuntimeCredential(parseAuthMethods(TERMINAL_ONLY))).toBe(false)
  })

  it('有 provider 运行时方法 → 有凭据', () => {
    expect(needsCredentialSetup(parseAuthMethods(WITH_PROVIDER))).toBe(false)
    expect(hasRuntimeCredential(parseAuthMethods(WITH_PROVIDER))).toBe(true)
  })

  it('未通告字段（null/undefined/空数组）→ false：未知 ≠ 无凭据，不误报', () => {
    expect(needsCredentialSetup(null)).toBe(false)
    expect(needsCredentialSetup(undefined)).toBe(false)
    expect(needsCredentialSetup([])).toBe(false)
  })

  it('终端方法 id 常量与 hermes 侧 TERMINAL_SETUP_AUTH_METHOD_ID 一致', () => {
    expect(HERMES_SETUP_AUTH_METHOD_ID).toBe('hermes-setup')
  })
})

describe('looksLikeCredentialError（报错启发式）', () => {
  it('命中 T6 launch_failed 三分类文案（含「缺少模型/接口密钥」）', () => {
    const err = classifyConnectionFailure({ phase: 'handshake', exitCode: 1 })
    expect(err.kind).toBe('launch_failed')
    expect(looksLikeCredentialError(err.message)).toBe(true)
  })

  it('命中常见缺凭据报错措辞', () => {
    expect(looksLikeCredentialError('No API key found for provider')).toBe(true)
    expect(looksLikeCredentialError('provider not configured')).toBe(true)
    expect(looksLikeCredentialError('authentication required')).toBe(true)
    expect(looksLikeCredentialError('hermes: no available provider')).toBe(true)
    expect(looksLikeCredentialError('未配置任何模型密钥')).toBe(true)
  })

  it('不命中与凭据无关的报错', () => {
    expect(looksLikeCredentialError('连接超时（20s）')).toBe(false)
    expect(looksLikeCredentialError('spawn hermes ENOENT')).toBe(false)
    expect(looksLikeCredentialError('')).toBe(false)
  })
})

describe('buildAuthGuideText（指引文案构造）', () => {
  it('默认（端点空）只含本机终端自助步骤', () => {
    const text = buildAuthGuideText('')
    expect(text).toContain('hermes --setup')
    expect(text).toContain('config.yaml')
    expect(text).toContain('设置 → Hermes → 检测')
    expect(text).not.toContain('配置指引入口')
  })

  it('端点仅从设置项传入并原样展示——函数本体不含任何内置 URL', () => {
    const endpoint = 'https://setup.example.com/hermes'
    const text = buildAuthGuideText(endpoint)
    expect(text).toContain(`配置指引入口：${endpoint}`)
    // 未传端点时文案里没有任何 URL（无硬编码的铁证）。
    expect(buildAuthGuideText('')).not.toContain('http')
    expect(buildAuthGuideText('   ')).not.toContain('http')
  })
})

describe('failureAuthHint（失败提示是否附指引）', () => {
  const methods: AcpAuthMethod[] = parseAuthMethods(TERMINAL_ONLY)

  it('initialize 明确无凭据 → 附指引（即使报错文案不含凭据关键词）', () => {
    const hint = failureAuthHint({
      errorMessage: 'session/prompt 超时（30s）',
      noCredentials: needsCredentialSetup(methods),
      guidedEndpoint: 'docs://setup',
    })
    expect(hint).toContain('【配置指引】')
    expect(hint).toContain('docs://setup')
  })

  it('报错命中缺凭据启发式 → 附指引', () => {
    const hint = failureAuthHint({
      errorMessage: 'Hermes 会话出错：No API key found',
    })
    expect(hint).toContain('hermes --setup')
  })

  it('无关报错且凭据状态未知 → 不附指引（空串）', () => {
    expect(
      failureAuthHint({ errorMessage: '连接超时', noCredentials: false }),
    ).toBe('')
    expect(failureAuthHint({})).toBe('')
  })

  it('端点来自设置项：传什么显示什么，不传则无端点行', () => {
    expect(failureAuthHint({ errorMessage: 'unauthorized', guidedEndpoint: 'x.example' }))
      .toContain('配置指引入口：x.example')
    expect(failureAuthHint({ errorMessage: 'unauthorized' })).not.toContain(
      '配置指引入口',
    )
  })
})
