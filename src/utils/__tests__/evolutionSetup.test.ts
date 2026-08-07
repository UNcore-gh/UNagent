// Storage evolution (追加⑲): legacy hidden .obsidian-ai/ → visible AI 助手/
// migration, plus the brain-file seeding. Runs on an adapter-level fake
// vault — the legacy folder is dot-prefixed and invisible to Obsidian's
// indexed APIs, exactly what the migration must cope with in reality.

import { App } from 'obsidian'
import {
  AGENT_TEMPLATE,
  LEGACY_AI_FOLDER,
  MEMORY_TEMPLATE,
  USER_TEMPLATE,
  agentDocPath,
  ensureBrainFiles,
  evolveAgentsLayout,
  migrateDataFolder,
  migrateLegacyFolder,
} from '../evolutionSetup'
import { parseMemoryEntries } from '../memoryStore'

function mkApp(
  initial: Record<string, string> = {},
  dirs: string[] = [],
): {
  app: App
  store: Record<string, string>
  rmdirs: string[]
} {
  const store: Record<string, string> = { ...initial }
  const dirSet = new Set<string>(dirs)
  const rmdirs: string[] = []
  const isDir = (p: string): boolean =>
    dirSet.has(p) || Object.keys(store).some((k) => k.startsWith(`${p}/`))
  const app = {
    vault: {
      adapter: {
        exists: async (p: string) => p in store || isDir(p),
        read: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p]
        },
        readBinary: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p] as unknown as ArrayBuffer
        },
        write: async (p: string, data: string) => {
          store[p] = data
        },
        writeBinary: async (p: string, data: ArrayBuffer) => {
          store[p] = String(data)
        },
        mkdir: async (p: string) => {
          dirSet.add(p)
        },
        remove: async (p: string) => {
          delete store[p]
        },
        rmdir: async (p: string) => {
          dirSet.delete(p)
          rmdirs.push(p)
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
          for (const d of dirSet) {
            if (!d.startsWith(`${p}/`)) continue
            const rest = d.slice(p.length + 1)
            if (!rest.includes('/')) folders.add(d)
          }
          return { files, folders: [...folders] }
        },
      },
    },
  } as unknown as App
  return { app, store, rmdirs }
}

