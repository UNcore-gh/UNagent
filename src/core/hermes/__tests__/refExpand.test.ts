// hermes @ 引用展开（补刀）：@file:/@folder: 注入实际内容，@diff/@staged/
// @git:/@url: 原样保留；找不到或二进制不展开。

import type { App } from 'obsidian'
import { expandHermesRefs } from '../refExpand'

function makeApp(overrides: {
  getFileByPath?: (p: string) => { path: string } | null
  read?: (f: { path: string }) => Promise<string>
  adapterRead?: (p: string) => Promise<string>
  adapterList?: (p: string) => Promise<{ files: string[]; folders: string[] }>
  getFiles?: () => { path: string; extension: string }[]
  getFileCache?: (f: { path: string }) => { tags?: { tag: string }[] } | null
}): App {
  const vault = {
    getFileByPath: overrides.getFileByPath ?? (() => null),
    read: overrides.read ?? (async () => ''),
    getFiles: overrides.getFiles ?? (() => []),
    adapter: {
      read: overrides.adapterRead ?? (async () => {
        throw new Error('not found')
      }),
      list: overrides.adapterList ?? (async () => {
        throw new Error('not found')
      }),
    },
  }
  return {
    vault,
    metadataCache: {
      getFileCache: overrides.getFileCache ?? (() => null),
    },
  } as unknown as App
}

describe('expandHermesRefs: @file', () => {
  it('expands a vault file into its content', async () => {
    const app = makeApp({
      getFileByPath: (p) => (p === 'notes/x.md' ? { path: p } : null),
      read: async () => '文件内容',
    })
    const out = await expandHermesRefs('看看 @file:notes/x.md 谢谢', app)
    expect(out).toContain('【文件 notes/x.md】')
    expect(out).toContain('文件内容')
    expect(out).not.toContain('@file:')
  })

  it('expands an external absolute path via adapter.read', async () => {
    const app = makeApp({
      getFileByPath: () => null,
      adapterRead: async (p) => (p === '/tmp/a.txt' ? '外部内容' : ''),
    })
    const out = await expandHermesRefs('@file:/tmp/a.txt', app)
    expect(out).toContain('外部内容')
  })

  it('leaves a missing file as-is', async () => {
    const app = makeApp({})
    const out = await expandHermesRefs('@file:no/such.md', app)
    expect(out).toBe('@file:no/such.md')
  })

  it('leaves a binary file (NUL byte) as-is', async () => {
    const app = makeApp({
      getFileByPath: () => ({ path: 'bin.dat' as string }),
      read: async () => '\x00\x01binary',
    })
    const out = await expandHermesRefs('@file:bin.dat', app)
    expect(out).toBe('@file:bin.dat')
  })

  it('caps oversized file content', async () => {
    const app = makeApp({
      getFileByPath: () => ({ path: 'big.md' as string }),
      read: async () => 'x'.repeat(30000),
    })
    const out = await expandHermesRefs('@file:big.md', app)
    expect(out).toContain('已截断')
    expect(out.length).toBeLessThan(21000)
  })
})

describe('expandHermesRefs: @folder', () => {
  it('injects the folder tree', async () => {
    const app = makeApp({
      adapterList: async () => ({
        files: ['src/a.ts', 'src/b.ts'],
        folders: ['src/lib'],
      }),
    })
    const out = await expandHermesRefs('树 @folder:src/', app)
    expect(out).toContain('【文件夹 src/ 目录树】')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/lib/')
  })
})

describe('expandHermesRefs: @tag', () => {
  it('lists files carrying the tag', async () => {
    const app = makeApp({
      getFiles: () => [
        { path: 'a.md', extension: 'md' },
        { path: 'b.md', extension: 'md' },
        { path: 'c.txt', extension: 'txt' },
      ],
      getFileCache: (f) =>
        f.path === 'a.md' || f.path === 'b.md'
          ? { tags: [{ tag: 'todo' }] }
          : null,
    })
    const out = await expandHermesRefs('@tag:todo', app)
    expect(out).toContain('【包含标签 #todo 的文件】')
    expect(out).toContain('a.md')
    expect(out).toContain('b.md')
    expect(out).not.toContain('c.txt')
  })

  it('leaves an unknown tag as-is', async () => {
    const app = makeApp({})
    const out = await expandHermesRefs('@tag:nope', app)
    expect(out).toBe('@tag:nope')
  })
})

describe('expandHermesRefs: leaves hermes-native refs untouched', () => {
  it('does not touch @diff / @staged / @git: / @url:', async () => {
    const app = makeApp({})
    const input = '@diff @staged @git:5 @url:https://example.com'
    const out = await expandHermesRefs(input, app)
    expect(out).toBe(input)
  })
})