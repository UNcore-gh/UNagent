// @-mention composer logic: level-based trigger detection (@/@@/@@@),
// replacement on selection, and per-level candidate building.

import { App, TFile, TFolder } from 'obsidian'
import {
  buildCandidates,
  buildDisplay,
  buildFileCandidates,
  getActiveMention,
  groupMentions,
  insertMention,
  mapDisplayToValue,
  mapValueToDisplay,
  MENTION_MARKER_PAD,
  refTokenSnippet,
  runMarkerText,
  segmentValue,
  valueFromDisplay,
} from '../mention'

// Every mention marker carries an invisible 1em pad so the textarea lays out
// the same width as the visible icon+label chip — the tests assert it too.
const P = MENTION_MARKER_PAD

describe('getActiveMention', () => {
  it('detects @ at the very start as level 1', () => {
    expect(getActiveMention('@not', 4)).toEqual({ at: 0, level: 1, query: 'not' })
  })

  it('detects @ mid-text with an empty query right after typing it', () => {
    expect(getActiveMention('请看 @', 4)).toEqual({ at: 3, level: 1, query: '' })
  })

  it('allows spaces in the query (note names contain spaces)', () => {
    expect(getActiveMention('看 @my no', 8)).toEqual({ at: 2, level: 1, query: 'my no' })
  })

  it('uses the LAST @ run before the caret', () => {
    expect(getActiveMention('@a and @b', 9)).toEqual({ at: 7, level: 1, query: 'b' })
  })

  it('reads @@ as level 2 (folders)', () => {
    expect(getActiveMention('@@folder', 8)).toEqual({ at: 0, level: 2, query: 'folder' })
    expect(getActiveMention('@@', 2)).toEqual({ at: 0, level: 2, query: '' })
  })

  it('reads @@@ as level 3 (tags)', () => {
    expect(getActiveMention('@@@tag', 6)).toEqual({ at: 0, level: 3, query: 'tag' })
  })

  it('collapses 4+ @ into level 3', () => {
    expect(getActiveMention('@@@@x', 5)).toEqual({ at: 0, level: 3, query: 'x' })
  })

  it('takes the run length of the LAST run only (a@@b → level 2)', () => {
    expect(getActiveMention('a@@b', 4)).toEqual({ at: 1, level: 2, query: 'b' })
  })

  it('picks the last run when several appear (@a @@b)', () => {
    expect(getActiveMention('@a @@b', 6)).toEqual({ at: 3, level: 2, query: 'b' })
  })

  it('returns null when there is no @', () => {
    expect(getActiveMention('plain text', 10)).toBeNull()
  })

  it('returns null when the caret is before the @', () => {
    expect(getActiveMention('hi @x', 2)).toBeNull()
  })

  it('closes on newline between @ and caret', () => {
    expect(getActiveMention('@a\nb', 4)).toBeNull()
  })

  it('closes on absurdly long queries (likely not a mention)', () => {
    const long = 'x'.repeat(61)
    expect(getActiveMention('@' + long, long.length + 1)).toBeNull()
  })
})

describe('insertMention', () => {
  it('replaces @query with the reference + trailing space', () => {
    const r = insertMention('总结 @my no', 3, 9, '[[My Note]]')
    expect(r.text).toBe('总结 [[My Note]] ')
    expect(r.caret).toBe('总结 [[My Note]] '.length)
  })

  it('keeps text after the caret intact, without doubling the space', () => {
    const r = insertMention('A @b C', 2, 4, '#work')
    expect(r.text).toBe('A #work C')
    expect(r.caret).toBe('A #work'.length)
  })

  it('adds a separating space at end of input', () => {
    const r = insertMention('A @b', 2, 4, '#work')
    expect(r.text).toBe('A #work ')
    expect(r.caret).toBe('A #work '.length)
  })

  it('replaces the whole @ run (empty query after @@)', () => {
    const r = insertMention('@@', 0, 2, '[[Work/]]')
    expect(r.text).toBe('[[Work/]] ')
    expect(r.caret).toBe('[[Work/]] '.length)
  })
})

