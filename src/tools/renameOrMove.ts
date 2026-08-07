// rename_or_move: rename and/or move a note. Uses fileManager.renameFile so
// all wiki-link backlinks are updated automatically. Destructive (confirm).

import { normalizePath } from 'obsidian'
import type { Tool, ToolRunResult } from '../core/agent/types'
import { ensureFolderExists, parentFolderOf, resolveFile } from './util'

export const renameOrMoveTool: Tool = {
  metadata: {
    name: 'rename_or_move',
    description:
      'Rename and/or move a note to a new path. All links to the note are updated automatically. Provide the full destination path including the new file name.',
    category: 'manage',
    destructive: true,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Current note path or name.' },
        newPath: {
          type: 'string',
          description: 'Destination path relative to the vault root, e.g. "Archive/old name.md".',
        },
      },
      required: ['path', 'newPath'],
    },
  },

  confirmSummary(args) {
    return `把笔记 ${args.path} 移动/重命名为 ${args.newPath}`
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const file = resolveFile(app, typeof args.path === 'string' ? args.path : '')
    if (!file) {
      return { ok: false, summary: `未找到笔记：${args.path}`, output: { error: 'not_found' } }
    }

    let newPath = typeof args.newPath === 'string' ? args.newPath.trim() : ''
    if (!newPath) {
      return { ok: false, summary: '缺少 newPath 参数', output: { error: 'missing_newPath' } }
    }
    newPath = normalizePath(newPath)
    if (!/\.[^/]+$/.test(newPath)) newPath = `${newPath}.md`

    if (newPath === file.path) {
      return { ok: false, summary: '新旧路径相同', output: { error: 'same_path' } }
    }
    if (app.vault.getAbstractFileByPath(newPath)) {
      return { ok: false, summary: `目标已存在：${newPath}`, output: { error: 'exists', newPath } }
    }

    await ensureFolderExists(app, parentFolderOf(newPath))
    const oldPath = file.path
    await app.fileManager.renameFile(file, newPath)

    return {
      ok: true,
      summary: `已移动/重命名：${oldPath} → ${newPath}`,
      output: { oldPath, newPath },
    }
  },
}
