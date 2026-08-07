// hermes 模式 @ 候选构建：vault 全量范围、排除规则、文件夹真实枚举、
// TOTAL_CAP 分类截断、打分排序、静态上下文引用清单（git 条目已移除）、
// 标签候选排除规则。

import { App, TFile, TFolder } from 'obsidian'
import {
  buildHermesFileRefCandidates,
  buildHermesTagCandidates,
  HERMES_CONTEXT_REFS,
} from '../hermesRefs'

function mkFile(path: string, mtime: number): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.\w+$/, '')
  f.extension = f.name.includes('.') ? f.name.split('.').pop()! : 'md'
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

function mkApp(files: TFile[], folders: TFolder[]): App {
  return {
    vault: {
      getFiles: () => files,
      getAllLoadedFiles: () => [...folders],
    },
    metadataCache: { getFileCache: () => undefined },
    workspace: { getActiveFile: () => null },
  } as unknown as App
}

describe('buildHermesFileRefCandidates (vault 全量)', () => {
  const files = [
    mkFile('Work/ProjectPlan.md', 300),
    mkFile('Notes/Research.md', 200),
    mkFile('Root.md', 100),
  ]
  const folders = [mkFolder('Work'), mkFolder('Notes')]

  it('不再限活动笔记子树——全部文件夹下的文件都进候选', () => {
    const app = mkApp(files, folders)
    const r = buildHermesFileRefCandidates(app, 'md', [])
    const ids = r.map((x) => x.id)
    expect(ids).toContain('@file:Work/ProjectPlan.md')
    expect(ids).toContain('@file:Notes/Research.md')
    expect(ids).toContain('@file:Root.md')
  })

  it('insert 仍为库基路径相对路径（格式不变）', () => {
    const app = mkApp(files, folders)
    const r = buildHermesFileRefCandidates(app, 'ProjectPlan', [])
    const hit = r.find((x) => x.id === '@file:Work/ProjectPlan.md')
    expect(hit?.insert).toBe('@file:Work/ProjectPlan.md ')
  })

  it('空 query：文件夹优先，文件按 mtime 近者优先', () => {
    const app = mkApp(files, folders)
    const r = buildHermesFileRefCandidates(app, '', [])
    expect(r.map((x) => x.id)).toEqual([
      '@folder:Notes/',
      '@folder:Work/',
      '@file:Work/ProjectPlan.md',
      '@file:Notes/Research.md',
      '@file:Root.md',
    ])
  })
})

describe('buildHermesFileRefCandidates (排除规则)', () => {
  it('被排除文件夹下的文件与文件夹都不出现', () => {
    const app = mkApp(
      [mkFile('Secret/key.md', 10), mkFile('Open/readme.md', 20)],
      [mkFolder('Secret'), mkFolder('Open')],
    )
    const r = buildHermesFileRefCandidates(app, '', ['Secret'])
    const ids = r.map((x) => x.id)
    expect(ids).not.toContain('@file:Secret/key.md')
    expect(ids).not.toContain('@folder:Secret/')
    expect(ids).toContain('@file:Open/readme.md')
    expect(ids).toContain('@folder:Open/')
  })

  it('前缀同名文件夹不误伤（Secrets 不受 Secret 排除影响）', () => {
    const app = mkApp(
      [mkFile('Secrets/a.md', 10)],
      [mkFolder('Secret'), mkFolder('Secrets')],
    )
    const r = buildHermesFileRefCandidates(app, '', ['Secret'])
    const ids = r.map((x) => x.id)
    expect(ids).toContain('@file:Secrets/a.md')
    expect(ids).toContain('@folder:Secrets/')
  })
})

describe('buildHermesFileRefCandidates (文件夹真实枚举)', () => {
  it('空文件夹（无任何文件）也能作为候选', () => {
    const app = mkApp([mkFile('A/a.md', 5)], [mkFolder('A'), mkFolder('Empty')])
    const r = buildHermesFileRefCandidates(app, '', [])
    const ids = r.map((x) => x.id)
    expect(ids).toContain('@folder:Empty/')
    const empty = r.find((x) => x.id === '@folder:Empty/')
    expect(empty?.insert).toBe('@folder:Empty/ ')
    expect(empty?.icon).toBe('folder')
  })

  it('根目录不作为候选', () => {
    const root = mkFolder('/')
    const app = mkApp([mkFile('Root.md', 1)], [root, mkFolder('A')])
    const r = buildHermesFileRefCandidates(app, '', [])
    expect(r.every((x) => x.id !== '@folder:/')).toBe(true)
    expect(r.some((x) => x.id === '@folder:A/')).toBe(true)
  })
})

