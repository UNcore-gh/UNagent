// list_notes: one-level folder browsing with the same exclusion contract as
// search_notes. Fake vault = a small TFolder/TFile tree built from the jest
// obsidian stub (same classes the tool's instanceof checks run against).

import { TFile, TFolder } from 'obsidian'
import type { ToolContext } from '../../core/agent/types'
import { listNotesTool } from '../listNotes'

function mkFile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  return f
}

function mkFolder(path: string, children: Array<TFile | TFolder>): TFolder {
  const d = new TFolder()
  d.path = path
  d.name = path.split('/').pop() ?? ''
  d.children = children
  return d
}

function findByPath(
  root: TFolder,
  path: string,
): TFile | TFolder | null {
  if (path === '') return root
  const walk = (node: TFolder): TFile | TFolder | null => {
    for (const child of node.children) {
      if (child.path === path) return child as TFile | TFolder
      if (child instanceof TFolder) {
        const hit = walk(child)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(root)
}

function mkCtx(root: TFolder, excludedFolders: string[] = []): ToolContext {
  return {
    app: {
      vault: {
        getRoot: () => root,
        getAbstractFileByPath: (p: string) => findByPath(root, p),
      },
    },
    confirm: async () => true,
    pushUndo: () => {},
    imageProvider: {},
    excludedFolders,
  } as unknown as ToolContext
}

interface ListOutput {
  path: string
  folders: string[]
  files: string[]
  counts: { folders: number; files: number }
  truncated?: boolean
}

// A representative tree: root → (1-项目, AI 助手, 根笔记.md); 1-项目 →
// (子目录A, a.md, b.md, 附件.pdf).
const projects = mkFolder('1-项目', [
  mkFile('1-项目/b.md'),
  mkFolder('1-项目/子目录A', []),
  mkFile('1-项目/a.md'),
  mkFile('1-项目/附件.pdf'),
])
const aiFolder = mkFolder('AI 助手', [mkFile('AI 助手/memory.md')])
const rootNote = mkFile('根笔记.md')
const buildRoot = () => mkFolder('', [projects, aiFolder, rootNote])

describe('listNotesTool', () => {
  it('lists the vault root one level deep, folders first and sorted', async () => {
    const res = await listNotesTool.run({}, mkCtx(buildRoot()))
    const out = res.output as ListOutput
    expect(res.ok).toBe(true)
    expect(out.path).toBe('')
    expect(out.folders).toEqual(['1-项目/', 'AI 助手/'])
    expect(out.files).toEqual(['根笔记.md'])
    expect(out.counts).toEqual({ folders: 2, files: 1 })
    expect(out.truncated).toBeUndefined()
  })

  it('lists a nested folder by path prefix', async () => {
    const res = await listNotesTool.run({ path: '1-项目' }, mkCtx(buildRoot()))
    const out = res.output as ListOutput
    expect(res.ok).toBe(true)
    expect(out.folders).toEqual(['1-项目/子目录A/'])
    // Files sorted; non-markdown files are included (browse = 看看有什么).
    expect(out.files).toEqual(['1-项目/a.md', '1-项目/b.md', '1-项目/附件.pdf'])
  })

  it('tolerates surrounding/trailing slashes in the path', async () => {
    const res = await listNotesTool.run({ path: '/1-项目/' }, mkCtx(buildRoot()))
    expect(res.ok).toBe(true)
    expect((res.output as ListOutput).path).toBe('1-项目')
  })

  it('honors the exclusion contract shared with search_notes', async () => {
    const res = await listNotesTool.run({}, mkCtx(buildRoot(), ['AI 助手']))
    const out = res.output as ListOutput
    expect(out.folders).toEqual(['1-项目/'])
    expect(res.summary).toContain('1 个文件夹')
  })

  it('fails with not_found for a missing folder', async () => {
    const res = await listNotesTool.run({ path: '不存在' }, mkCtx(buildRoot()))
    expect(res.ok).toBe(false)
    expect(res.output).toEqual({ error: 'not_found', path: '不存在' })
  })

  it('fails with not_a_folder when the path is a file', async () => {
    const res = await listNotesTool.run({ path: '根笔记.md' }, mkCtx(buildRoot()))
    expect(res.ok).toBe(false)
    expect(res.output).toEqual({ error: 'not_a_folder', path: '根笔记.md' })
  })

  it('lists an empty folder as zero entries', async () => {
    const res = await listNotesTool.run(
      { path: '1-项目/子目录A' },
      mkCtx(buildRoot()),
    )
    const out = res.output as ListOutput
    expect(res.ok).toBe(true)
    expect(out.folders).toEqual([])
    expect(out.files).toEqual([])
    expect(out.counts).toEqual({ folders: 0, files: 0 })
  })

  it('truncates to the limit with folders taking priority', async () => {
    const res = await listNotesTool.run({ path: '1-项目', limit: 2 }, mkCtx(buildRoot()))
    const out = res.output as ListOutput
    expect(res.ok).toBe(true)
    // 1 folder slot consumed first, then 1 file; counts keep the true totals.
    expect(out.folders).toEqual(['1-项目/子目录A/'])
    expect(out.files).toEqual(['1-项目/a.md'])
    expect(out.truncated).toBe(true)
    expect(out.counts).toEqual({ folders: 1, files: 3 })
    expect(res.summary).toContain('仅列出前 2 项')
  })

  it('returns everything below the limit without the truncated flag', async () => {
    const res = await listNotesTool.run({ path: '1-项目', limit: 300 }, mkCtx(buildRoot()))
    expect((res.output as ListOutput).truncated).toBeUndefined()
  })
})
