// list_notes: browse the vault's FOLDER STRUCTURE — the "look" counterpart
// to search_notes' "search". Lists the DIRECT children (subfolders + files)
// of one folder, honoring the same exclusion rules as search_notes.
//
// 填补的能力缺口：agent 此前只有「搜」（search_notes）与「扁平目录」
// （library_index），无法枚举文件夹结构——「这个文件夹下有什么」与批量
// 操作前的目标枚举都无解。实现走 TFolder.children 单层读取（O(子项数)，
// 不全库扫描，移动端友好）；更深层由 agent 逐层再次调用完成。

import { TFolder, normalizePath } from 'obsidian'
import type { Tool, ToolRunResult } from '../core/agent/types'
import { isExcludedPath } from '../utils/exclusions'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

export const listNotesTool: Tool = {
  metadata: {
    name: 'list_notes',
    description:
      'Browse a folder: lists its DIRECT children (subfolders and files) one level deep. Use when the user asks what is inside a folder ("1-项目 下面有哪些笔记"), or when you need to enumerate targets before a batch operation. Omit path (or pass "") for the vault root; to go deeper, pass a subfolder path returned by a previous listing. For a whole-library overview prefer library_index; for keywords prefer search_notes.',
    category: 'search',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Folder path relative to the vault root, e.g. "1-项目". Empty or omitted = the vault root.',
        },
        limit: {
          type: 'number',
          description: `Max entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const path = normalizePath(typeof args.path === 'string' ? args.path.trim() : '')
    const limit = Math.min(
      typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT,
      MAX_LIMIT,
    )
    const excluded = ctx.excludedFolders ?? []

    let folder: TFolder
    if (path === '') {
      folder = app.vault.getRoot()
    } else {
      const node = app.vault.getAbstractFileByPath(path)
      if (node === null) {
        return {
          ok: false,
          summary: `未找到文件夹：${path}`,
          output: { error: 'not_found', path },
        }
      }
      if (!(node instanceof TFolder)) {
        return {
          ok: false,
          summary: `该路径是文件而不是文件夹：${path}`,
          output: { error: 'not_a_folder', path },
        }
      }
      folder = node
    }

    const folders: string[] = []
    const files: string[] = []
    for (const child of folder.children) {
      // Same exclusion contract as search_notes (Obsidian userIgnoreFilters
      // + plugin custom list + hidden AI data folder, pre-merged on ctx).
      if (isExcludedPath(child.path, excluded)) continue
      if (child instanceof TFolder) folders.push(child.path + '/')
      else files.push(child.path)
    }
    folders.sort((a, b) => a.localeCompare(b))
    files.sort((a, b) => a.localeCompare(b))

    const total = folders.length + files.length
    const truncated = total > limit
    // Subfolders take the slots first — they are the navigation handles.
    const listedFolders = folders.slice(0, limit)
    const listedFiles = files.slice(0, Math.max(0, limit - listedFolders.length))

    const label = path === '' ? '库根目录' : `「${path}」`
    return {
      ok: true,
      summary:
        `${label}下共有 ${total} 项（${folders.length} 个文件夹、${files.length} 个文件）` +
        (truncated ? `，仅列出前 ${limit} 项` : ''),
      output: {
        path,
        // Folder entries carry a trailing '/' so they read as paths to
        // descend into (next list_notes call); file entries are ready-to-use
        // read_note paths.
        folders: listedFolders,
        files: listedFiles,
        counts: { folders: folders.length, files: files.length },
        ...(truncated ? { truncated: true } : {}),
      },
    }
  },
}
