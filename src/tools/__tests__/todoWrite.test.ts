// todo_write tool — the agent's task-list (清单) for complex multi-step
// tasks (TodoWrite pattern). Every call REPLACES the full list; the tool is
// pure in-memory (no vault), so the tests exercise parsing/normalization and
// the contract the chat UI relies on.

import type { ToolContext } from '../../core/agent/types'
import {
  MAX_TODO_CONTENT_LENGTH,
  MAX_TODO_ITEMS,
  parseTodos,
  todoWriteTool,
  todosSummary,
} from '../todoWrite'

const ctx = {} as unknown as ToolContext

describe('parseTodos', () => {
  it('parses a well-formed list in order', () => {
    const items = parseTodos([
      { content: '检索笔记', status: 'completed' },
      { content: '打标签', status: 'in_progress' },
      { content: '写总结', status: 'pending' },
    ])
    expect(items).toEqual([
      { content: '检索笔记', status: 'completed' },
      { content: '打标签', status: 'in_progress' },
      { content: '写总结', status: 'pending' },
    ])
  })

  it('defaults missing/unknown status to pending', () => {
    const items = parseTodos([
      { content: '甲' },
      { content: '乙', status: 'bogus' },
    ])
    expect(items).toEqual([
      { content: '甲', status: 'pending' },
      { content: '乙', status: 'pending' },
    ])
  })

  it('trims content and truncates overlong entries', () => {
    const long = 'x'.repeat(MAX_TODO_CONTENT_LENGTH + 50)
    const items = parseTodos([{ content: `  ${long}  `, status: 'pending' }])
    expect(items?.[0].content).toBe(`${'x'.repeat(MAX_TODO_CONTENT_LENGTH)}…`)
  })

  it('caps the item count', () => {
    const raw = Array.from({ length: MAX_TODO_ITEMS + 10 }, (_, i) => ({
      content: `步骤 ${i}`,
      status: 'pending',
    }))
    expect(parseTodos(raw)?.length).toBe(MAX_TODO_ITEMS)
  })

  it('rejects unusable payloads', () => {
    expect(parseTodos(undefined)).toBeNull()
    expect(parseTodos([])).toBeNull()
    expect(parseTodos('not a list')).toBeNull()
    expect(parseTodos([{ content: '', status: 'pending' }])).toBeNull()
    expect(parseTodos([{ content: '   ', status: 'pending' }])).toBeNull()
    expect(parseTodos([{ status: 'pending' }])).toBeNull()
    expect(parseTodos([null])).toBeNull()
    expect(parseTodos(['just a string'])).toBeNull()
  })
})

describe('todosSummary', () => {
  it('counts done and active items', () => {
    expect(
      todosSummary([
        { content: '甲', status: 'completed' },
        { content: '乙', status: 'in_progress' },
        { content: '丙', status: 'pending' },
      ]),
    ).toBe('清单已更新：3 项，进行中 1，已完成 1')
  })

  it('omits the active clause when nothing is running', () => {
    expect(
      todosSummary([{ content: '甲', status: 'completed' }]),
    ).toBe('清单已更新：1 项，已完成 1')
  })
})

describe('todoWriteTool', () => {
  it('metadata contract: non-destructive, vault-free, todos required', () => {
    expect(todoWriteTool.metadata.name).toBe('todo_write')
    expect(todoWriteTool.metadata.destructive).toBe(false)
    expect(todoWriteTool.metadata.requiresVault).toBe(false)
    expect(todoWriteTool.metadata.category).toBe('manage')
    const params = todoWriteTool.metadata.parameters as {
      required: string[]
    }
    expect(params.required).toEqual(['todos'])
  })

  it('accepts a full list and echoes it back', async () => {
    const res = await todoWriteTool.run(
      {
        todos: [
          { content: '检索', status: 'completed' },
          { content: '总结', status: 'in_progress' },
        ],
      },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.summary).toBe('清单已更新：2 项，进行中 1，已完成 1')
    expect(res.output).toEqual({
      todos: [
        { content: '检索', status: 'completed' },
        { content: '总结', status: 'in_progress' },
      ],
    })
  })

  it('rejects an invalid payload with a friendly error', async () => {
    const res = await todoWriteTool.run({ todos: [] }, ctx)
    expect(res.ok).toBe(false)
    expect((res.output as { error: string }).error).toBe('invalid_todos')
  })
})
