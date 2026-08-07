// M2-T4 §2 引擎能力模型：纯函数单测——两引擎能力集与查询助手。

import {
  engineCapabilities,
  engineHasCapability,
  type EngineCapability,
} from '../capabilities'

describe('engineCapabilities', () => {
  it('core = { extendedThinking, localCompaction }', () => {
    const caps = engineCapabilities('core')
    expect(caps.has('extendedThinking')).toBe(true)
    expect(caps.has('localCompaction')).toBe(true)
    expect(caps.has('slashPassthrough')).toBe(false)
    expect(caps.has('approvalModes')).toBe(false)
    expect(caps.size).toBe(2)
  })

  it('hermes = { slashPassthrough, approvalModes, hermesDesktop }', () => {
    const caps = engineCapabilities('hermes')
    expect(caps.has('slashPassthrough')).toBe(true)
    // 任务一 §1.2：审批模式是 hermes 会话能力（session/set_mode）。
    expect(caps.has('approvalModes')).toBe(true)
    // /hermes-open 桌面端出口：仅 hermes 引擎持有（core 无桌面端会话）。
    expect(caps.has('hermesDesktop')).toBe(true)
    expect(caps.has('extendedThinking')).toBe(false)
    expect(caps.has('localCompaction')).toBe(false)
    expect(caps.size).toBe(3)
  })

  it('每次调用返回独立副本——外部改动不污染能力表', () => {
    const a = engineCapabilities('core')
    a.add('slashPassthrough')
    a.delete('extendedThinking')
    const b = engineCapabilities('core')
    expect(b.has('extendedThinking')).toBe(true)
    expect(b.has('slashPassthrough')).toBe(false)
  })

  it('能力并集覆盖全部五种 capability（类型守卫不漏项）', () => {
    const all = new Set<EngineCapability>([
      ...engineCapabilities('core'),
      ...engineCapabilities('hermes'),
    ])
    expect(all).toEqual(
      new Set<EngineCapability>([
        'slashPassthrough',
        'extendedThinking',
        'localCompaction',
        'approvalModes',
        'hermesDesktop',
      ]),
    )
  })
})

describe('engineHasCapability', () => {
  it('按引擎如实回答', () => {
    expect(engineHasCapability('core', 'extendedThinking')).toBe(true)
    expect(engineHasCapability('core', 'slashPassthrough')).toBe(false)
    expect(engineHasCapability('hermes', 'slashPassthrough')).toBe(true)
    expect(engineHasCapability('hermes', 'approvalModes')).toBe(true)
    expect(engineHasCapability('core', 'approvalModes')).toBe(false)
    expect(engineHasCapability('hermes', 'localCompaction')).toBe(false)
  })
})
