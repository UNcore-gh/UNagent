// textOfBlocks builds the assistant-side LLM history from UI blocks. The
// LATEST todo block must come along as a compact checklist snapshot so the
// model keeps seeing task progress across turns (todo_write results only
// live inside one send).

import { textOfBlocks } from '../types'
import type { UiBlock } from '../types'

const todo = (
  items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[],
  callId = 'call-todo',
): UiBlock => ({ kind: 'todo', callId, items, state: 'done' })

describe('textOfBlocks todo snapshot', () => {
  it('appends the latest todo block as a checklist', () => {
    const text = textOfBlocks([
      todo([
        { content: '检索笔记', status: 'completed' },
        { content: '打标签', status: 'in_progress' },
        { content: '写总结', status: 'pending' },
      ]),
      { kind: 'text', text: '开始处理。' },
    ])
    expect(text).toBe(
      '开始处理。\n\n【任务清单】\n- [x] 检索笔记\n- [→] 打标签\n- [ ] 写总结',
    )
  })

  it('only keeps the LATEST list when the model updates it twice', () => {
    const text = textOfBlocks([
      todo([{ content: '旧步骤', status: 'pending' }], 'call-1'),
      todo([{ content: '新步骤', status: 'completed' }], 'call-2'),
    ])
    expect(text).toContain('新步骤')
    expect(text).not.toContain('旧步骤')
  })

  it('leaves messages without a todo block untouched', () => {
    expect(textOfBlocks([{ kind: 'text', text: '普通回答' }])).toBe('普通回答')
    expect(textOfBlocks(undefined)).toBe('')
  })
})
