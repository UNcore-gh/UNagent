// save_memory: persistent entries for the AI's brain files (追加⑲: two
// targets). Entries are injected into the system prompt at the start of
// EVERY future conversation (frozen-snapshot pattern — see
// utils/memoryStore.ts):
//   target=memory (default) → <aiFolder>/memory.md — durable facts, lessons
//   target=user             → <aiFolder>/user.md   — who the user is,
//                                                     identity, preferences
// Both are ordinary visible notes the user can open and edit at any time.
// Non-destructive (the AI acts on its own brain files), so no confirmation
// modal. Behavioral guidance lives in the schema description (hermes-agent
// does the same).

import type { Tool, ToolRunResult } from '../core/agent/types'
import {
  addMemoryEntry,
  normalizeTarget,
  removeMemoryEntry,
} from '../utils/memoryStore'

export const saveMemoryTool: Tool = {
  metadata: {
    name: 'save_memory',
    description:
      'Manage the persistent brain files that are injected into the start of EVERY future conversation. target selects the file: "user" = user profile (<aiFolder>/user.md — who the user is: identity, preferences, habits, communication style); "memory" (default) = long-term memory (<aiFolder>/memory.md — durable facts, conventions, lessons learned). action=add stores one concise single-line entry (content); action=remove deletes the entry uniquely matching a keyword (query). Only store DURABLE information the user explicitly stated — never one-off task details, guesses, or transient errors. Changes take effect next conversation.',
    category: 'write',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'add = store a new entry; remove = delete an entry by keyword.',
        },
        target: {
          type: 'string',
          enum: ['memory', 'user'],
          description:
            'Which brain file to write: "user" = user profile (who the user is); "memory" (default) = long-term facts & lessons.',
        },
        content: {
          type: 'string',
          description:
            'Entry text for action=add. One concise sentence, ≤500 chars, no line breaks.',
        },
        query: {
          type: 'string',
          description:
            'Keyword that uniquely identifies the entry to delete (action=remove).',
        },
      },
      required: ['action'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const action =
      typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
    const target = normalizeTarget(args.target)
    const targetLabel = target === 'user' ? '用户画像' : '长期记忆'

    if (action === 'add') {
      const content = typeof args.content === 'string' ? args.content : ''
      const res = await addMemoryEntry(ctx.app, content, ctx.aiFolder, target)
      if (!res.ok) {
        return {
          ok: false,
          summary: `${targetLabel}未保存：${res.error}`,
          output: { error: res.error, entries: res.entries },
        }
      }
      return {
        ok: true,
        summary: res.duplicate
          ? `这条${targetLabel}已存在，未重复保存。`
          : `已记入${targetLabel}（下次对话起生效）：${res.changed}`,
        output: {
          target,
          added: res.changed,
          duplicate: res.duplicate === true,
          entries: res.entries,
        },
      }
    }

    if (action === 'remove') {
      const query = typeof args.query === 'string' ? args.query : ''
      const res = await removeMemoryEntry(ctx.app, query, ctx.aiFolder, target)
      if (!res.ok) {
        return {
          ok: false,
          summary: `未删除：${res.error}`,
          output: { error: res.error, entries: res.entries },
        }
      }
      return {
        ok: true,
        summary: `已从${targetLabel}删除：${res.changed}`,
        output: { target, removed: res.changed, entries: res.entries },
      }
    }

    return {
      ok: false,
      summary: 'action 必须是 add 或 remove',
      output: { error: 'bad_action' },
    }
  },
}
