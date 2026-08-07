// delete_note (Task #6): deletion records an undo entry carrying the full
// pre-delete content, so the trash move is revertible in-app (and the
// snapshot is persistable).
//
// 评审修复后的契约（本套件覆盖）：
// - revert 只走 EXACT 路径（revertSnapshot）：命中 → modify；未命中 →
//   ensureFolderExists(父文件夹) + create。绝不 resolveFile 兜底——库里存在
//   同名不同目录的另一篇笔记时，revert 绝不碰它。
// - 读快照失败（vault.read 抛错）不阻断删除：trash 照常执行，只是不 pushUndo。

import { TFile, TFolder } from 'obsidian'
import type { ToolContext } from '../../core/agent/types'
import type { UndoData } from '../../utils/undoStore'
import { deleteNoteTool } from '../deleteNote'

function mkFile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.name = path.split('/').pop() ?? ''
  f.basename = f.name.replace(/\.md$/, '')
  return f
}

function mkFolder(path: string): TFolder {
  const d = new TFolder()
  d.path = path
  d.name = path.split('/').pop() ?? ''
  return d
}

interface FakeVault {
  files: Map<string, TFile>
  folders: Set<string>
  contents: Map<string, string>
  trashed: TFile[]
  created: Array<{ path: string; content: string }>
  foldersCreated: string[]
  modified: Array<{ path: string; content: string }>
  /** Flip to true to make vault.read throw (snapshot failure). */
  readError: boolean
}

