// Task #7: refContext — wiki-link ref extraction + note expansion for the
// LLM context. Uses the same fake-app pattern as tools/__tests__.

import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import { buildRefContext, extractNoteRefs } from '../refContext'

function mkFile(path: string, extension = 'md'): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.[^.]+$/, '')
  f.extension = extension
  return f
}

interface FakeOpts {
  files?: Record<string, TFile>
  /** path → content; missing path = read() rejects. */
  contents?: Record<string, string>
}

function mkApp({ files = {}, contents = {} }: FakeOpts = {}): App {
  const all = Object.values(files)
  return {
    vault: {
      getAbstractFileByPath: (p: string) => files[p] ?? null,
      getMarkdownFiles: () => all.filter((f) => f.extension === 'md'),
      read: async (f: TFile) => {
        const c = contents[f.path]
        if (c === undefined) throw new Error(`read failed: ${f.path}`)
        return c
      },
    },
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) => files[`${linkpath}.md`] ?? null,
    },
  } as unknown as App
}

describe('extractNoteRefs', () => {
  it('extracts plain wiki links', () => {
    expect(extractNoteRefs('看 [[笔记A]] 和 [[目录/笔记B]]')).toEqual([
      '笔记A',
      '目录/笔记B',
    ])
  })

  it('strips |别名 and #锚点', () => {
    expect(extractNoteRefs('[[笔记|别名]] [[笔记#小节|别名]]')).toEqual(['笔记'])
  })

  it('excludes ![[embeds]] (including images)', () => {
    expect(extractNoteRefs('![[图片.png]] 但 [[真笔记]]')).toEqual(['真笔记'])
  })

  it('still finds a link right after an embed', () => {
    expect(extractNoteRefs('![[a.png]][[b]]')).toEqual(['b'])
  })

  it('excludes [[msg:...]] message-reference tokens', () => {
    expect(extractNoteRefs('[[msg:abc-123]] 加 [[普通笔记]]')).toEqual(['普通笔记'])
  })

  it('excludes trailing-slash folder references', () => {
    expect(extractNoteRefs('[[文件夹/]] 和 [[文件夹/内页]]')).toEqual(['文件夹/内页'])
  })

  it('de-duplicates preserving first-seen order', () => {
    expect(extractNoteRefs('[[a]] [[b]] [[a|别名]] [[a#锚]]')).toEqual(['a', 'b'])
  })

  it('returns [] for empty / linkless text', () => {
    expect(extractNoteRefs('')).toEqual([])
    expect(extractNoteRefs('没有链接的普通文本')).toEqual([])
  })
})

describe('buildRefContext', () => {
  it("returns '' for mode 'link'", async () => {
    const app = mkApp({ files: { 'a.md': mkFile('a.md') } })
    await expect(buildRefContext(app, ['a'], 'link')).resolves.toBe('')
  })

  it("returns '' for empty refs", async () => {
    await expect(buildRefContext(mkApp(), [], 'excerpt')).resolves.toBe('')
  })

  it('expands a resolvable note with its real path in the header', async () => {
    const app = mkApp({
      files: { 'notes/甲.md': mkFile('notes/甲.md') },
      contents: { 'notes/甲.md': '甲的内容' },
    })
    const out = await buildRefContext(app, ['甲'], 'excerpt')
    expect(out).toBe('【引用笔记：notes/甲.md】\n甲的内容')
  })

  it('joins multiple sections with a blank line', async () => {
    const app = mkApp({
      files: { 'a.md': mkFile('a.md'), 'b.md': mkFile('b.md') },
      contents: { 'a.md': 'AAA', 'b.md': 'BBB' },
    })
    const out = await buildRefContext(app, ['a', 'b'], 'excerpt')
    expect(out).toBe('【引用笔记：a.md】\nAAA\n\n【引用笔记：b.md】\nBBB')
  })

  it('excerpt mode truncates at 2000 chars with the marker', async () => {
    const long = 'x'.repeat(5000)
    const app = mkApp({
      files: { 'big.md': mkFile('big.md') },
      contents: { 'big.md': long },
    })
    const out = await buildRefContext(app, ['big'], 'excerpt')
    expect(out).toContain('x'.repeat(2000))
    expect(out).not.toContain('x'.repeat(2001))
    expect(out).toContain('…（后略，可用 read_note 查看全文）')
  })

  it('full mode caps at 8000 chars the same way', async () => {
    const long = 'y'.repeat(9000)
    const app = mkApp({
      files: { 'big.md': mkFile('big.md') },
      contents: { 'big.md': long },
    })
    const out = await buildRefContext(app, ['big'], 'full')
    expect(out).toContain('y'.repeat(8000))
    expect(out).not.toContain('y'.repeat(8001))
    expect(out).toContain('…（后略，可用 read_note 查看全文）')
  })

  it('degrades an unresolvable ref to a one-line notice', async () => {
    const out = await buildRefContext(mkApp(), ['不存在'], 'excerpt')
    expect(out).toBe('【引用笔记：不存在】\n（引用 不存在 无法读取）')
  })

  it('degrades a read failure to a one-line notice', async () => {
    // File resolves but vault.read rejects (no content registered).
    const app = mkApp({ files: { 'broken.md': mkFile('broken.md') } })
    const out = await buildRefContext(app, ['broken'], 'excerpt')
    expect(out).toBe('【引用笔记：broken】\n（引用 broken 无法读取）')
  })

  it('degrades non-markdown files to a one-line notice', async () => {
    const app = mkApp({
      files: { 'image.png': mkFile('image.png', 'png') },
      contents: { 'image.png': 'binary' },
    })
    const out = await buildRefContext(app, ['image.png'], 'excerpt')
    expect(out).toBe('【引用笔记：image.png】\n（引用 image.png 无法读取）')
  })

  it('expands at most 4 notes; extras degrade to link lines', async () => {
    const files: Record<string, TFile> = {}
    const contents: Record<string, string> = {}
    for (let i = 1; i <= 6; i++) {
      files[`n${i}.md`] = mkFile(`n${i}.md`)
      contents[`n${i}.md`] = `内容${i}`
    }
    const out = await buildRefContext(
      mkApp({ files, contents }),
      ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
      'excerpt',
    )
    expect(out).toContain('【引用笔记：n4.md】\n内容4')
    expect(out).not.toContain('内容5')
    expect(out).not.toContain('内容6')
    expect(out).toContain('[[n5]]')
    expect(out).toContain('[[n6]]')
  })

  it('caps the whole output at 20000 chars', async () => {
    const files: Record<string, TFile> = {}
    const contents: Record<string, string> = {}
    for (let i = 1; i <= 4; i++) {
      files[`h${i}.md`] = mkFile(`h${i}.md`)
      contents[`h${i}.md`] = 'z'.repeat(1900) // excerpt cap per note
    }
    // totalMax override keeps the test fast and deterministic.
    const out = await buildRefContext(
      mkApp({ files, contents }),
      ['h1', 'h2', 'h3', 'h4'],
      'excerpt',
      { totalMax: 4000 },
    )
    expect(out.startsWith('【引用笔记：h1.md】')).toBe(true)
    expect(out).toContain('…（后略，可用 read_note 查看全文）')
    // The truncation marker sits right after the capped prefix (+ '\n').
    const idx = out.indexOf('…（后略')
    expect(idx).toBe(4001)
  })
})