/* ── buildCandidates: one kind per level ─────────────────────────────── */

function mkNote(path: string, mtime: number): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  f.extension = 'md'
  f.stat = { ctime: 0, mtime, size: 0 }
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  f.parent = { path: parent || '/' } as unknown as TFile['parent']
  return f
}

function mkFolder(path: string): TFolder {
  const d = new TFolder()
  d.path = path
  d.name = path.split('/').pop() ?? ''
  return d
}

function mkApp(
  notes: TFile[],
  folders: TFolder[],
  tags: Record<string, number>,
  activeFile: TFile | null,
  fileTags: Record<string, string[]> = {},
): App {
  return {
    vault: {
      getMarkdownFiles: () => notes,
      getAllLoadedFiles: () => [...folders],
    },
    metadataCache: {
      getTags: () => tags,
      getFileCache: (f: TFile) => ({
        tags: (fileTags[f.path] ?? []).map((t) => ({ tag: t })),
      }),
    },
    workspace: { getActiveFile: () => activeFile },
  } as unknown as App
}

describe('buildCandidates (per level)', () => {
  const plan = mkNote('Work/ProjectPlan.md', 300)
  const research = mkNote('Notes/Research.md', 200)
  const archive = mkFolder('archive')
  const projects = mkFolder('Work/projects')
  const app = mkApp(
    [plan, research],
    [archive, projects],
    { '#arch': 4, '#work': 9 },
    null,
  )

  it('level 1 returns ONLY notes for the query', () => {
    const { active, results } = buildCandidates(app, 'arch', 1)
    expect(active).toBeNull()
    // 'arch' matches only Research (substring); folders/tags excluded.
    expect(results.map((r) => r.kind)).toEqual(['note'])
    expect(results.map((r) => r.title)).toEqual(['Research'])
  })

  it('level 2 returns ONLY folders for the query', () => {
    const { active, results } = buildCandidates(app, 'arch', 2)
    expect(active).toBeNull()
    expect(results.map((r) => r.kind)).toEqual(['folder'])
    expect(results.map((r) => r.title)).toEqual(['archive'])
    expect(results[0].insert).toBe('[[archive/]]')
  })

  it('level 3 returns ONLY tags, with count subtitle + #insert', () => {
    const { active, results } = buildCandidates(app, 'arch', 3)
    expect(active).toBeNull()
    expect(results.map((r) => r.kind)).toEqual(['tag'])
    expect(results[0].title).toBe('#arch')
    expect(results[0].subtitle).toBe('4 篇笔记')
    expect(results[0].insert).toBe('#arch')
  })

  it('level 3 strips a leading # from the query', () => {
    const { results } = buildCandidates(app, '#wo', 3)
    expect(results.map((r) => r.title)).toEqual(['#work'])
  })

  it('level 1 pins the active note and excludes it from results', () => {
    const withActive = mkApp([plan, research], [archive], {}, plan)
    const { active, results } = buildCandidates(withActive, 'Pro', 1)
    expect(active?.title).toBe('ProjectPlan')
    expect(results.every((r) => r.title !== 'ProjectPlan')).toBe(true)
  })

  it('levels 2/3 never pin the active note', () => {
    const withActive = mkApp([plan], [archive], { '#work': 1 }, plan)
    expect(buildCandidates(withActive, '', 2).active).toBeNull()
    expect(buildCandidates(withActive, '', 3).active).toBeNull()
  })

  it('level 1 empty query → recent notes (mtime order)', () => {
    const { results } = buildCandidates(app, '', 1)
    expect(results.map((r) => r.title)).toEqual(['ProjectPlan', 'Research'])
  })

  it('level 2 empty query → folders by name', () => {
    const { results } = buildCandidates(app, '', 2)
    expect(results.map((r) => r.title)).toEqual(['archive', 'projects'])
  })

  it('level 3 empty query → tags by popularity', () => {
    const { results } = buildCandidates(app, '', 3)
    expect(results.map((r) => r.title)).toEqual(['#work', '#arch'])
  })

  it('level 1 disambiguates duplicate basenames in the insert', () => {
    const dup = mkApp([mkNote('A/Dup.md', 1), mkNote('B/Dup.md', 2)], [], {}, null)
    const { results } = buildCandidates(dup, 'Dup', 1)
    const top = results.find((r) => r.title === 'Dup')
    expect(top?.insert).toBe('[[B/Dup|Dup]]')
  })
})

