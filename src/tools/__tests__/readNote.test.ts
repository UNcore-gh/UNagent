// read_note: windowed reading of over-long notes (first window / offset
// continuation / final window without nextOffset). Fakes only expose what
// resolveFile + readNote touch.

import { TFile } from 'obsidian'
import type { ToolContext } from '../../core/agent/types'
import { readNoteTool } from '../readNote'

const MAX = 20000

function mkFile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  f.parent = { path: parent } as unknown as TFile['parent']
  return f
}

function mkCtx(file: TFile, content: string): ToolContext {
  return {
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
        read: async () => content,
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter: { title: file.basename } }),
      },
    },
    confirm: async () => true,
    pushUndo: () => {},
    imageProvider: {},
    excludedFolders: [],
  } as unknown as ToolContext
}

interface ReadOutput {
  content: string
  truncated?: boolean
  totalLength: number
  offset?: number
  nextOffset?: number
}

// Deterministic body: 52000 chars, every 10-char block encodes its index so
// window boundaries are easy to assert against.
const FULL = Array.from({ length: 5200 }, (_, i) =>
  String(i % 10000).padStart(5, '0') + String(i % 100).padStart(5, '0'),
).join('')

describe('readNoteTool windowed reads', () => {
  const file = mkFile('Long/Epic.md')

  it('first window (no offset): truncates at 20000 and reports totalLength + continuation fields', async () => {
    const res = await readNoteTool.run({ path: 'Long/Epic.md' }, mkCtx(file, FULL))
    const out = res.output as ReadOutput
    expect(res.ok).toBe(true)
    expect(out.content).toBe(FULL.slice(0, MAX))
    expect(out.truncated).toBe(true)
    expect(out.totalLength).toBe(52000)
    // 评审修复：首窗截断也要给出续读契约字段（offset: 0 / nextOffset）。
    expect(out.offset).toBe(0)
    expect(out.nextOffset).toBe(MAX)
    expect(res.summary).toContain('已截断')
  })

  it('second window (offset=20000): reads 20001-40000 and offers nextOffset', async () => {
    const res = await readNoteTool.run(
      { path: 'Long/Epic.md', offset: MAX },
      mkCtx(file, FULL),
    )
    const out = res.output as ReadOutput
    expect(res.ok).toBe(true)
    expect(out.content).toBe(FULL.slice(MAX, MAX * 2))
    expect(out.offset).toBe(MAX)
    expect(out.totalLength).toBe(52000)
    expect(out.nextOffset).toBe(MAX * 2)
    expect(res.summary).toContain('第 20001-40000 字')
    expect(res.summary).toContain('共 52000 字')
  })

  it('final window: returns the remainder and omits nextOffset', async () => {
    const res = await readNoteTool.run(
      { path: 'Long/Epic.md', offset: MAX * 2 },
      mkCtx(file, FULL),
    )
    const out = res.output as ReadOutput
    expect(res.ok).toBe(true)
    expect(out.content).toBe(FULL.slice(MAX * 2)) // 12000 chars
    expect(out.nextOffset).toBeUndefined()
    expect('nextOffset' in out).toBe(false)
    expect(res.summary).toContain('第 40001-52000 字')
  })

  it('offset beyond the end: empty content, ok=true, no nextOffset', async () => {
    const res = await readNoteTool.run(
      { path: 'Long/Epic.md', offset: 99999 },
      mkCtx(file, FULL),
    )
    const out = res.output as ReadOutput
    expect(res.ok).toBe(true)
    expect(out.content).toBe('')
    expect('nextOffset' in out).toBe(false)
  })

  it('short note without offset: unchanged behavior (+ totalLength)', async () => {
    const short = mkFile('Short.md')
    const res = await readNoteTool.run(
      { path: 'Short.md' },
      mkCtx(short, 'hello world'),
    )
    const out = res.output as ReadOutput
    expect(res.ok).toBe(true)
    expect(out.content).toBe('hello world')
    expect(out.truncated).toBe(false)
    expect(out.totalLength).toBe(11)
    // 未截断时不带续读字段（offset/nextOffset 只属于截断首窗）。
    expect('offset' in out).toBe(false)
    expect('nextOffset' in out).toBe(false)
    expect(res.summary).toBe('已读取「Short」')
  })
})
