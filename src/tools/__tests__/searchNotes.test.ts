// search_notes: folder-exclusion filtering (Obsidian userIgnoreFilters +
// plugin custom list arrive pre-merged on ctx.excludedFolders).

import { TFile } from 'obsidian'
import type { ToolContext } from '../../core/agent/types'
import { searchNotesTool } from '../searchNotes'

function mkFile(path: string, tags: string[] = []): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  f.parent = { path: parent } as unknown as TFile['parent']
  ;(f as unknown as { _tags: string[] })._tags = tags
  return f
}

function mkCtx(
  files: TFile[],
  excludedFolders: string[],
  contents: Map<string, string> = new Map(),
): ToolContext {
  return {
    app: {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: async (f: TFile) => contents.get(f.path) ?? '',
      },
      metadataCache: {
        getFileCache: (f: TFile) => ({
          tags: ((f as unknown as { _tags?: string[] })._tags ?? []).map(
            (t) => ({ tag: t }),
          ),
        }),
      },
    },
    confirm: async () => true,
    pushUndo: () => {},
    imageProvider: {},
    excludedFolders,
  } as unknown as ToolContext
}

interface SearchOutput {
  count: number
  results: Array<{ path: string; matchedIn?: string; snippet?: string }>
}

describe('searchNotesTool exclusions', () => {
  const pub = mkFile('Notes/Pub.md')
  const priv = mkFile('Private/Priv.md')

  it('skips files under excluded folders', async () => {
    const res = await searchNotesTool.run({}, mkCtx([pub, priv], ['Private']))
    const out = res.output as SearchOutput
    expect(out.count).toBe(1)
    expect(out.results[0].path).toBe('Notes/Pub.md')
  })

  it('returns everything when nothing is excluded', async () => {
    const res = await searchNotesTool.run({}, mkCtx([pub, priv], []))
    expect((res.output as SearchOutput).count).toBe(2)
  })

  it('exclusions apply alongside keyword queries too', async () => {
    const res = await searchNotesTool.run(
      { query: 'priv' },
      mkCtx([pub, priv], ['Private']),
    )
    expect((res.output as SearchOutput).count).toBe(0)
  })

  it('still matches files whose name merely prefixes an excluded folder', async () => {
    const privy = mkFile('Notes/PrivateNotes.md')
    const res = await searchNotesTool.run({}, mkCtx([privy], ['Private']))
    expect((res.output as SearchOutput).count).toBe(1)
  })
})

describe('searchNotesTool content scan', () => {
  // Keyword appears ONLY in the body of one note — never in name/path/tags.
  const body = mkFile('Notes/Journal.md')
  const contents = new Map([
    ['Notes/Journal.md', '今天天气不错，xylophone 这个词出现在正文里。'],
  ])

  it('content=true finds body-only matches with snippet + matchedIn', async () => {
    const res = await searchNotesTool.run(
      { query: 'xylophone', content: true },
      mkCtx([body], [], contents),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(1)
    expect(out.results[0].path).toBe('Notes/Journal.md')
    expect(out.results[0].matchedIn).toBe('content')
    expect(out.results[0].snippet).toContain('xylophone')
  })

  it('default (no content param): zero metadata hits fall back to body scan', async () => {
    // 根治「短语只写在正文里就永远搜不到」——无需 agent 传 content:true。
    const res = await searchNotesTool.run(
      { query: 'xylophone' },
      mkCtx([body], [], contents),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(1)
    expect(out.results[0].path).toBe('Notes/Journal.md')
    expect(out.results[0].matchedIn).toBe('content')
    expect(out.results[0].snippet).toContain('xylophone')
  })

  it('weak metadata recall (<3 stray hits) still triggers the body scan', async () => {
    // 元数据偶然命中一条不能挡住正文里的真匹配。
    const stray = mkFile('Notes/xylophone.md')
    const res = await searchNotesTool.run(
      { query: 'xylophone' },
      mkCtx([stray, body], [], contents),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(2)
    expect(out.results[0].path).toBe('Notes/xylophone.md') // metadata 优先
    expect(out.results[1].path).toBe('Notes/Journal.md')
    expect(out.results[1].matchedIn).toBe('content')
  })

  it('strong metadata recall (≥3 hits) skips the body scan (cost guard)', async () => {
    const hits = [mkFile('Notes/xylophone-1.md'), mkFile('Notes/xylophone-2.md'), mkFile('Notes/xylophone-3.md')]
    const res = await searchNotesTool.run(
      { query: 'xylophone' },
      mkCtx([...hits, body], [], contents),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(3)
    expect(out.results.every((r) => r.matchedIn === undefined)).toBe(true)
  })

  it('content=true: excluded folders are never body-scanned', async () => {
    const res = await searchNotesTool.run(
      { query: 'xylophone', content: true },
      mkCtx([body], ['Notes'], contents),
    )
    expect((res.output as SearchOutput).count).toBe(0)
  })

  it('metadata matches keep priority and get matchedIn=metadata', async () => {
    const byName = mkFile('Notes/xylophone.md')
    const res = await searchNotesTool.run(
      { query: 'xylophone', content: true },
      mkCtx([byName, body], [], contents),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(2)
    expect(out.results[0].path).toBe('Notes/xylophone.md')
    expect(out.results[0].matchedIn).toBe('metadata')
    expect(out.results[1].matchedIn).toBe('content')
  })
})

describe('searchNotesTool multi-token recall + ranking', () => {
  it('matches ANY token instead of requiring the whole phrase', async () => {
    const plan = mkFile('Notes/旅行计划.md')
    const other = mkFile('Notes/读书笔记.md')
    const res = await searchNotesTool.run(
      { query: '旅行 完全不相关的词' },
      mkCtx([plan, other], []),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(1)
    expect(out.results[0].path).toBe('Notes/旅行计划.md')
  })

  it('ranks basename hits above tag-only hits and exposes score', async () => {
    const byName = mkFile('Notes/alpha.md')
    const byTag = mkFile('Notes/misc.md', ['alpha'])
    const res = await searchNotesTool.run(
      { query: 'alpha' },
      mkCtx([byTag, byName], []),
    )
    const out = res.output as SearchOutput & {
      results: Array<{ path: string; score?: number }>
    }
    expect(out.count).toBe(2)
    expect(out.results[0].path).toBe('Notes/alpha.md')
    expect(out.results[0].score).toBeGreaterThan(out.results[1].score ?? 0)
  })

  it('CJK bigram fallback recalls compound words in different order', async () => {
    // '知识管理' never appears verbatim; bigrams 知识/管理 both do.
    const note = mkFile('Notes/管理我的知识.md')
    const res = await searchNotesTool.run(
      { query: '知识管理' },
      mkCtx([note], []),
    )
    const out = res.output as SearchOutput
    expect(out.count).toBe(1)
    expect(out.results[0].path).toBe('Notes/管理我的知识.md')
  })

  it('keeps the no-query output shape untouched (no score field)', async () => {
    const note = mkFile('Notes/任意.md')
    const res = await searchNotesTool.run({}, mkCtx([note], []))
    const out = res.output as SearchOutput & {
      results: Array<{ score?: number }>
    }
    expect(out.results[0].score).toBeUndefined()
  })
})