/* ── buildCandidates: folder exclusions ──────────────────────────────── */

describe('buildCandidates (exclusions)', () => {
  const plan = mkNote('Work/ProjectPlan.md', 300)
  const research = mkNote('Notes/Research.md', 200)
  const secret = mkNote('Private/Secret.md', 400)
  const archive = mkFolder('archive')
  const archiveSub = mkFolder('archive/2020')
  const projects = mkFolder('Work/projects')

  it('level 1 hides notes under excluded folders', () => {
    const app = mkApp([plan, research, secret], [archive], {}, null)
    const { results } = buildCandidates(app, '', 1, ['Private'])
    // secret (newest, mtime 400) would lead without the exclusion.
    expect(results.map((r) => r.title)).toEqual(['ProjectPlan', 'Research'])
  })

  it('level 1 does not pin an active note that lives in an excluded folder', () => {
    const app = mkApp([secret], [], {}, secret)
    const { active, results } = buildCandidates(app, '', 1, ['Private'])
    expect(active).toBeNull()
    expect(results).toEqual([])
  })

  it('level 2 hides the excluded folder and everything nested under it', () => {
    const app = mkApp([], [archive, archiveSub, projects], {}, null)
    const { results } = buildCandidates(app, '', 2, ['archive'])
    expect(results.map((r) => r.title)).toEqual(['projects'])
  })

  it('level 3 recomputes tag counts over included files only', () => {
    const app = mkApp([plan, secret], [], { '#keep': 2, '#hide': 1 }, null, {
      'Work/ProjectPlan.md': ['#keep'],
      'Private/Secret.md': ['#hide', '#keep'],
    })
    const { results } = buildCandidates(app, '', 3, ['Private'])
    expect(results.map((r) => r.title)).toEqual(['#keep'])
    expect(results[0].subtitle).toBe('1 篇笔记')
  })

  it('level 3 keeps the fast getTags() path without exclusions', () => {
    const app = mkApp([], [], { '#a': 2 }, null)
    const { results } = buildCandidates(app, '', 3, [])
    expect(results.map((r) => r.title)).toEqual(['#a'])
  })
})

/* ── buildFileCandidates: the paperclip "attach any file" picker ─────── */

function mkAnyFile(path: string, mtime: number): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  const dot = f.name.lastIndexOf('.')
  f.basename = dot > 0 ? f.name.slice(0, dot) : f.name
  f.extension = dot > 0 ? f.name.slice(dot + 1) : ''
  f.stat = { ctime: 0, mtime, size: 0 }
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  f.parent = { path: parent || '/' } as unknown as TFile['parent']
  return f
}

function mkFileApp(files: TFile[]): App {
  return {
    vault: {
      getFiles: () => files,
      getMarkdownFiles: () => files.filter((f) => f.extension === 'md'),
    },
    metadataCache: { getTags: () => ({}), getFileCache: () => null },
    workspace: { getActiveFile: () => null },
  } as unknown as App
}

