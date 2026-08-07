// todo_write: the agent's task-list (清单) tool — Claude Code's TodoWrite
// pattern. For complex multi-step tasks the model first lays out the full
// list, then re-calls this tool to move items through pending → in_progress
// → completed. Every call REPLACES the whole list; the chat UI renders the
// latest snapshot as a live checklist block. Pure in-memory: no vault access,
// nothing destructive.

import type { Tool, ToolRunResult } from '../core/agent/types'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

/** Hard caps — keeps the block compact and the schema payload sane. */
export const MAX_TODO_ITEMS = 30
export const MAX_TODO_CONTENT_LENGTH = 120

const VALID_STATUS: TodoStatus[] = ['pending', 'in_progress', 'completed']

function normalizeStatus(raw: unknown): TodoStatus | undefined {
  return typeof raw === 'string' && VALID_STATUS.includes(raw as TodoStatus)
    ? (raw as TodoStatus)
    : undefined
}

/**
 * Parse + normalize a raw `todos` argument into a clean item list.
 * Returns null when the input isn't a usable list (caller decides how to
 * surface that — the tool errors, the UI falls back to a plain tool block).
 */
export function parseTodos(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const items: TodoItem[] = []
  for (const entry of raw.slice(0, MAX_TODO_ITEMS)) {
    if (!entry || typeof entry !== 'object') return null
    const obj = entry as Record<string, unknown>
    const content =
      typeof obj.content === 'string' ? obj.content.trim() : ''
    const status = normalizeStatus(obj.status) ?? 'pending'
    if (!content) return null
    items.push({
      content:
        content.length > MAX_TODO_CONTENT_LENGTH
          ? `${content.slice(0, MAX_TODO_CONTENT_LENGTH)}…`
          : content,
      status,
    })
  }
  return items
}

/** Short progress summary for the chat UI + the model's tool result. */
export function todosSummary(items: TodoItem[]): string {
  const done = items.filter((i) => i.status === 'completed').length
  const active = items.filter((i) => i.status === 'in_progress').length
  const parts = [`${items.length} 项`]
  if (active > 0) parts.push(`进行中 ${active}`)
  parts.push(`已完成 ${done}`)
  return `清单已更新：${parts.join('，')}`
}

export const todoWriteTool: Tool = {
  metadata: {
    name: 'todo_write',
    description:
      'Create or update the task list (清单) for a complex multi-step task. Every call REPLACES the entire list — send the full list each time. Each item has content (short step description) and status: pending / in_progress / completed. Exactly one item should be in_progress while working. Use it BEFORE starting a ≥3-step task, when finishing a step, and when the task is done; skip it for simple single-step requests.',
    category: 'manage',
    destructive: false,
    requiresVault: false,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'The full task list, in execution order. Replaces any previous list.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Short description of the step (≤120 chars).',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description:
                  'pending = not started, in_progress = doing now (only one), completed = done.',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },

  async run(args): Promise<ToolRunResult> {
    const items = parseTodos(args.todos)
    if (!items) {
      return {
        ok: false,
        summary:
          '清单格式无效：todos 必须是非空数组，每项含非空 content 和 status（pending/in_progress/completed）',
        output: { error: 'invalid_todos' },
      }
    }
    return { ok: true, summary: todosSummary(items), output: { todos: items } }
  },
}
