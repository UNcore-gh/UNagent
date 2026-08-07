// Adapter-level vault I/O (utils/vaultIO): the shared substrate every
// plugin-internal store (memory, conversations, skills, attachments) uses so
// dot-prefixed folders (.obsidian-ai/) work the same as visible ones. These
// tests pin the contract: never throw on missing paths, mkdir-before-write,
// idempotent remove, and folder listing over a files-only fake.

import { App } from 'obsidian'
import {
  ensureDir,
  listAllFiles,
  listDir,
  pathExists,
  readText,
  removePath,
  writeBinary,
  writeText,
} from '../vaultIO'

interface FakeState {
  app: App
  store: Record<string, string>
  dirs: Set<string>
  mkdirs: string[]
}

/** Adapter fake that also records mkdir calls (folders as explicit state). */
function mkApp(initial: Record<string, string> = {}): FakeState {
  const store: Record<string, string> = { ...initial }
  const dirs = new Set<string>()
  const mkdirs: string[] = []
  const isDir = (p: string): boolean =>
    dirs.has(p) || Object.keys(store).some((k) => k.startsWith(`${p}/`))
  const app = {
    vault: {
      adapter: {
        exists: async (p: string) => p in store || isDir(p),
        read: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p]
        },
        write: async (p: string, data: string) => {
          store[p] = data
        },
        writeBinary: async (p: string, data: ArrayBuffer) => {
          store[p] = `<binary ${data.byteLength}b>`
        },
        mkdir: async (p: string) => {
          dirs.add(p)
          mkdirs.push(p)
        },
        remove: async (p: string) => {
          delete store[p]
        },
        list: async (p: string) => {
          const files: string[] = []
          const folders = new Set<string>()
          for (const k of Object.keys(store)) {
            if (!k.startsWith(`${p}/`)) continue
            const rest = k.slice(p.length + 1)
            const slash = rest.indexOf('/')
            if (slash === -1) files.push(k)
            else folders.add(`${p}/${rest.slice(0, slash)}`)
          }
          return { files, folders: [...folders] }
        },
      },
    },
  } as unknown as App
  return { app, store, dirs, mkdirs }
}

describe('pathExists', () => {
  it('sees files, folders, and implicit dir prefixes', async () => {
    const { app } = mkApp({ '.obsidian-ai/memory.md': 'x' })
    expect(await pathExists(app, '.obsidian-ai/memory.md')).toBe(true)
    expect(await pathExists(app, '.obsidian-ai')).toBe(true) // dir prefix
    expect(await pathExists(app, 'other.md')).toBe(false)
  })

  it('is false for blank paths', async () => {
    const { app } = mkApp()
    expect(await pathExists(app, '')).toBe(false)
    expect(await pathExists(app, '   ')).toBe(false)
  })
})

describe('readText', () => {
  it('returns the content of an existing file', async () => {
    const { app } = mkApp({ 'a/b.txt': '内容' })
    expect(await readText(app, 'a/b.txt')).toBe('内容')
  })

  it('returns null when missing', async () => {
    const { app } = mkApp()
    expect(await readText(app, 'nope.md')).toBeNull()
  })

  it('returns null (never throws) when the read itself fails', async () => {
    const app = {
      vault: {
        adapter: {
          exists: async () => true,
          read: async () => {
            throw new Error('disk error')
          },
        },
      },
    } as unknown as App
    expect(await readText(app, 'a.md')).toBeNull()
  })
})

describe('writeText / writeBinary', () => {
  it('creates the parent folder chain before writing', async () => {
    const { app, store, mkdirs } = mkApp()
    await writeText(app, 'deep/nested/dir/note.md', 'hi')
    expect(store['deep/nested/dir/note.md']).toBe('hi')
    expect(mkdirs).toEqual(['deep/nested/dir'])
  })

  it('skips mkdir for files at the vault root', async () => {
    const { app, store, mkdirs } = mkApp()
    await writeText(app, 'root.md', 'x')
    expect(store['root.md']).toBe('x')
    expect(mkdirs).toEqual([])
  })

  it('writes binary bytes the same way', async () => {
    const { app, store } = mkApp()
    const bytes = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer
    await writeBinary(app, '.obsidian-ai/img/a.png', bytes)
    expect(store['.obsidian-ai/img/a.png']).toBe('<binary 3b>')
  })

  it('normalizes backslashes and duplicate slashes in paths', async () => {
    const { app, store } = mkApp()
    await writeText(app, 'a\\b//c.md', 'x')
    expect(store['a/b/c.md']).toBe('x')
  })
})

describe('ensureDir', () => {
  it('creates a missing folder and is a no-op for blank paths', async () => {
    const { app, mkdirs } = mkApp()
    await ensureDir(app, 'some/folder')
    expect(mkdirs).toEqual(['some/folder'])
    await ensureDir(app, '')
    await ensureDir(app, '/')
    expect(mkdirs).toEqual(['some/folder']) // unchanged
  })

  it('does not mkdir an existing folder', async () => {
    const { app, mkdirs } = mkApp({ 'x/f.txt': '1' })
    await ensureDir(app, 'x') // implicit dir from the file prefix
    expect(mkdirs).toEqual([])
  })
})

describe('removePath', () => {
  it('deletes an existing file', async () => {
    const { app, store } = mkApp({ 'a.md': 'x', 'b.md': 'y' })
    await removePath(app, 'a.md')
    expect(store['a.md']).toBeUndefined()
    expect(store['b.md']).toBe('y')
  })

  it('is idempotent for missing paths (never throws)', async () => {
    const { app } = mkApp()
    await expect(removePath(app, 'never.md')).resolves.toBeUndefined()
  })
})

describe('listDir', () => {
  const { app } = mkApp({
    'sk/a.md': '1',
    'sk/b/SKILL.md': '2',
    'sk/b/extra.md': '3',
    'sk/b/deep/SKILL.md': '4',
    'other/c.md': '5',
  })

  it('separates direct files from immediate subfolders', async () => {
    const { files, folders } = await listDir(app, 'sk')
    expect(files).toEqual(['sk/a.md'])
    expect(folders).toEqual(['sk/b'])
  })

  it('returns empty lists for a missing folder', async () => {
    expect(await listDir(app, 'nowhere')).toEqual({ files: [], folders: [] })
    expect(await listDir(app, '')).toEqual({ files: [], folders: [] })
  })
})

describe('listAllFiles', () => {
  it('walks every file under the folder, recursively', async () => {
    const { app } = mkApp({
      'sk/a.md': '1',
      'sk/b/SKILL.md': '2',
      'sk/b/deep/SKILL.md': '3',
      'outside.md': '4',
    })
    const all = await listAllFiles(app, 'sk')
    expect(all.sort()).toEqual([
      'sk/a.md',
      'sk/b/SKILL.md',
      'sk/b/deep/SKILL.md',
    ])
  })

  it('returns [] for a missing folder', async () => {
    const { app } = mkApp({ 'a.md': 'x' })
    expect(await listAllFiles(app, 'gone')).toEqual([])
  })
})
