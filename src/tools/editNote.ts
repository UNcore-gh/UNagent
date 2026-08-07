// edit_note: append, replace a section, replace the whole body, or apply a
// precise str_replace of a unique text snippet. Destructive (confirmation
// required) and undoable (content rollback).

import type { Tool, ToolRunResult } from '../core/agent/types'
import { genUndoId } from '../utils/undoStore'
import { replaceSection, resolveFile, splitFrontmatter, strReplace } from './util'

type Mode = 'append' | 'replace_section' | 'replace_all' | 'str_replace'

export const editNoteTool: Tool = {
  metadata: {
    name: 'edit_note',
    description:
      'Edit an existing note. Modes: "append" adds text to the end; "replace_section" replaces the body under a markdown heading (keeps the heading); "replace_all" replaces the entire body (frontmatter preserved); "str_replace" precisely replaces a unique, exactly-matching text snippet (old_text) with new text. When str_replace fails to match, the error carries the closest passage found in the note (output.suggestion, verbatim) — copy it as the corrected old_text and retry directly, no need to read_note again.',
    category: 'write',
    destructive: true,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path or name.' },
        mode: {
          type: 'string',
          enum: ['append', 'replace_section', 'replace_all', 'str_replace'],
          description: 'How to apply the edit.',
        },
        section: {
          type: 'string',
          description: 'Heading title of the section to replace (required for replace_section).',
        },
        old_text: {
          type: 'string',
          description:
            '要被替换的原文，必须与笔记内容完全一致且仅出现一次（str_replace 模式必填）。',
        },
        content: {
          type: 'string',
          description: '新文本（str_replace 模式下为替换后的文本，其余模式为要追加/插入的 Markdown）。',
        },
      },
      required: ['path', 'mode', 'content'],
    },
  },

  confirmSummary(args) {
    const mode = String(args.mode ?? 'edit')
    if (mode === 'str_replace') return `编辑笔记 ${args.path}（str_replace 精确替换）`
    const section = args.section ? `「${args.section}」` : ''
    return `编辑笔记 ${args.path}（${mode}${section}）`
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const file = resolveFile(app, typeof args.path === 'string' ? args.path : '')
    if (!file) {
      return { ok: false, summary: `未找到笔记：${args.path}`, output: { error: 'not_found' } }
    }
    const mode = (typeof args.mode === 'string' ? args.mode : 'append') as Mode
    const content = typeof args.content === 'string' ? args.content : ''

    const original = await app.vault.read(file)
    let next: string

    if (mode === 'append') {
      next = original.replace(/\s*$/, '') + '\n\n' + content.trim() + '\n'
    } else if (mode === 'replace_all') {
      const { frontmatter } = splitFrontmatter(original)
      next = (frontmatter + content.trim() + '\n').replace(/^\n+/, '')
    } else if (mode === 'replace_section') {
      const section = typeof args.section === 'string' ? args.section : ''
      if (!section) {
        return { ok: false, summary: 'replace_section 需要 section 参数', output: { error: 'missing_section' } }
      }
      const { frontmatter, body } = splitFrontmatter(original)
      const replaced = replaceSection(body, section, content)
      if (replaced === null) {
        return { ok: false, summary: `未找到小节「${section}」`, output: { error: 'section_not_found', section } }
      }
      next = frontmatter + replaced
    } else if (mode === 'str_replace') {
      const oldText = typeof args.old_text === 'string' ? args.old_text : ''
      if (!oldText) {
        return { ok: false, summary: 'str_replace 需要非空的 old_text 参数', output: { error: 'missing_old_text' } }
      }
      const result = strReplace(original, oldText, content)
      if ('error' in result) {
        if (result.error === 'not_found') {
          const suggestion = result.suggestion
          if (suggestion) {
            const pct = Math.round(suggestion.similarity * 100)
            const where =
              suggestion.startLine === suggestion.endLine
                ? `第 ${suggestion.startLine} 行`
                : `第 ${suggestion.startLine}-${suggestion.endLine} 行`
            return {
              ok: false,
              summary:
                `未找到要替换的原文；笔记里最相似的片段在${where}（相似度 ${pct}%），` +
                '请参照 suggestion.text 修正 old_text 后直接重试，无需重新读取笔记',
              output: { error: 'not_found', suggestion },
            }
          }
          return { ok: false, summary: '未找到要替换的原文', output: { error: 'not_found' } }
        }
        return {
          ok: false,
          summary: `原文出现多处（${result.count} 次），请给出更长的唯一片段`,
          output: { error: 'ambiguous', count: result.count, candidates: result.candidates },
        }
      }
      next = result.next
    } else {
      return { ok: false, summary: `未知的编辑模式：${mode}`, output: { error: 'bad_mode' } }
    }

    await app.vault.modify(file, next)

    // Undo: restore the exact previous content. `data` (Task #6) carries the
    // serializable snapshot so this edit stays undoable across restarts.
    const label = `编辑 ${file.basename}`
    ctx.pushUndo(
      label,
      async () => {
        await app.vault.modify(file, original)
      },
      { id: genUndoId(), label, at: Date.now(), kind: 'modify', path: file.path, before: original },
    )

    return {
      ok: true,
      summary: `已${mode === 'append' ? '追加到' : '更新'}「${file.basename}」`,
      output: { path: file.path, mode },
    }
  },
}