describe('buildFileCandidates (paperclip picker)', () => {
  const photo = mkAnyFile('Media/photo.png', 500)
  const paper = mkAnyFile('Docs/paper.pdf', 400)
  const data = mkAnyFile('Docs/data.csv', 300)
  const noteA = mkAnyFile('Notes/Alpha.md', 200)
  const noteB = mkAnyFile('Deep/Alpha.md', 100)

  it('embeds images and pdf, links other files by full path', () => {
    const app = mkFileApp([photo, paper, data])
    const png = buildFileCandidates(app, 'photo')
    expect(png).toHaveLength(1)
    expect(png[0]).toMatchObject({
      kind: 'file',
      icon: 'image',
      insert: '![[Media/photo.png]]',
    })
    const pdf = buildFileCandidates(app, 'paper')[0]
    expect(pdf.insert).toBe('![[Docs/paper.pdf]]')
    expect(pdf.icon).toBe('file')
    const csv = buildFileCandidates(app, 'data')[0]
    expect(csv.insert).toBe('[[Docs/data.csv]]')
  })

  it('gives canvas / audio / video their own icons and embeds them', () => {
    const board = mkAnyFile('Media/board.canvas', 500)
    const music = mkAnyFile('Media/song.mp3', 400)
    const app = mkFileApp([board, music])
    const canvas = buildFileCandidates(app, 'board')[0]
    expect(canvas.insert).toBe('![[Media/board.canvas]]')
    expect(canvas.icon).toBe('paintbrush')
    const audio = buildFileCandidates(app, 'song')[0]
    expect(audio.insert).toBe('![[Media/song.mp3]]')
    expect(audio.icon).toBe('audio-lines')
  })

  it('turns markdown into note-style references (unique basenames)', () => {
    const res = buildFileCandidates(mkFileApp([noteA]), 'Alpha')
    expect(res[0]).toMatchObject({ kind: 'note', insert: '[[Alpha]]' })
  })

  it('disambiguates duplicate note basenames with the path', () => {
    const res = buildFileCandidates(mkFileApp([noteA, noteB]), 'Alpha')
    const inserts = res.map((r) => r.insert)
    expect(inserts).toContain('[[Notes/Alpha|Alpha]]')
    expect(inserts).toContain('[[Deep/Alpha|Alpha]]')
  })

  it('filters excluded folders', () => {
    const app = mkFileApp([photo, mkAnyFile('secret/key.png', 999)])
    const res = buildFileCandidates(app, '', ['secret'])
    expect(res.map((r) => r.title)).toEqual(['photo.png'])
  })

  it('empty query → most recently modified first, any type', () => {
    const app = mkFileApp([data, photo, noteA])
    const res = buildFileCandidates(app, '')
    expect(res.map((r) => r.title)).toEqual(['photo.png', 'data.csv', 'Alpha'])
  })

  it('ranks exact names above substrings', () => {
    const app = mkFileApp([
      mkAnyFile('a/database.csv', 2),
      mkAnyFile('a/data.csv', 1),
    ])
    const res = buildFileCandidates(app, 'data.csv')
    expect(res[0].title).toBe('data.csv')
  })

  it('caps the list at 24 rows', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      mkAnyFile(`f${i}.txt`, i),
    )
    expect(buildFileCandidates(mkFileApp(many), '')).toHaveLength(24)
  })
})

describe('segmentValue', () => {
  it('classifies note refs, folder refs and #tags', () => {
    expect(segmentValue('看 [[笔记A]] 与 [[文件夹B/]] 里 #标签 的内容')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'mention', kind: 'file', text: '[[笔记A]]' },
      { type: 'text', text: ' 与 ' },
      { type: 'mention', kind: 'folder', text: '[[文件夹B/]]' },
      { type: 'text', text: ' 里 ' },
      { type: 'mention', kind: 'tag', text: '#标签' },
      { type: 'text', text: ' 的内容' },
    ])
  })

  it('classifies a note ref + 引用 quote as a ref (in-file text)', () => {
    expect(segmentValue('[[笔记A]]「选中片段」')).toEqual([
      {
        type: 'mention',
        kind: 'ref',
        text: '[[笔记A]]「选中片段」',
      },
    ])
  })

  it('classifies a message ref (追加46: [[msg:conv/msg]]「text」) as a ref', () => {
    expect(segmentValue('[[msg:abc123/msg-xyz]]「这段话引用自对话」')).toEqual([
      {
        type: 'mention',
        kind: 'ref',
        text: '[[msg:abc123/msg-xyz]]「这段话引用自对话」',
      },
    ])
  })

  it('a 」 left inside the snippet truncates the token (补刀85: 片段入 token 前必须清洗)', () => {
    // 没清洗时 token 在半路截断，剩余正文作为裸文字漏在 chip 旁边——
    // 这正是用户点引用按钮后看到「多出一段和 AI 输出有关的文字」的根因。
    expect(segmentValue('[[msg:a/b]]「含」漏出」')).toEqual([
      { type: 'mention', kind: 'ref', text: '[[msg:a/b]]「含」' },
      { type: 'text', text: '漏出」' },
    ])
  })

  it('handles embeds and a folder deep inside a path', () => {
    expect(segmentValue('![[img.png]] 见 [[a/b/c/]]')).toEqual([
      { type: 'mention', kind: 'file', text: '![[img.png]]' },
      { type: 'text', text: ' 见 ' },
      { type: 'mention', kind: 'folder', text: '[[a/b/c/]]' },
    ])
  })

  it('returns a single text segment when nothing matches', () => {
    expect(segmentValue('普通文本')).toEqual([{ type: 'text', text: '普通文本' }])
    expect(segmentValue('')).toEqual([])
  })
})