describe('migrateLegacyFolder', () => {
  it('returns null when there is no legacy folder', async () => {
    const { app } = mkApp({ 'notes/a.md': 'x' })
    expect(await migrateLegacyFolder(app, 'AI 助手')).toBeNull()
  })

  it('refuses to migrate onto itself', async () => {
    const { app } = mkApp({ '.obsidian-ai/memory.md': 'x' })
    expect(await migrateLegacyFolder(app, LEGACY_AI_FOLDER)).toBeNull()
  })

  it('moves every file (nested included) preserving relative paths', async () => {
    const { app, store } = mkApp({
      '.obsidian-ai/memory.md': '# AI 记忆\n\n- 旧记忆\n',
      '.obsidian-ai/conversations/index.json': '{"entries":[]}',
      '.obsidian-ai/conversations/c1.json': '{"id":"c1"}',
      '.obsidian-ai/skills/my/SKILL.md': '---\nname: my\n---\n',
    })
    const res = await migrateLegacyFolder(app, 'AI 助手')
    expect(res).toEqual({ moved: 4, skipped: 0 })
    expect(store['AI 助手/memory.md']).toBe('# AI 记忆\n\n- 旧记忆\n')
    expect(store['AI 助手/conversations/c1.json']).toBe('{"id":"c1"}')
    expect(store['AI 助手/conversations/index.json']).toBe('{"entries":[]}')
    expect(store['AI 助手/skills/my/SKILL.md']).toContain('name: my')
    // Sources are gone.
    expect(store['.obsidian-ai/memory.md']).toBeUndefined()
    expect(store['.obsidian-ai/conversations/c1.json']).toBeUndefined()
  })

  it('skips junk dot-files like .DS_Store', async () => {
    const { app, store } = mkApp({
      '.obsidian-ai/.DS_Store': 'junk',
      '.obsidian-ai/memory.md': 'x',
    })
    const res = await migrateLegacyFolder(app, 'AI 助手')
    expect(res?.moved).toBe(1)
    expect(store['AI 助手/.DS_Store']).toBeUndefined()
  })

  it('sweeps junk files out of the source so the legacy folder is removed (追加65)', async () => {
    const { app, store, rmdirs } = mkApp(
      {
        '.obsidian-ai/.DS_Store': 'junk',
        '.obsidian-ai/conversations/._c1.json': 'apple-double',
        '.obsidian-ai/conversations/c1.json': '{}',
      },
      ['.obsidian-ai', '.obsidian-ai/conversations'],
    )
    const res = await migrateLegacyFolder(app, 'AI 助手')
    expect(res?.moved).toBe(1)
    // Junk left behind by Finder/AppleDouble must not block cleanup.
    expect(store['.obsidian-ai/.DS_Store']).toBeUndefined()
    expect(store['.obsidian-ai/conversations/._c1.json']).toBeUndefined()
    expect(rmdirs).toContain('.obsidian-ai/conversations')
    expect(rmdirs).toContain('.obsidian-ai')
  })

  it('keeps the destination on conflict and removes the duplicate source', async () => {
    const { app, store } = mkApp({
      '.obsidian-ai/memory.md': '旧内容',
      'AI 助手/memory.md': '新内容',
    })
    const res = await migrateLegacyFolder(app, 'AI 助手')
    expect(res).toEqual({ moved: 0, skipped: 1 })
    expect(store['AI 助手/memory.md']).toBe('新内容')
    expect(store['.obsidian-ai/memory.md']).toBeUndefined() // duplicate deleted
  })

  it('sweeps the emptied legacy folder tree', async () => {
    const { app, rmdirs } = mkApp(
      { '.obsidian-ai/conversations/c1.json': '{}' },
      ['.obsidian-ai', '.obsidian-ai/conversations'],
    )
    await migrateLegacyFolder(app, 'AI 助手')
    expect(rmdirs).toContain('.obsidian-ai/conversations')
    expect(rmdirs).toContain('.obsidian-ai')
  })

  it('sweeps the legacy folder after duplicate files are removed', async () => {
    const { app, rmdirs } = mkApp(
      {
        '.obsidian-ai/memory.md': '旧内容',
        'AI 助手/memory.md': '新内容', // conflict → duplicate source deleted
      },
      ['.obsidian-ai'],
    )
    await migrateLegacyFolder(app, 'AI 助手')
    expect(rmdirs).toContain('.obsidian-ai')
  })
})

