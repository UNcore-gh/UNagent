// contentSearch: pure snippet extraction + capped/batched body scanning.
// Fakes expose vault.cachedRead backed by a Map — no registry involved.

import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import { extractSnippet, scanContent } from '../contentSearch'

function mkFile(path: string, size?: number): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  if (size !== undefined) f.stat = { ctime: 0, mtime: 0, size }
  return f
}

function mkApp(contents: Map<string, string>): { app: App; reads: string[] } {
  const reads: string[] = []
  const app = {
    vault: {
      cachedRead: async (f: TFile) => {
        reads.push(f.path)
        const c = contents.get(f.path)
        if (c === undefined) throw new Error(`unreadable: ${f.path}`)
        return c
      },
    },
  } as unknown as App
  return { app, reads }
}

describe('extractSnippet', () => {
  it('centers the hit with … on both sides (middle hit)', () => {
    const content = 'a'.repeat(100) + 'Target' + 'b'.repeat(100)
    const snippet = extractSnippet(content, 'target', 60)
    expect(snippet).toContain('Target') // original casing preserved
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(60 + 6 + 60 + 2)
  })

  it('omits the leading … when the hit is at the start', () => {
    const content = 'Target' + 'x'.repeat(200)
    const snippet = extractSnippet(content, 'Target', 60)
    expect(snippet.startsWith('Target')).toBe(true)
    expect(snippet.startsWith('…')).toBe(false)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('omits the trailing … when the hit is at the end', () => {
    const content = 'x'.repeat(200) + 'Target'
    const snippet = extractSnippet(content, 'Target', 60)
    expect(snippet.endsWith('Target')).toBe(true)
    expect(snippet.endsWith('…')).toBe(false)
    expect(snippet.startsWith('…')).toBe(true)
  })

  it('returns the whole content without … when nothing is clipped', () => {
    const content = 'xx Target xx'
    expect(extractSnippet(content, 'Target', 60)).toBe('xx Target xx')
  })

  it('returns empty string on miss or empty input', () => {
    expect(extractSnippet('hello world', 'zebra')).toBe('')
    expect(extractSnippet('', 'anything')).toBe('')
    expect(extractSnippet('hello', '')).toBe('')
  })
})

describe('scanContent', () => {
  it('finds body matches and returns path/title/snippet', async () => {
    const hit = mkFile('Notes/A.md')
    const miss = mkFile('Notes/B.md')
    const { app } = mkApp(
      new Map([
        ['Notes/A.md', '前缀文本 Zebra 出现在这里'],
        ['Notes/B.md', '完全不相关的正文'],
      ]),
    )
    const hits = await scanContent(app, [hit, miss], ['zebra'], { limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe('Notes/A.md')
    expect(hits[0].title).toBe('A')
    expect(hits[0].snippet).toContain('Zebra')
  })

  it('stops at limit', async () => {
    const files = Array.from({ length: 5 }, (_, i) => mkFile(`N/${i}.md`))
    const contents = new Map(files.map((f) => [f.path, 'needle here']))
    const { app } = mkApp(contents)
    const hits = await scanContent(app, files, ['needle'], { limit: 2 })
    expect(hits).toHaveLength(2)
  })

  it('returns partial results when the signal is aborted', async () => {
    const files = Array.from({ length: 3 }, (_, i) => mkFile(`N/${i}.md`))
    const contents = new Map(files.map((f) => [f.path, 'needle here']))
    const { app, reads } = mkApp(contents)
    const ctrl = new AbortController()
    ctrl.abort() // already aborted → returns immediately with no reads
    const hits = await scanContent(app, files, ['needle'], {
      limit: 10,
      signal: ctrl.signal,
    })
    expect(hits).toEqual([])
    expect(reads).toHaveLength(0)
  })

  it('caps the scan at 300 files', async () => {
    const files = Array.from({ length: 320 }, (_, i) => mkFile(`N/${i}.md`))
    const contents = new Map(files.map((f) => [f.path, 'needle inside']))
    const { app, reads } = mkApp(contents)
    const hits = await scanContent(app, files, ['needle'], { limit: 500 })
    expect(reads.length).toBeLessThanOrEqual(300)
    expect(hits.length).toBeLessThanOrEqual(300)
  })

  it('skips files larger than 512KB (stat size or content length)', async () => {
    const bigStat = mkFile('Big/Stat.md', 600 * 1024)
    const bigBody = mkFile('Big/Body.md') // small stat, oversized content
    const small = mkFile('Small/Ok.md')
    const { app, reads } = mkApp(
      new Map([
        ['Big/Body.md', 'z'.repeat(512 * 1024 + 1) + ' needle'],
        ['Small/Ok.md', 'needle inside'],
      ]),
    )
    const hits = await scanContent(app, [bigStat, bigBody, small], ['needle'], {
      limit: 10,
    })
    expect(reads).not.toContain('Big/Stat.md') // skipped before reading
    expect(hits.map((h) => h.path)).toEqual(['Small/Ok.md'])
  })

  it('only searches the first 50000 chars of each body', async () => {
    const file = mkFile('N/Deep.md')
    const { app } = mkApp(
      new Map([['N/Deep.md', 'x'.repeat(60000) + 'needle']]),
    )
    const hits = await scanContent(app, [file], ['needle'], { limit: 10 })
    expect(hits).toEqual([])
  })

  it('skips unreadable files and keeps scanning the rest', async () => {
    const broken = mkFile('N/Broken.md')
    const ok = mkFile('N/Ok.md')
    const { app } = mkApp(new Map([['N/Ok.md', 'needle inside']]))
    const hits = await scanContent(app, [broken, ok], ['needle'], { limit: 10 })
    expect(hits.map((h) => h.path)).toEqual(['N/Ok.md'])
  })

  it('completes batched scans across many files without hanging', async () => {
    // 40 files = 3 batches (16/16/8) — exercises the inter-batch yields.
    const files = Array.from({ length: 40 }, (_, i) => mkFile(`N/${i}.md`))
    const contents = new Map(files.map((f) => [f.path, `note ${f.path} needle`]))
    const { app } = mkApp(contents)
    const hits = await scanContent(app, files, ['needle'], { limit: 40 })
    expect(hits).toHaveLength(40)
  })
})
