// create_note: create a new note (and parent folders) in the vault.

import { normalizePath } from 'obsidian'
import type { Tool, ToolRunResult } from '../core/agent/types'
import { ensureFolderExists, parentFolderOf } from './util'

export const createNoteTool: Tool = {
  metadata: {
    name: 'create_note',
    description:
      'Create a new markdown note at the given path, optionally with initial content and frontmatter. Fails if a note already exists there.',
    category: 'write',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Where to create the note, relative to the vault root, e.g. "Inbox/new idea.md".',
        },
        content: {
          type: 'string',
          description: 'Initial markdown body (without frontmatter). Optional.',
        },
        frontmatter: {
          type: 'object',
          description: 'Optional YAML frontmatter as key/value pairs.',
        },
      },
      required: ['path'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    let path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) {
      return { ok: false, summary: '缺少 path 参数', output: { error: 'missing_path' } }
    }
    path = normalizePath(path)
    if (!/\.md$/i.test(path)) path = `${path}.md`

    if (app.vault.getAbstractFileByPath(path)) {
      return {
        ok: false,
        summary: `已存在同名笔记：${path}`,
        output: { error: 'exists', path },
      }
    }

    const fm = (args.frontmatter as Record<string, unknown>) ?? undefined
    let body = typeof args.content === 'string' ? args.content : ''
    if (fm && Object.keys(fm).length > 0) {
      const yaml = Object.entries(fm)
        .map(([k, v]) => `${k}: ${formatYamlValue(v)}`)
        .join('\n')
      body = `---\n${yaml}\n---\n\n${body}`.trimEnd() + '\n'
    }

    await ensureFolderExists(app, parentFolderOf(path))
    const file = await app.vault.create(path, body)

    return {
      ok: true,
      summary: `已创建笔记「${file.basename}」`,
      output: { path: file.path, title: file.basename },
    }
  },
}

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatYamlValue).join(', ')}]`
  if (typeof value === 'string') {
    return /[:#\n]/.test(value) ? JSON.stringify(value) : value
  }
  return String(value)
}