describe('groupMentions', () => {
  it('keeps a lone mention as a run of one', () => {
    expect(groupMentions(segmentValue('看 [[A]]'))).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'mention', kind: 'file', texts: ['[[A]]'], raw: '[[A]]' },
    ])
  })

  it('collapses same-kind mentions joined by whitespace into one run', () => {
    expect(groupMentions(segmentValue('[[A/]] [[B/]] [[C/]]'))).toEqual([
      {
        type: 'mention',
        kind: 'folder',
        texts: ['[[A/]]', '[[B/]]', '[[C/]]'],
        raw: '[[A/]] [[B/]] [[C/]]',
      },
    ])
  })

  it('does not merge across different kinds or real text', () => {
    const runs = groupMentions(segmentValue('[[A/]] [[B/]] #x [[C/]]'))
    expect(runs.map((r) => (r.type === 'mention' ? r.kind : r.type))).toEqual([
      'folder',
      'text',
      'tag',
      'text',
      'folder',
    ])
    const run0 = runs[0] as { texts: string[] }
    expect(run0.texts).toEqual(['[[A/]]', '[[B/]]'])
  })

  it('stops a run at non-whitespace text', () => {
    const runs = groupMentions(segmentValue('[[A/]] [[B/]]末尾'))
    const last = runs[runs.length - 1] as { type: string }
    expect(last.type).toBe('text')
    const run0 = runs[0] as { texts: string[] }
    expect(run0.texts).toEqual(['[[A/]]', '[[B/]]'])
  })
})

describe('runMarkerText', () => {
  it('uses kind-specific labels, with a count for multiple', () => {
    expect(runMarkerText('file', 1)).toBe('文件')
    expect(runMarkerText('file', 3)).toBe('文件×3')
    expect(runMarkerText('folder', 2)).toBe('文件夹×2')
    expect(runMarkerText('tag', 1)).toBe('标签')
    expect(runMarkerText('ref', 1)).toBe('引用')
  })
})

describe('refTokenSnippet (追加72/73: 原文收进悬停，chip 保持简洁)', () => {
  it('extracts the quoted text from a ref token', () => {
    expect(refTokenSnippet('[[画布.canvas#^abc]]「选中文字」 ')).toBe('选中文字')
    expect(refTokenSnippet('[[笔记A]]「金额: 3000」')).toBe('金额: 3000')
    expect(refTokenSnippet('[[普通文件]]')).toBe('')
  })
})

