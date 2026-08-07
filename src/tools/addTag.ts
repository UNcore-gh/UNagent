// add_tag: add or remove tags on a note's frontmatter. Undoable.

import type { Tool, ToolRunResult } from '../core/agent/types'
import { resolveFile } from './util'

export const addTagTool: Tool = {
  metadata: {
    name: 'add_tag',
    description:
      'Add or remove tags in a note\'s frontmatter "tags" field. Tags are normalized without a leading "#". Set remove=true to delete the given tags instead.',
    category: 'write',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path or name.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add (or remove when remove=true).',
        },
        remove: {
          type: 'boolean',
          description: 'When true, remove the given tags instead of adding them.',
        },
      },
      required: ['path', 'tags'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const file = resolveFile(app, typeof args.path === 'string' ? args.path : '')
    if (!file) {
      return { ok: false, summary: `未找到笔记：${args.path}`, output: { error: 'not_found' } }
    }

    const incoming = (Array.isArray(args.tags) ? args.tags : [])
      .map((t) => (typeof t === 'string' ? t.replace(/^#/, '').trim() : ''))
      .filter((t) => t.length > 0)
    if (incoming.length === 0) {
      return { ok: false, summary: '没有提供标签', output: { error: 'no_tags' } }
    }
    const remove = args.remove === true

    let before: string[] = []
    await app.fileManager.processFrontMatter(file, (fm) => {
      const existing = Array.isArray(fm.tags)
        ? fm.tags.map((t: unknown) => String(t).replace(/^#/, ''))
        : typeof fm.tags === 'string'
          ? [fm.tags.replace(/^#/, '')]
          : []
      before = existing
      const set = new Set(existing.filter((t: string) => t.length > 0))
      for (const t of incoming) {
        if (remove) set.delete(t)
        else set.add(t)
      }
      fm.tags = Array.from(set)
    })

    ctx.pushUndo(`${remove ? '删除' : '添加'} ${file.basename} 的标签`, async () => {
      await app.fileManager.processFrontMatter(file, (fm) => {
        fm.tags = before
      })
    })

    return {
      ok: true,
      summary: `已${remove ? '删除' : '添加'}「${file.basename}」的标签：${incoming.join('、')}`,
      output: { path: file.path, removed: remove, tags: incoming },
    }
  },
}
