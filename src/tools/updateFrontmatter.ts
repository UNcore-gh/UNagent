// update_frontmatter: add/update/delete YAML frontmatter keys via Obsidian's
// fileManager.processFrontMatter (keeps formatting sane, mobile-safe).
// Undoable: restores the previous frontmatter values.

import type { Tool, ToolRunResult } from '../core/agent/types'
import { getFrontmatterClone, resolveFile } from './util'

export const updateFrontmatterTool: Tool = {
  metadata: {
    name: 'update_frontmatter',
    description:
      'Add, update, or delete YAML frontmatter keys on a note. Pass key/value pairs in "updates" to set them, and key names in "deleteKeys" to remove them.',
    category: 'write',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path or name.' },
        updates: {
          type: 'object',
          description: 'Key/value pairs to set in the frontmatter.',
        },
        deleteKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Frontmatter keys to remove.',
        },
      },
      required: ['path'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const file = resolveFile(app, typeof args.path === 'string' ? args.path : '')
    if (!file) {
      return { ok: false, summary: `未找到笔记：${args.path}`, output: { error: 'not_found' } }
    }

    const updates = (args.updates as Record<string, unknown>) ?? {}
    const deleteKeys = Array.isArray(args.deleteKeys)
      ? args.deleteKeys.filter((k): k is string => typeof k === 'string')
      : []

    if (Object.keys(updates).length === 0 && deleteKeys.length === 0) {
      return { ok: false, summary: '没有可应用的更改', output: { error: 'no_changes' } }
    }

    const before = getFrontmatterClone(app, file)

    await app.fileManager.processFrontMatter(file, (fm) => {
      for (const [k, v] of Object.entries(updates)) fm[k] = v
      for (const k of deleteKeys) delete fm[k]
    })

    // Undo: restore prior values (delete keys that didn't exist before).
    ctx.pushUndo(`修改 ${file.basename} 的 frontmatter`, async () => {
      await app.fileManager.processFrontMatter(file, (fm) => {
        for (const k of Object.keys(updates)) delete fm[k]
        for (const k of deleteKeys) delete fm[k]
        for (const [k, v] of Object.entries(before)) fm[k] = v
      })
    })

    const changed = [...Object.keys(updates), ...deleteKeys]
    return {
      ok: true,
      summary: `已更新「${file.basename}」的 frontmatter（${changed.join('、')}）`,
      output: { path: file.path, updated: Object.keys(updates), deleted: deleteKeys },
    }
  },
}
