// Task #7: historyTextOfBlocks — enhanced LLM-history serialization of
// assistant blocks (text + budgeted tool trace + todo snapshot).

import type { UiBlock } from '../types'
import { historyTextOfBlocks, TRACE_BUDGET } from '../transcript'

function tool(
  name: string,
  patch: Partial<Extract<UiBlock, { kind: 'tool' }>> = {},
): UiBlock {
  return {
    kind: 'tool',
    callId: `c-${name}`,
    name,
    state: 'done',
    ...patch,
  }
}

function todo(items: Array<[string, 'pending' | 'in_progress' | 'completed']>): UiBlock {
  return {
    kind: 'todo',
    callId: 'c-todo',
    state: 'done',
    items: items.map(([content, status]) => ({ content, status })),
  }
}

describe('historyTextOfBlocks · text passthrough', () => {
  it('returns empty string for undefined / empty input', () => {
    expect(historyTextOfBlocks(undefined)).toBe('')
    expect(historyTextOfBlocks([])).toBe('')
  })

  it('concatenates text blocks verbatim (same as textOfBlocks)', () => {
    const blocks: UiBlock[] = [
      { kind: 'text', text: '第一段。' },
      { kind: 'text', text: '第二段。' },
    ]
    expect(historyTextOfBlocks(blocks)).toBe('第一段。第二段。')
  })
})

describe('historyTextOfBlocks · tool trace', () => {
  it('serializes a tool block into the compact one-liner format', () => {
    const out = historyTextOfBlocks([
      tool('read_note', { args: { path: 'a.md' }, summary: '读取了 a.md' }),
    ])
    expect(out).toBe(
      '【工具轨迹】\n[工具] read_note({"path":"a.md"}) → ok: 读取了 a.md',
    )
  })

  it('marks state==="error" as 失败', () => {
    const out = historyTextOfBlocks([tool('delete_note', { state: 'error', summary: '被拒绝' })])
    expect(out).toContain('[工具] delete_note() → 失败: 被拒绝')
  })

  it('treats running/retrying as ok (only error is a failure)', () => {
    const out = historyTextOfBlocks([tool('search_notes', { state: 'running' })])
    expect(out).toContain('→ ok')
    expect(out).not.toContain('失败')
  })

  it('omits the summary tail when there is none', () => {
    const out = historyTextOfBlocks([tool('list_files', { args: { folder: 'x' } })])
    expect(out).toBe('【工具轨迹】\n[工具] list_files({"folder":"x"}) → ok')
  })

  it('truncates args to ≤80 chars with an ellipsis', () => {
    const long = 'x'.repeat(300)
    const out = historyTextOfBlocks([tool('edit_note', { args: { content: long } })])
    // args portion between '(' and ')' is exactly 80 chars + '…'
    const m = out.match(/\[工具\] edit_note\((.*?)\) → ok/)
    expect(m).not.toBeNull()
    const args = m![1]
    expect(args.endsWith('…')).toBe(true)
    expect(args.length).toBe(81)
    expect(out).not.toContain(long)
  })

  it('truncates summary to ≤120 chars with an ellipsis', () => {
    const longSummary = 's'.repeat(300)
    const out = historyTextOfBlocks([tool('read_note', { summary: longSummary })])
    expect(out).toContain('s'.repeat(120) + '…')
    expect(out).not.toContain('s'.repeat(121))
  })

  it('never includes thinking or output', () => {
    const out = historyTextOfBlocks([
      tool('read_note', {
        summary: 'ok',
        thinking: 'SECRET-THINKING',
        output: { data: 'SECRET-OUTPUT' },
      }),
    ])
    expect(out).not.toContain('SECRET-THINKING')
    expect(out).not.toContain('SECRET-OUTPUT')
  })

  it('degrades OLDEST entries to bare name lines when over budget', () => {
    // 8 entries × ~180 chars each ≈ 1400+ chars → over the 1200 budget.
    const blocks: UiBlock[] = []
    for (let i = 0; i < 8; i++) {
      blocks.push(
        tool(`tool_${i}`, {
          args: { payload: 'y'.repeat(60) },
          summary: `摘要内容第${i}条`.padEnd(110, '摘'),
        }),
      )
    }
    const out = historyTextOfBlocks(blocks)
    const trace = out.split('\n').slice(1)
    // Oldest entries lose their details first...
    expect(trace[0]).toBe('[工具] tool_0')
    // ...while the newest keep their full one-liner.
    expect(trace[trace.length - 1]).toContain('[工具] tool_7(')
    expect(trace[trace.length - 1]).toContain('→ ok')
    // Whole section body stays within the budget.
    expect(trace.join('\n').length).toBeLessThanOrEqual(TRACE_BUDGET)
  })

  it('hard-truncates when even bare name lines overflow', () => {
    const blocks: UiBlock[] = []
    for (let i = 0; i < 300; i++) blocks.push(tool(`t${i}`))
    const out = historyTextOfBlocks(blocks)
    const trace = out.replace('【工具轨迹】\n', '')
    expect(trace.length).toBeLessThanOrEqual(TRACE_BUDGET)
  })
})

describe('historyTextOfBlocks · todo snapshot', () => {
  it('uses the same 【任务清单】 format as textOfBlocks', () => {
    const out = historyTextOfBlocks([
      todo([['分析需求', 'completed'], ['写实现', 'in_progress'], ['补测试', 'pending']]),
    ])
    expect(out).toBe(
      '【任务清单】\n- [x] 分析需求\n- [→] 写实现\n- [ ] 补测试',
    )
  })

  it('uses the LAST todo block only', () => {
    const out = historyTextOfBlocks([
      todo([['旧项', 'pending']]),
      todo([['新项', 'completed']]),
    ])
    expect(out).not.toContain('旧项')
    expect(out).toContain('- [x] 新项')
  })
})

describe('historyTextOfBlocks · section assembly order', () => {
  it('assembles text → 【工具轨迹】 → 【任务清单】', () => {
    const out = historyTextOfBlocks([
      { kind: 'text', text: '开始处理。' },
      tool('read_note', { args: { path: 'a.md' }, summary: '读到了内容' }),
      todo([['第一步', 'completed']]),
      { kind: 'text', text: '完成了。' },
    ])
    const textIdx = out.indexOf('开始处理。')
    const traceIdx = out.indexOf('【工具轨迹】')
    const todoIdx = out.indexOf('【任务清单】')
    expect(textIdx).toBe(0)
    expect(textIdx).toBeLessThan(traceIdx)
    expect(traceIdx).toBeLessThan(todoIdx)
    expect(out).toContain('完成了。')
  })

  it('omits the trace section when there are no tool blocks', () => {
    const out = historyTextOfBlocks([
      { kind: 'text', text: '纯回复。' },
      todo([['a', 'pending']]),
    ])
    expect(out).not.toContain('【工具轨迹】')
    expect(out).toContain('【任务清单】')
  })

  it('omits the todo section when there is no todo block', () => {
    const out = historyTextOfBlocks([tool('read_note')])
    expect(out).not.toContain('【任务清单】')
  })
})