describe('migrateDataFolder (追加64: 设置页切换数据文件夹迁移)', () => {
  it('returns null when the source folder does not exist', async () => {
    const { app } = mkApp({ 'notes/a.md': 'x' })
    expect(await migrateDataFolder(app, 'old-data', 'new-data')).toBeNull()
  })

  it('returns null for empty / identical paths', async () => {
    const { app } = mkApp({ 'old-data/memory.md': 'x' })
    expect(await migrateDataFolder(app, '', 'new-data')).toBeNull()
    expect(await migrateDataFolder(app, 'old-data', 'old-data')).toBeNull()
    expect(await migrateDataFolder(app, 'old-data', ' old-data/')).toBeNull()
  })

  it('moves every file (nested included) preserving relative paths', async () => {
    const { app, store, rmdirs } = mkApp(
      {
        'old-data/memory.md': '# AI 记忆\n\n- 旧记忆\n',
        'old-data/conversations/index.json': '{"entries":[]}',
        'old-data/conversations/c1.json': '{"id":"c1"}',
        'old-data/skills/my/SKILL.md': '---\nname: my\n---\n',
      },
      ['old-data', 'old-data/conversations', 'old-data/skills'],
    )
    const res = await migrateDataFolder(app, 'old-data', 'new-data')
    expect(res).toEqual({ moved: 4, skipped: 0 })
    expect(store['new-data/memory.md']).toBe('# AI 记忆\n\n- 旧记忆\n')
    expect(store['new-data/conversations/c1.json']).toBe('{"id":"c1"}')
    expect(store['new-data/skills/my/SKILL.md']).toContain('name: my')
    // Sources are gone and the emptied tree is swept.
    expect(store['old-data/memory.md']).toBeUndefined()
    expect(store['old-data/conversations/c1.json']).toBeUndefined()
    expect(rmdirs).toContain('old-data')
  })

  it('keeps BOTH sides on conflict (unlike the legacy migration)', async () => {
    const { app, store } = mkApp({
      'old-data/memory.md': '旧内容',
      'new-data/memory.md': '新内容',
    })
    const res = await migrateDataFolder(app, 'old-data', 'new-data')
    expect(res).toEqual({ moved: 0, skipped: 1 })
    expect(store['new-data/memory.md']).toBe('新内容')
    // 保守语义：目标可能含用户自己的文件 —— 源保留，不删。
    expect(store['old-data/memory.md']).toBe('旧内容')
  })

  it('skips junk dot-files like .DS_Store', async () => {
    const { app, store } = mkApp({
      'old-data/.DS_Store': 'junk',
      'old-data/memory.md': 'x',
    })
    const res = await migrateDataFolder(app, 'old-data', 'new-data')
    expect(res?.moved).toBe(1)
    expect(store['new-data/.DS_Store']).toBeUndefined()
    // The junk is dropped from the source as well (追加65) — otherwise it
    // blocks removal of the old folder and “旧位置移除” silently fails.
    expect(store['old-data/.DS_Store']).toBeUndefined()
  })

  it('removes the old folder tree completely when only junk remains (追加65)', async () => {
    const { app, store, rmdirs } = mkApp(
      {
        'old-data/.DS_Store': 'junk',
        'old-data/conversations/._index.json': 'apple-double',
        'old-data/conversations/c1.json': '{}',
      },
      ['old-data', 'old-data/conversations'],
    )
    const res = await migrateDataFolder(app, 'old-data', 'new-data')
    expect(res?.moved).toBe(1)
    expect(store['old-data/.DS_Store']).toBeUndefined()
    expect(store['old-data/conversations/._index.json']).toBeUndefined()
    expect(rmdirs).toContain('old-data/conversations')
    expect(rmdirs).toContain('old-data')
  })

  it('never deletes user dot-files inside the source (追加65)', async () => {
    const { app, store, rmdirs } = mkApp(
      {
        'old-data/memory.md': 'x',
        'old-data/.trash/deleted-note.md': '用户删除的笔记',
      },
      ['old-data', 'old-data/.trash'],
    )
    const res = await migrateDataFolder(app, 'old-data', 'new-data')
    expect(res?.moved).toBe(1)
    // Only system junk is swept — the user's dot-folder content stays put
    // (and thus keeps the old folder alive, which is the safe outcome).
    expect(store['old-data/.trash/deleted-note.md']).toBe('用户删除的笔记')
    expect(rmdirs).not.toContain('old-data')
  })

  it('trims slashes around both paths', async () => {
    const { app, store } = mkApp({ 'old-data/memory.md': 'x' })
    const res = await migrateDataFolder(app, '/old-data/', '/new-data/')
    expect(res?.moved).toBe(1)
    expect(store['new-data/memory.md']).toBe('x')
  })
})

