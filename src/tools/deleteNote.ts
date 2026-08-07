// delete_note: move a note to the trash. Destructive — always confirms.
// Uses vault.trash (system trash when available), so recovery is still
// possible from the OS trash; on top of that (Task #6) we push an undo entry
// holding the full pre-delete content, so the delete can be reverted in-app
// (and survives restarts via the persisted undo store).

import type { Tool, ToolRunResult } from '../core/agent/types'
import { genUndoId } from '../utils/undoStore'
import { resolveFile, revertSnapshot } from './util'

export const deleteNoteTool: Tool = {
  metadata: {
    name: 'delete_note',
    description:
      'Delete a note by moving it to the trash. This is destructive and always asks the user for confirmation. Only use when the user clearly asks to delete something.',
    category: 'manage',
    destructive: true,
    forceConfirm: true,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path or name to delete.' },
      },
      required: ['path'],
    },
  },

  confirmSummary(args) {
    return `删除笔记 ${args.path}（将移入回收站）`
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const file = resolveFile(app, typeof args.path === 'string' ? args.path : '')
    if (!file) {
      return { ok: false, summary: `未找到笔记：${args.path}`, output: { error: 'not_found' } }
    }

    const path = file.path
    const title = file.basename
    // Snapshot the full content BEFORE trashing so the delete is revertible.
    // 评审修复：读快照失败绝不阻断删除（主流程永远优先）——before 落空时
    // 照常 trash，只是这一笔不进 undo 栈（无快照就无法安全还原）。
    let before: string | null = null
    try {
      before = await app.vault.read(file)
    } catch {
      before = null
    }
    await app.vault.trash(file, true)

    const label = `删除 ${title}`
    if (before !== null) {
      const snapshot = before
      ctx.pushUndo(
        label,
        // 评审修复：只走精确路径（revertSnapshot），禁止 resolveFile 的
        // wiki-link / basename 兜底——那可能把旧快照写进另一篇同名无关笔记。
        () => revertSnapshot(app, path, snapshot),
        { id: genUndoId(), label, at: Date.now(), kind: 'delete', path, before: snapshot },
      )
    }

    return {
      ok: true,
      summary: `已删除「${title}」（移入回收站）`,
      output: { path, deleted: true },
    }
  },
}
