// turnPoints / backtrackablePoints (追加51): the turn index the backtrack
// picker offers. Pure list math — no DOM needed.
// activeOf / switchMessageVersion / withNewVersion (追加52): the answer-
// version model behind the ◀ N/M ▶ switcher.

import {
  activeOf,
  backtrackablePoints,
  switchMessageVersion,
  turnPoints,
  withNewVersion,
} from '../types'
import type { UiMessage } from '../types'

const user = (id: string, content: string): UiMessage => ({
  id,
  role: 'user',
  content,
})
const asst = (id: string, text = ''): UiMessage => ({
  id,
  role: 'assistant',
  blocks: [{ kind: 'text', text }],
})

describe('turnPoints', () => {
  it('numbers only real (non-ephemeral) user messages', () => {
    const msgs: UiMessage[] = [
      user('u1', '第一问'),
      asst('a1'),
      user('u2', '顺便一问'),
      { ...user('u3', '第二问'), ephemeral: true },
      asst('a3'),
    ]
    const points = turnPoints(msgs)
    expect(points.map((p) => [p.turn, p.index])).toEqual([
      [1, 0],
      [2, 2],
    ])
    expect(points[0].preview).toBe('第一问')
  })
})

describe('backtrackablePoints', () => {
  it('drops the very first turn (nowhere to rewind before it)', () => {
    const msgs: UiMessage[] = [
      user('u1', '开头'),
      asst('a1'),
      user('u2', '第二问'),
      asst('a2'),
      user('u3', '第三问'),
      asst('a3'),
    ]
    const points = backtrackablePoints(msgs)
    expect(points.map((p) => p.turn)).toEqual([2, 3])
    expect(points[0].index).toBe(2)
    expect(points[1].index).toBe(4)
  })

  it('is empty when there is only one turn', () => {
    const msgs: UiMessage[] = [user('u1', '唯一一问'), asst('a1')]
    expect(backtrackablePoints(msgs)).toHaveLength(0)
  })
})

describe('answer versions (追加52)', () => {
  const textOf = (m: UiMessage): string =>
    (activeOf(m).blocks?.[0] as { text: string } | undefined)?.text ?? ''

  it('activeOf reads the body with no versions', () => {
    expect(textOf(asst('a1', 'v0'))).toBe('v0')
  })

  it('withNewVersion stacks the old answer as a version and shows the new', () => {
    const old = asst('a1', '旧回答')
    const next = withNewVersion(old, asst('a2', '新回答'))
    expect(textOf(next)).toBe('新回答')
    expect(next.versions).toHaveLength(2)
    expect(activeOf(next).id).toBe('a2')
  })

  it('switchMessageVersion flips to an older version and back', () => {
    const old = asst('a1', 'v1')
    const v2 = withNewVersion(old, asst('a2', 'v2'))
    const msgs: UiMessage[] = [user('u1', '问'), v2]
    const older = switchMessageVersion(msgs, 'a2', -1)
    expect(textOf(older[1])).toBe('v1')
    expect(older[1].activeVersion).toBe(0)
    const newest = switchMessageVersion(older, 'a2', 1)
    expect(textOf(newest[1])).toBe('v2')
  })

  it('clamps at both ends and ignores unknown ids', () => {
    const v = withNewVersion(asst('a1', 'v1'), asst('a2', 'v2'))
    const msgs: UiMessage[] = [v]
    expect(switchMessageVersion(msgs, 'a2', -1)[0].activeVersion).toBe(0)
    expect(switchMessageVersion(msgs, 'a2', 1)[0].activeVersion).toBe(1)
    expect(switchMessageVersion(msgs, 'nope', -1)[0].activeVersion).toBe(1)
  })
})