describe('evolveAgentsLayout', () => {
  it('moves loose persona notes into one-folder-per-agent layout (追加75)', async () => {
    const { app, store } = mkApp({
      'AI 助手/agents/追问启发.md': `---
name: 追问启发
emoji: 🎓
---
人设正文`,
    })
    const res = await evolveAgentsLayout(app, 'AI 助手/agents')
    expect(res).toEqual({ moved: 1, skipped: 0 })
    expect(store['AI 助手/agents/追问启发/subagent.md']).toContain('name: 追问启发')
    expect(store['AI 助手/agents/追问启发.md']).toBeUndefined()
  })

  it('tucks agent data files into the matching agent folder (追问启发·进度.md)', async () => {
    const { app, store } = mkApp({
      'AI 助手/agents/追问启发.md': '---\nname: 追问启发\n---\n人设',
      'AI 助手/agents/追问启发·进度.md': '# 追问启发 · 进度\n\n- 档位：1\n',
    })
    const res = await evolveAgentsLayout(app, 'AI 助手/agents')
    expect(res).toEqual({ moved: 2, skipped: 0 })
    expect(store['AI 助手/agents/追问启发/subagent.md']).toContain('追问启发')
    expect(store['AI 助手/agents/追问启发/进度.md']).toContain('- 档位：1')
    expect(store['AI 助手/agents/追问启发.md']).toBeUndefined()
    expect(store['AI 助手/agents/追问启发·进度.md']).toBeUndefined()
  })

  it('leaves unattributable data files in place', async () => {
    const { app, store } = mkApp({
      'AI 助手/agents/追问启发.md': '---\nname: 追问启发\n---\n人设',
      'AI 助手/agents/孤零零.md': '无法归属的产物',
    })
    const res = await evolveAgentsLayout(app, 'AI 助手/agents')
    expect(res).toEqual({ moved: 1, skipped: 0 })
    expect(store['AI 助手/agents/孤零零.md']).toBe('无法归属的产物')
  })

  it('keeps the source when the target subagent.md already exists', async () => {
    const { app, store } = mkApp({
      'AI 助手/agents/追问启发.md': '---\nname: 追问启发\n---\n旧人设',
      'AI 助手/agents/追问启发/subagent.md': '---\nname: 追问启发\n---\n新人设',
    })
    const res = await evolveAgentsLayout(app, 'AI 助手/agents')
    expect(res).toEqual({ moved: 0, skipped: 1 })
    expect(store['AI 助手/agents/追问启发.md']).toContain('旧人设')
    expect(store['AI 助手/agents/追问启发/subagent.md']).toContain('新人设')
  })

  it('is a no-op once the new layout is in place (idempotent)', async () => {
    const { app, store } = mkApp({
      'AI 助手/agents/追问启发/subagent.md': '---\nname: 追问启发\n---\n人设',
    })
    const res = await evolveAgentsLayout(app, 'AI 助手/agents')
    expect(res).toEqual({ moved: 0, skipped: 0 })
    expect(store['AI 助手/agents/追问启发/subagent.md']).toContain('人设')
  })

  it('returns zeros when the folder is missing', async () => {
    const { app } = mkApp({})
    expect(await evolveAgentsLayout(app, 'AI 助手/agents')).toEqual({
      moved: 0,
      skipped: 0,
    })
  })
})

describe('ensureBrainFiles', () => {
  it('seeds all three evolution files under the folder', async () => {
    const { app, store } = mkApp()
    await ensureBrainFiles(app, 'AI 助手')
    expect(store['AI 助手/agent.md']).toBe(AGENT_TEMPLATE)
    expect(store['AI 助手/memory.md']).toBe(MEMORY_TEMPLATE)
    expect(store['AI 助手/user.md']).toBe(USER_TEMPLATE)
  })

  it('never overwrites existing content', async () => {
    const { app, store } = mkApp({
      'AI 助手/agent.md': '# 我自定义的人设\n',
    })
    await ensureBrainFiles(app, 'AI 助手')
    expect(store['AI 助手/agent.md']).toBe('# 我自定义的人设\n')
    // Missing siblings still get seeded.
    expect(store['AI 助手/memory.md']).toBe(MEMORY_TEMPLATE)
  })
})

describe('evolution templates', () => {
  it('entry-based notes start with zero injectable bullets', () => {
    // Only "- …" lines of memory.md / user.md are ever injected into the
    // system prompt — both seeded notes must start life with zero entries.
    // (agent.md is different: it is injected WHOLE as a document, so its
    // persona bullets are content, not entries.)
    expect(parseMemoryEntries(MEMORY_TEMPLATE)).toEqual([])
    expect(parseMemoryEntries(USER_TEMPLATE)).toEqual([])
  })

  it('all templates carry a heading and usage explanation', () => {
    for (const t of [AGENT_TEMPLATE, MEMORY_TEMPLATE, USER_TEMPLATE]) {
      expect(t.startsWith('# ')).toBe(true)
      expect(t.length).toBeGreaterThan(50)
    }
  })

  it('agentDocPath derives the persona file location', () => {
    expect(agentDocPath()).toBe('AI 助手/agent.md')
    expect(agentDocPath('my-data')).toBe('my-data/agent.md')
  })
})
