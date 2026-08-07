// 进化 B 案（AI 反思建议）纯函数层：触发节流判定、窗口实录、复盘提示词、
// JSON 结果解析。编排在 useAgent，这里全部离线可测。

import type { UiMessage } from '../../components/chat-view/types'
import {
  MAX_REFLECT_SUGGESTIONS,
  REFLECT_TURN_GAP,
  REFLECT_WINDOW_CHARS,
  REFLECT_WINDOW_MESSAGES,
  buildReflectPrompt,
  buildReflectTranscript,
  parseReflectResult,
  shouldReflect,
} from '../reflect'

const msg = (
  role: 'user' | 'assistant',
  text: string,
  ephemeral = false,
): UiMessage => ({
  id: 'x',
  role,
  ...(role === 'user'
    ? { content: text }
    : { blocks: [{ kind: 'text' as const, text }] }),
  ...(ephemeral ? { ephemeral: true } : {}),
})

describe('shouldReflect (throttle contract)', () => {
  const base = {
    enabled: true,
    turnNo: REFLECT_TURN_GAP,
    lastReflectTurn: 0,
  }

  it('fires once the turn gap is reached', () => {
    expect(shouldReflect(base)).toBe(true)
    expect(shouldReflect({ ...base, turnNo: REFLECT_TURN_GAP - 1 })).toBe(false)
  })

  it('measures the gap from the previous reflection, not from zero', () => {
    expect(
      shouldReflect({ ...base, turnNo: 9, lastReflectTurn: 8 }),
    ).toBe(false)
    expect(
      shouldReflect({
        ...base,
        turnNo: 8 + REFLECT_TURN_GAP,
        lastReflectTurn: 8,
      }),
    ).toBe(true)
  })

  it('is off when the settings toggle is off', () => {
    expect(shouldReflect({ ...base, enabled: false })).toBe(false)
  })

  it('skips aside / tool-less / failed / command turns', () => {
    expect(shouldReflect({ ...base, ephemeral: true })).toBe(false)
    expect(shouldReflect({ ...base, noTools: true })).toBe(false)
    expect(shouldReflect({ ...base, failed: true })).toBe(false)
    expect(shouldReflect({ ...base, command: 'learn' })).toBe(false)
    expect(shouldReflect({ ...base, command: 'btw' })).toBe(false)
    expect(shouldReflect({ ...base, command: 'compact' })).toBe(false)
  })

  it('rejects degenerate turn numbers', () => {
    expect(shouldReflect({ ...base, turnNo: 0 })).toBe(false)
    expect(shouldReflect({ ...base, turnNo: Number.NaN })).toBe(false)
  })
})

describe('buildReflectTranscript (window)', () => {
  it('keeps only the last N messages, most recent intact', () => {
    const messages: UiMessage[] = []
    for (let i = 1; i <= REFLECT_WINDOW_MESSAGES + 4; i++) {
      messages.push(msg('user', `第${i}问`))
    }
    const t = buildReflectTranscript(messages)
    expect(t).toContain(`第${REFLECT_WINDOW_MESSAGES + 4}问`)
    // Oldest (out of window) messages are gone.
    expect(t).not.toContain('第1问')
    expect(t).not.toContain(`第4问`)
    expect(t).toContain(`第5问`)
  })

  it('skips ephemeral /btw asides like the compact transcript', () => {
    const t = buildReflectTranscript([
      msg('user', '正经问题'),
      msg('user', '顺便一问', true),
    ])
    expect(t).toContain('正经问题')
    expect(t).not.toContain('顺便一问')
  })

  it('hard-caps the char budget, keeping the recent end', () => {
    const long = '长'.repeat(REFLECT_WINDOW_CHARS + 500)
    const t = buildReflectTranscript([
      msg('user', '开头旧消息'),
      msg('user', long),
    ])
    expect(t.length).toBeLessThanOrEqual(REFLECT_WINDOW_CHARS + 40)
    expect(t).toContain('…（更早内容略）')
    expect(t).not.toContain('开头旧消息')
  })
})

describe('buildReflectPrompt', () => {
  it('states the confirm-before-write contract and embeds the transcript', () => {
    const p = buildReflectPrompt('用户：你好', true)
    expect(p).toContain('用户确认后才会写入')
    expect(p).toContain('{"suggestions":[]}')
    expect(p).toContain('用户：你好')
  })

  it('offers the skill class only when skills are enabled', () => {
    expect(buildReflectPrompt('t', true)).toContain('skill')
    const off = buildReflectPrompt('t', false)
    expect(off).not.toContain('技能结晶')
    expect(off).toContain('"type":"memory|user"')
  })
})

describe('parseReflectResult', () => {
  it('parses the strict JSON shape into typed suggestions', () => {
    const raw = JSON.stringify({
      suggestions: [
        { type: 'memory', content: '用户喜欢简洁回答', reason: '明确偏好' },
        { type: 'user', content: '用户是左撇子' },
        { type: 'skill', content: '整理笔记的固定流程', reason: '可复用' },
      ],
    })
    const out = parseReflectResult(raw)
    expect(out).toHaveLength(3)
    expect(out.map((s) => s.type)).toEqual(['memory', 'user', 'skill'])
    expect(out[0].content).toBe('用户喜欢简洁回答')
    expect(out[0].reason).toBe('明确偏好')
    expect(out[1].reason).toBeUndefined()
    expect(new Set(out.map((s) => s.id)).size).toBe(3)
  })

  it('caps the list at MAX_REFLECT_SUGGESTIONS', () => {
    const raw = JSON.stringify({
      suggestions: Array.from({ length: 6 }, (_, i) => ({
        type: 'memory',
        content: `条目${i}`,
      })),
    })
    expect(parseReflectResult(raw)).toHaveLength(MAX_REFLECT_SUGGESTIONS)
  })

  it('tolerates wrapping prose and code fences', () => {
    const raw =
      '好的，我的建议如下：\n```json\n{"suggestions":[{"type":"memory","content":"x 条目"}]}\n```\n以上。'
    const out = parseReflectResult(raw)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('x 条目')
  })

  it('drops unknown types, empty contents and duplicates', () => {
    const raw = JSON.stringify({
      suggestions: [
        { type: 'bogus', content: '无效类型' },
        { type: 'memory', content: '   ' },
        { type: 'memory', content: '- 重复条目' },
        { type: 'memory', content: '重复条目' }, // same after normalizeEntry
      ],
    })
    const out = parseReflectResult(raw)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('重复条目') // bullet prefix stripped
  })

  it('collapses newlines so entries stay single-line', () => {
    const raw = JSON.stringify({
      suggestions: [{ type: 'user', content: '第一行\n第二行' }],
    })
    expect(parseReflectResult(raw)[0].content).toBe('第一行 第二行')
  })

  it('returns [] for malformed or empty output (silent by design)', () => {
    expect(parseReflectResult('')).toEqual([])
    expect(parseReflectResult('没有 JSON')).toEqual([])
    expect(parseReflectResult('{broken')).toEqual([])
    expect(parseReflectResult('{"suggestions":"nope"}')).toEqual([])
    expect(parseReflectResult('[1,2]')).toEqual([])
  })
})
