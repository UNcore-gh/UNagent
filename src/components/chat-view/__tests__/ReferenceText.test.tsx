// ReferenceText on the native renderer (追加㉛): the pure half — bracketing
// mention runs with placeholder tokens — lives in buildMarked and is tested
// here (node env, no DOM needed). The DOM half (token → chip swap) lives in
// chipInject.test.ts. The native render itself is Obsidian-runtime territory.

import { buildMarked } from '../ReferenceText'

const PH_A = '\uE000'
const PH_B = '\uE001'
const PH_C = '\uE002'
const PH_D = '\uE003'

describe('buildMarked', () => {
  it('leaves plain text untouched with no chips', () => {
    const { marked, chips } = buildMarked('你好世界')
    expect(marked).toBe('你好世界')
    expect(chips).toHaveLength(0)
  })

  it('brackets a wikilink with an indexed placeholder', () => {
    const { marked, chips } = buildMarked('看 [[A]] 这里')
    expect(marked).toBe(`看 ${PH_A}0${PH_B} 这里`)
    expect(chips).toHaveLength(1)
    expect(chips[0].texts).toContain('[[A]]')
  })

  it('numbers multiple runs in order', () => {
    const { marked, chips } = buildMarked('[[A]] 与 #标签 结尾')
    expect(marked).toContain(`${PH_A}0${PH_B}`)
    expect(marked).toContain(`${PH_A}1${PH_B}`)
    expect(chips).toHaveLength(2)
  })

  it('groups adjacent same-kind mentions into one run', () => {
    const { chips } = buildMarked('[[A]] [[B]] 两处')
    expect(chips).toHaveLength(1)
    expect(chips[0].texts).toHaveLength(2)
  })

  it('never emits a placeholder without a matching chip', () => {
    const { marked, chips } = buildMarked('混合 [[A]]「段」 与 #标签 结尾')
    const indexes = [...marked.matchAll(/\uE000(\d+)\uE001/g)].map((m) =>
      Number(m[1]),
    )
    for (const i of indexes) {
      expect(chips[i]).toBeDefined()
    }
  })

  it('keeps the placeholder chars out of normal text', () => {
    const { marked } = buildMarked('普通的一句话')
    expect(marked).not.toContain(PH_A)
    expect(marked).not.toContain(PH_B)
  })
})

describe('buildMarked — inline command/skill tokens (追加㊺)', () => {
  it('brackets a known inline command with its Chinese label', () => {
    const { marked, commands } = buildMarked('用 /btw 试试')
    expect(marked).toBe(`用 ${PH_C}0${PH_D} 试试`)
    expect(commands).toEqual([
      { label: '顺便一问', icon: expect.any(String) },
    ])
  })

  it('brackets a known skill only when its name is in the registry gate', () => {
    const names = new Set(['agent-creator'])
    const { marked, commands } = buildMarked('发 //agent-creator 创建', names)
    expect(marked).toContain(`${PH_C}0${PH_D}`)
    expect(commands[0]).toEqual({ label: 'agent-creator', icon: 'sparkles' })
    // Without the gate the same text stays plain prose.
    const plain = buildMarked('发 //agent-creator 创建')
    expect(plain.marked).not.toContain(PH_C)
    expect(plain.commands).toHaveLength(0)
  })

  it('leaves unknown commands and prose lookalikes untouched', () => {
    const { marked, commands } = buildMarked('完成 10/20 与 /xyz 任务，见 https://a.b')
    expect(marked).not.toContain(PH_C)
    expect(commands).toHaveLength(0)
  })

  it('keeps the two placeholder pairs disjoint', () => {
    const { marked, chips, commands } = buildMarked('看 [[A]] 用 /btw 试试')
    expect(marked).toContain(`${PH_A}0${PH_B}`)
    expect(marked).toContain(`${PH_C}0${PH_D}`)
    expect(chips).toHaveLength(1)
    expect(commands).toHaveLength(1)
  })
})