describe('buildDisplay', () => {
  it('replaces mention runs with kind-specific chips', () => {
    const { display, spans } = buildDisplay('看 [[A]] 和 [[B/]] #tag', null)
    expect(display).toBe(`看 ${P}文件 和 ${P}文件夹 ${P}标签`)
    expect(spans).toEqual([
      { vs: 2, ve: 7, ds: 2, de: 5, marker: `${P}文件`, label: '文件', kind: 'mention', mkind: 'file' },
      { vs: 10, ve: 16, ds: 8, de: 12, marker: `${P}文件夹`, label: '文件夹', kind: 'mention', mkind: 'folder' },
      { vs: 17, ve: 21, ds: 13, de: 16, marker: `${P}标签`, label: '标签', kind: 'mention', mkind: 'tag' },
    ])
  })

  it('groups same-kind mentions into one count chip', () => {
    const { display, spans } = buildDisplay('[[A]] [[B]]', null)
    expect(display).toBe(`${P}文件×2`)
    expect(spans).toEqual([
      { vs: 0, ve: 11, ds: 0, de: 5, marker: `${P}文件×2`, label: '文件×2', kind: 'mention', mkind: 'file' },
    ])
  })

  it('keeps the ref chip compact; the snippet rides in span.snippet (追加73)', () => {
    const { display, spans } = buildDisplay('看 [[画布#^n1]]「具体文字」 吧', null)
    expect(display).toBe(`看 ${P}引用 吧`)
    expect(spans[0].label).toBe('引用')
    expect(spans[0].snippet).toBe('具体文字')
  })

  it('replaces a leading known command with its label', () => {
    const { display, spans } = buildDisplay('/btw 问题', {
      end: 4,
      label: '顺便一问',
    })
    expect(display).toBe(`${P}顺便一问问题`)
    expect(spans).toEqual([
      { vs: 0, ve: 5, ds: 0, de: 5, marker: `${P}顺便一问`, label: '顺便一问', kind: 'command' },
    ])
  })

  it('leaves plain text untouched', () => {
    expect(buildDisplay('你好世界', null).display).toBe('你好世界')
    expect(buildDisplay('', null)).toEqual({ display: '', spans: [] })
  })
})

describe('mapDisplayToValue / mapValueToDisplay', () => {
  const { spans } = buildDisplay('看 [[A]] 和 [[B/]] #tag', null)

  it('maps text positions identically', () => {
    expect(mapDisplayToValue(spans, 0)).toBe(0)
    expect(mapDisplayToValue(spans, 1)).toBe(1)
    expect(mapDisplayToValue(spans, 6)).toBe(8) // the space after the first 引用
  })

  it('maps a marker end to the run end (backspace deletes the whole run)', () => {
    expect(mapDisplayToValue(spans, 5)).toBe(7) // after 文件 → after [[A]]
    expect(mapDisplayToValue(spans, 12)).toBe(16) // after 文件夹 → after [[B/]]
  })

  it('clamps positions strictly inside a marker to the run start', () => {
    expect(mapDisplayToValue(spans, 3)).toBe(2)
  })

  it('maps a value run end back to the marker end', () => {
    expect(mapValueToDisplay(spans, 7)).toBe(5)
    expect(mapValueToDisplay(spans, 16)).toBe(12)
  })
})

describe('valueFromDisplay', () => {
  it('appending text after a chip expands to raw refs + the text', () => {
    expect(valueFromDisplay('[[A]] [[B]]', `${P}文件×2，你好`, null)).toBe(
      '[[A]] [[B]]，你好',
    )
  })

  it('editing text between markers only touches that text', () => {
    expect(valueFromDisplay('看 [[A]] 很好', `看 ${P}文件 非常好`, null)).toBe(
      '看 [[A]] 非常好',
    )
  })

  it('deleting a whole chip drops the run from the raw value', () => {
    expect(valueFromDisplay('看 [[A]] 很好', '看  很好', null)).toBe('看  很好')
  })

  it('is an identity when the display is unchanged', () => {
    expect(valueFromDisplay('看 [[A]] 很好', `看 ${P}文件 很好`, null)).toBe(
      '看 [[A]] 很好',
    )
  })

  it('handles a leading command marker', () => {
    expect(
      valueFromDisplay('/btw 问题', `${P}顺便一问问题，你好`, {
        end: 4,
        label: '顺便一问',
      }),
    ).toBe('/btw 问题，你好')
  })
})
