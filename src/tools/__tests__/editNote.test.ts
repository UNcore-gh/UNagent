// edit_note str_replace mode: unique-match replacement with not_found /
// ambiguous error surfaces. Uses a minimal fake app (no ToolRegistry — it's
// a singleton and would leak state between suites).

import { TFile } from 'obsidian'
import type { ToolContext } from '../../core/agent/types'
import { editNoteTool } from '../editNote'

function mkFile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  return f
}

interface FakeVault {
  file: TFile
  content: string
  modified: string[]
}

function mkCtx(vault: FakeVault): ToolContext {
  const ctx = {
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => (p === vault.file.path ? vault.file : null),
        getMarkdownFiles: () => [vault.file],
        read: async () => vault.content,
        modify: async (_f: TFile, next: string) => {
          vault.content = next
          vault.modified.push(next)
        },
      },
      metadataCache: {
        getFirstLinkpathDest: () => null,
      },
    },
    confirm: async () => true,
    pushUndo: () => {},
  } as unknown as ToolContext
  return ctx
}

interface AmbiguousOutput {
  error: string
  count: number
  candidates: Array<{ line: number; context: string }>
}

describe('editNoteTool str_replace', () => {
  const makeVault = (content: string): FakeVault => ({
    file: mkFile('Notes/Post.md'),
    content,
    modified: [],
  })

  it('replaces a unique snippet via vault.modify and records undo', async () => {
    const vault = makeVault('# Post\ntodo: write tests\nend')
    const ctx = mkCtx(vault)
    const pushUndo = jest.fn()
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: 'write tests', content: 'ship it' },
      ctx,
    )

    expect(res.ok).toBe(true)
    expect(vault.modified).toHaveLength(1)
    expect(vault.modified[0]).toBe('# Post\ntodo: ship it\nend')
    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(res.output).toEqual({ path: 'Notes/Post.md', mode: 'str_replace' })
  })

  it('fails with ambiguous (count + candidates) and writes nothing', async () => {
    const vault = makeVault('foo one\nfoo two\nfoo three\nfoo four')
    const ctx = mkCtx(vault)

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: 'foo', content: 'bar' },
      ctx,
    )

    expect(res.ok).toBe(false)
    expect(res.summary).toBe('原文出现多处（4 次），请给出更长的唯一片段')
    const out = res.output as AmbiguousOutput
    expect(out.error).toBe('ambiguous')
    expect(out.count).toBe(4)
    expect(out.candidates.map((c) => c.line)).toEqual([1, 2, 3])
    expect(vault.modified).toHaveLength(0)
  })

  it('rejects empty old_text', async () => {
    const vault = makeVault('anything')
    const ctx = mkCtx(vault)

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: '', content: 'X' },
      ctx,
    )

    expect(res.ok).toBe(false)
    expect(res.output).toEqual({ error: 'missing_old_text' })
  })

  it('not_found carries a verbatim suggestion so the model retries without re-reading', async () => {
    // Whitespace near-miss: exact match fails, fuzzy hint must point at the
    // real line and quote it VERBATIM (copy-ready as the corrected old_text).
    const vault = makeVault('# Post\n今天 天气不错\nend')
    const ctx = mkCtx(vault)

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: '今天天气不错', content: 'X' },
      ctx,
    )

    expect(res.ok).toBe(false)
    expect(res.summary).toContain('最相似的片段')
    expect(res.summary).toContain('第 2 行')
    const out = res.output as {
      error: string
      suggestion: { startLine: number; endLine: number; text: string; similarity: number }
    }
    expect(out.error).toBe('not_found')
    expect(out.suggestion.startLine).toBe(2)
    expect(out.suggestion.text).toBe('今天 天气不错')
    expect(vault.modified).toHaveLength(0) // hint ≠ write: nothing was changed
  })

  it('suggestion also covers full/half-width punctuation near-misses', async () => {
    const vault = makeVault('# Post\n今天天气不错。\nend')
    const ctx = mkCtx(vault)

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: '今天天气不错.', content: 'X' },
      ctx,
    )

    expect(res.ok).toBe(false)
    const out = res.output as { error: string; suggestion?: { text: string } }
    expect(out.error).toBe('not_found')
    expect(out.suggestion?.text).toBe('今天天气不错。')
  })

  it('genuinely absent old_text still returns the bare not_found shape', async () => {
    const vault = makeVault('# Post\nhello')
    const ctx = mkCtx(vault)

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: 'absent text', content: 'X' },
      ctx,
    )

    expect(res.ok).toBe(false)
    expect(res.summary).toBe('未找到要替换的原文')
    expect(res.output).toEqual({ error: 'not_found' })
    expect(vault.modified).toHaveLength(0)
  })

  it('confirmSummary spells out the str_replace mode', () => {
    expect(
      editNoteTool.confirmSummary?.({ path: 'Post', mode: 'str_replace' }),
    ).toBe('编辑笔记 Post（str_replace 精确替换）')
    // Other modes keep the legacy wording.
    expect(
      editNoteTool.confirmSummary?.({ path: 'Post', mode: 'append' }),
    ).toBe('编辑笔记 Post（append）')
  })
})

describe('editNoteTool undo data (Task #6)', () => {
  const makeVault = (content: string) => ({
    file: mkFile('Notes/Post.md'),
    content,
    modified: [] as string[],
  })

  it('str_replace success passes a modify snapshot with the original content', async () => {
    const vault = makeVault('# Post\ntodo: write tests\nend')
    const ctx = mkCtx(vault)
    const pushUndo = jest.fn()
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: 'write tests', content: 'ship it' },
      ctx,
    )

    const data = pushUndo.mock.calls[0][2] as {
      id: string
      label: string
      at: number
      kind: string
      path: string
      before: string
    }
    expect(data.kind).toBe('modify')
    expect(data.path).toBe('Notes/Post.md')
    expect(data.before).toBe('# Post\ntodo: write tests\nend')
    expect(data.id.length).toBeGreaterThan(4)
    expect(data.label).toBe('编辑 Post')
    expect(typeof data.at).toBe('number')
  })

  it('append success also carries kind=modify with the pre-edit content', async () => {
    const vault = makeVault('# Post\nbody')
    const ctx = mkCtx(vault)
    const pushUndo = jest.fn()
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    const res = await editNoteTool.run(
      { path: 'Post', mode: 'append', content: 'more' },
      ctx,
    )

    expect(res.ok).toBe(true)
    const data = pushUndo.mock.calls[0][2] as { kind: string; before: string }
    expect(data.kind).toBe('modify')
    expect(data.before).toBe('# Post\nbody')
  })

  it('failed edits push no undo data', async () => {
    const vault = makeVault('foo\nfoo')
    const ctx = mkCtx(vault)
    const pushUndo = jest.fn()
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    await editNoteTool.run(
      { path: 'Post', mode: 'str_replace', old_text: 'foo', content: 'bar' },
      ctx,
    )
    expect(pushUndo).not.toHaveBeenCalled()
  })
})
