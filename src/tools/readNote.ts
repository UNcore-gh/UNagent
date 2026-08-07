// read_note: read a note's body + frontmatter by path/name.

import type { Tool, ToolRunResult } from '../core/agent/types'
import { getFrontmatterClone, resolveFile } from './util'

const MAX_CONTENT_CHARS = 20000

export const readNoteTool: Tool = {
  metadata: {
    name: 'read_note',
    description:
      'Read the full content and frontmatter of a single note. Use when you already know which note you need (find it with search_notes first if unsure). For very long notes only the first window is returned — pass offset (see nextOffset in the output) to continue reading.',
    category: 'read',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Note path relative to the vault root, e.g. "Projects/plan.md" (a bare note name also works).',
        },
        offset: {
          type: 'number',
          description: '字符偏移，从该位置开始读取（用于续读超长笔记）',
        },
      },
      required: ['path'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const path = typeof args.path === 'string' ? args.path : ''
    const file = resolveFile(ctx.app, path)
    if (!file) {
      return {
        ok: false,
        summary: `未找到笔记：${path}`,
        output: { error: 'not_found', path },
      }
    }

    const full = await ctx.app.vault.read(file)
    const totalLength = full.length
    const frontmatter = getFrontmatterClone(ctx.app, file)

    // Windowed read: resume from `offset` (continuation of a truncated note).
    const offsetArg = args.offset
    if (typeof offsetArg === 'number' && Number.isFinite(offsetArg) && offsetArg >= 0) {
      const offset = Math.floor(offsetArg)
      const content = full.slice(offset, offset + MAX_CONTENT_CHARS)
      if (content.length === 0) {
        return {
          ok: true,
          summary: `已读取「${file.basename}」：偏移 ${offset} 超出全文（共 ${totalLength} 字）`,
          output: {
            path: file.path,
            title: file.basename,
            frontmatter,
            content: '',
            totalLength,
            offset,
          },
        }
      }
      const nextOffset = offset + content.length < totalLength
        ? offset + content.length
        : undefined
      return {
        ok: true,
        summary: `已读取「${file.basename}」第 ${offset + 1}-${offset + content.length} 字 / 共 ${totalLength} 字`,
        output: {
          path: file.path,
          title: file.basename,
          frontmatter,
          content,
          totalLength,
          offset,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        },
      }
    }

    let content = full
    let truncated = false
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS)
      truncated = true
    }

    return {
      ok: true,
      summary: `已读取「${file.basename}」${truncated ? '（内容过长，已截断）' : ''}`,
      output: {
        path: file.path,
        title: file.basename,
        frontmatter,
        content,
        truncated,
        totalLength,
        // 评审修复：工具描述承诺了 nextOffset 续读契约——首窗截断时同样要给出
        // offset: 0 与 nextOffset（= 本窗长度），模型才知道从哪里续读。
        ...(truncated ? { offset: 0, nextOffset: MAX_CONTENT_CHARS } : {}),
      },
    }
  },
}