function mkApp(vault: FakeVault) {
  return {
    vault: {
      getAbstractFileByPath: (p: string) => {
        const file = vault.files.get(p)
        if (file) return file
        if (vault.folders.has(p)) return mkFolder(p)
        return null
      },
      getMarkdownFiles: () => [...vault.files.values()],
      read: async (f: TFile) => {
        if (vault.readError) throw new Error('simulated read failure')
        return vault.contents.get(f.path) ?? ''
      },
      trash: async (f: TFile) => {
        vault.trashed.push(f)
        vault.files.delete(f.path)
        vault.contents.delete(f.path)
        return true
      },
      create: async (path: string, content: string) => {
        vault.created.push({ path, content })
        const f = mkFile(path)
        vault.files.set(path, f)
        vault.contents.set(path, content)
        return f
      },
      modify: async (f: TFile, content: string) => {
        vault.modified.push({ path: f.path, content })
        vault.contents.set(f.path, content)
        return f
      },
      createFolder: async (path: string) => {
        vault.foldersCreated.push(path)
        vault.folders.add(path)
        return mkFolder(path)
      },
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  }
}

function mkCtx(app: ReturnType<typeof mkApp>): ToolContext {
  return { app, confirm: async () => true, pushUndo: () => {} } as unknown as ToolContext
}

function makeVault(): FakeVault {
  const vault: FakeVault = {
    files: new Map(),
    folders: new Set(['Notes']),
    contents: new Map(),
    trashed: [],
    created: [],
    foldersCreated: [],
    modified: [],
    readError: false,
  }
  const f = mkFile('Notes/Post.md')
  vault.files.set(f.path, f)
  vault.contents.set(f.path, '# Post\nfull body here\n')
  return vault
}

describe('deleteNoteTool undo (Task #6)', () => {
  it('pushes undo with kind=delete and the full pre-delete content', async () => {
    const vault = makeVault()
    const app = mkApp(vault)
    const pushUndo = jest.fn()
    const ctx = mkCtx(app)
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    const res = await deleteNoteTool.run({ path: 'Post' }, ctx)

    expect(res.ok).toBe(true)
    expect(vault.trashed).toHaveLength(1)
    expect(pushUndo).toHaveBeenCalledTimes(1)

    const [label, revert, data] = pushUndo.mock.calls[0] as unknown as [
      string,
      () => Promise<void>,
      UndoData,
    ]
    expect(label).toBe('删除 Post')
    expect(typeof revert).toBe('function')
    expect(data.kind).toBe('delete')
    expect(data.path).toBe('Notes/Post.md')
    expect(data.before).toBe('# Post\nfull body here\n')
    expect(data.id.length).toBeGreaterThan(4)
    expect(data.label).toBe('删除 Post')
    expect(typeof data.at).toBe('number')

    // The file AND its parent folder were removed → revert must recreate
    // the folder first, then the file, with the exact snapshot.
    vault.folders.clear()
    await revert()
    expect(vault.foldersCreated).toEqual(['Notes'])
    expect(vault.created).toEqual([
      { path: 'Notes/Post.md', content: '# Post\nfull body here\n' },
    ])
  })

  it('revert restores via vault.modify when a file exists at the exact path again', async () => {
    const vault = makeVault()
    const app = mkApp(vault)
    const pushUndo = jest.fn()
    const ctx = mkCtx(app)
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    await deleteNoteTool.run({ path: 'Post' }, ctx)
    // User (or sync) brought a file back at that exact path.
    const reborn = mkFile('Notes/Post.md')
    vault.files.set(reborn.path, reborn)
    vault.contents.set(reborn.path, 'something else')

    const revert = pushUndo.mock.calls[0][1] as () => Promise<void>
    await revert()
    expect(vault.created).toHaveLength(0)
    expect(vault.modified).toEqual([{ path: 'Notes/Post.md', content: '# Post\nfull body here\n' }])
  })

  it('revert NEVER touches a same-basename note in another folder (no basename fallback)', async () => {
    const vault = makeVault()
    // An unrelated note that shares the basename "Post".
    const other = mkFile('Other/Post.md')
    vault.files.set(other.path, other)
    vault.contents.set(other.path, 'unrelated content')

    const app = mkApp(vault)
    const pushUndo = jest.fn()
    const ctx = mkCtx(app)
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    await deleteNoteTool.run({ path: 'Notes/Post.md' }, ctx)
    const revert = pushUndo.mock.calls[0][1] as () => Promise<void>
    await revert()

    // The unrelated note is untouched; the snapshot went to the exact path.
    expect(vault.contents.get('Other/Post.md')).toBe('unrelated content')
    expect(vault.modified.filter((m) => m.path === 'Other/Post.md')).toHaveLength(0)
    expect(vault.created).toEqual([
      { path: 'Notes/Post.md', content: '# Post\nfull body here\n' },
    ])
  })

  it('revert throws a descriptive error when the path is occupied by a folder', async () => {
    const vault = makeVault()
    const app = mkApp(vault)
    const pushUndo = jest.fn()
    const ctx = mkCtx(app)
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    await deleteNoteTool.run({ path: 'Notes/Post.md' }, ctx)
    // A folder grew at the exact path of the deleted note.
    vault.folders.add('Notes/Post.md')

    const revert = pushUndo.mock.calls[0][1] as () => Promise<void>
    await expect(revert()).rejects.toThrow('已被文件夹占用')
    expect(vault.created).toHaveLength(0)
    expect(vault.modified).toHaveLength(0)
  })

  it('snapshot read failure does not block the delete (trash runs, no pushUndo)', async () => {
    const vault = makeVault()
    vault.readError = true
    const app = mkApp(vault)
    const pushUndo = jest.fn()
    const ctx = mkCtx(app)
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    const res = await deleteNoteTool.run({ path: 'Post' }, ctx)

    // The delete itself succeeds — main flow always wins.
    expect(res.ok).toBe(true)
    expect(vault.trashed).toHaveLength(1)
    // Without a snapshot there is nothing safe to restore → no undo entry.
    expect(pushUndo).not.toHaveBeenCalled()
  })

  it('does not push undo when the note is missing', async () => {
    const vault = makeVault()
    vault.files.clear()
    vault.contents.clear()
    const app = mkApp(vault)
    const pushUndo = jest.fn()
    const ctx = mkCtx(app)
    ;(ctx as unknown as { pushUndo: unknown }).pushUndo = pushUndo

    const res = await deleteNoteTool.run({ path: 'Ghost' }, ctx)
    expect(res.ok).toBe(false)
    expect(pushUndo).not.toHaveBeenCalled()
  })
})