describe('HERMES_CONTEXT_REFS (git 条目已移除)', () => {
  it('只剩 @url: 一条静态引用', () => {
    expect(HERMES_CONTEXT_REFS.map((r) => r.id)).toEqual(['@url:'])
    expect(HERMES_CONTEXT_REFS.map((r) => r.insert)).toEqual(['@url:'])
  })

  it('不再包含任何 git 相关条目', () => {
    const all = HERMES_CONTEXT_REFS.map((r) => `${r.id} ${r.insert}`)
    expect(all.some((s) => /git|diff|staged/i.test(s))).toBe(false)
  })

  it('@url: 的 caretOffset === 5（光标停在 @url: 之后）', () => {
    expect(HERMES_CONTEXT_REFS[0].caretOffset).toBe(5)
  })
})

describe('TOTAL_CAP 分类截断（文件与文件夹分别 24 封顶）', () => {
  const manyFiles = Array.from({ length: 30 }, (_, i) =>
    mkFile(`F/file${String(i).padStart(2, '0')}.md`, i + 1),
  )
  const manyFolders = Array.from({ length: 30 }, (_, i) =>
    mkFolder(`D${String(i).padStart(2, '0')}`),
  )

  it('候选超过 24 时——文件与文件夹各截 24 后合并（共 48），不再互相挤占', () => {
    const app = mkApp(manyFiles, manyFolders)
    const r = buildHermesFileRefCandidates(app, '', [])
    const folders = r.filter((x) => x.icon === 'folder')
    const files = r.filter((x) => x.icon === 'file')
    expect(folders.length).toBe(24)
    expect(files.length).toBe(24)
    expect(r.length).toBe(48)
    // 空 query 仍保持文件夹优先。
    expect(r.slice(0, 24).every((x) => x.icon === 'folder')).toBe(true)
    expect(r.slice(24).every((x) => x.icon === 'file')).toBe(true)
  })

  it('kind=folders 只出文件夹候选（@@ 窗按需构建，文件通道不跑）', () => {
    const app = mkApp(manyFiles, manyFolders)
    const r = buildHermesFileRefCandidates(app, '', [], 'folders')
    expect(r.length).toBe(24)
    expect(r.every((x) => x.icon === 'folder')).toBe(true)
  })

  it('kind=files 只出文件候选', () => {
    const app = mkApp(manyFiles, manyFolders)
    const r = buildHermesFileRefCandidates(app, '', [], 'files')
    expect(r.length).toBe(24)
    expect(r.every((x) => x.icon === 'file')).toBe(true)
  })
})

describe('非空 query 打分排序', () => {
  it('前缀命中排在包含命中之前（即使包含命中 mtime 更新）', () => {
    const app = mkApp(
      [mkFile('myplan.md', 900), mkFile('plan.md', 10)],
      [],
    )
    const r = buildHermesFileRefCandidates(app, 'plan', [])
    expect(r.map((x) => x.id)).toEqual([
      '@file:plan.md',
      '@file:myplan.md',
    ])
  })
})

describe('buildHermesTagCandidates (排除规则)', () => {
  function mkAppWithTags(fileTags: Record<string, string[]>): App {
    const files = Object.keys(fileTags).map((p) => mkFile(p, 0))
    return {
      vault: { getFiles: () => files, getAllLoadedFiles: () => [] },
      metadataCache: {
        getFileCache: (f: TFile) => ({
          frontmatter: { tags: fileTags[f.path] },
        }),
      },
    } as unknown as App
  }

  it('被排除文件夹内文件的标签不出现（其余正常计数）', () => {
    const app = mkAppWithTags({
      'Secret/key.md': ['secret-tag'],
      'Open/readme.md': ['open-tag'],
    })
    const r = buildHermesTagCandidates(app, '', ['Secret'])
    const labels = r.map((x) => x.label)
    expect(labels).toContain('#open-tag')
    expect(labels).not.toContain('#secret-tag')
    const open = r.find((x) => x.id === '@tag:open-tag')
    expect(open?.insert).toBe('@tag:open-tag ')
  })
})
