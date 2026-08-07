// Persistent conversation store: one JSON file per conversation + a metadata
// index (self-healing via folder scan), multi-level tree flattening, and the
// path-safety of id→filename mapping. Uses an in-memory ADAPTER fake — no
// real Obsidian runtime needed. Deliberately, the fake exposes ONLY
// vault.adapter (no getFiles / getAbstractFileByPath): that mirrors reality
// for the dot-prefixed default data folder (.obsidian-ai/), which Obsidian's
// indexed vault APIs cannot see, and guards the regression where history
// looked empty because the scan went through getFiles().

import { App } from 'obsidian'
import type { UiMessage } from '../../components/chat-view/types'
import {
  ConversationMeta,
  StoredConversation,
  conversationsFolder,
  conversationDepth,
  deleteConversation,
  deriveTitle,
  flattenConversationTree,
  loadConversation,
  loadIndex,
  normalizeAiFolder,
  rebuildIndex,
  saveConversation,
  sanitizeMessages,
} from '../conversationStore'

/** In-memory adapter fake (files only — folders are implicit path prefixes). */
function mkApp(initial: Record<string, string> = {}): {
  app: App
  store: Record<string, string>
} {
  const store: Record<string, string> = { ...initial }
  const isDir = (p: string): boolean =>
    Object.keys(store).some((k) => k.startsWith(`${p}/`))
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
        mkdir: async (_p: string) => undefined,
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
  return { app, store }
}

const msgs = (...contents: string[]): UiMessage[] =>
  contents.map((content, i) =>
    i % 2 === 0
      ? { id: `u${i}`, role: 'user' as const, content }
      : { id: `a${i}`, role: 'assistant' as const, blocks: [{ kind: 'text' as const, text: content }] },
  )

function mkConv(over: Partial<StoredConversation> & { id: string }): StoredConversation {
  return {
    version: 1,
    title: '对话',
    createdAt: 100,
    updatedAt: 100,
    parentId: null,
    parentMessageCount: 0,
    messageCount: 2,
    messages: msgs('你好', '你好！'),
    thinking: 'off',
    modelOverride: null,
    ...over,
  }
}

describe('normalizeAiFolder / conversationsFolder', () => {
  it('falls back to the default when blank', () => {
    expect(normalizeAiFolder(undefined)).toBe('AI 助手')
    expect(normalizeAiFolder('   ')).toBe('AI 助手')
  })

  it('trims surrounding slashes', () => {
    expect(normalizeAiFolder('/my-ai/')).toBe('my-ai')
  })

  it('derives the conversations subfolder path', () => {
    expect(conversationsFolder()).toBe('AI 助手/conversations')
    expect(conversationsFolder('x')).toBe('x/conversations')
  })
})

describe('deriveTitle', () => {
  it('uses the first user message, whitespace flattened', () => {
    expect(deriveTitle(msgs('帮我\n  整理  笔记', '好'))).toBe('帮我 整理 笔记')
  })

  it('caps long titles at 24 chars with an ellipsis', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五'
    expect(deriveTitle(msgs(long))).toBe(`${long.slice(0, 24)}…`)
  })

  it('falls back to 新对话 without user content', () => {
    expect(deriveTitle([])).toBe('新对话')
    expect(
      deriveTitle([
        { id: 'a', role: 'assistant', blocks: [{ kind: 'text', text: 'x' }] },
      ]),
    ).toBe('新对话')
  })
})

describe('sanitizeMessages', () => {
  it('clears the mid-stream flag before persisting', () => {
    const list: UiMessage[] = [
      { id: 'u', role: 'user', content: 'hi' },
      { id: 'a', role: 'assistant', blocks: [], isStreaming: true },
    ]
    const out = sanitizeMessages(list)
    expect(out[1].isStreaming).toBe(false)
    expect(list[1].isStreaming).toBe(true) // original untouched
  })

  it('drops ephemeral /btw exchanges — they are display-only', () => {
    const list: UiMessage[] = [
      { id: 'u1', role: 'user', content: '正经问题' },
      { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: '答' }] },
      { id: 'u2', role: 'user', content: '/btw 顺便问个小问题', ephemeral: true },
      {
        id: 'a2',
        role: 'assistant',
        blocks: [{ kind: 'text', text: '顺带一答' }],
        ephemeral: true,
      },
    ]
    const out = sanitizeMessages(list)
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(out.some((m) => m.ephemeral)).toBe(false)
    expect(list.length).toBe(4) // original untouched
  })
})

describe('saveConversation + loadConversation', () => {
  it('round-trips a conversation and fills null-tolerant defaults', async () => {
    const { app, store } = mkApp()
    const conv = mkConv({ id: 'c1', title: '周报' })
    await saveConversation(app, undefined, conv)

    expect(store['AI 助手/conversations/c1.json']).toBeDefined()
    const back = await loadConversation(app, undefined, 'c1')
    expect(back?.title).toBe('周报')
    expect(back?.parentId).toBeNull()
    expect(back?.thinking).toBe('off')
    expect(back?.modelOverride).toBeNull()
    expect(back?.messages.length).toBe(2)
  })

  it('honors a custom AI folder', async () => {
    const { app, store } = mkApp()
    await saveConversation(app, 'my-ai', mkConv({ id: 'c1' }))
    expect(store['my-ai/conversations/c1.json']).toBeDefined()
    expect(store['AI 助手/conversations/c1.json']).toBeUndefined()
    expect(await loadConversation(app, 'my-ai', 'c1')).not.toBeNull()
  })

  it('sanitizes ids so the filename cannot escape the folder', async () => {
    const { app, store } = mkApp()
    await saveConversation(app, undefined, mkConv({ id: 'a/../../evil' }))
    // Every non-[a-zA-Z0-9_-] char is stripped → "aevil".
    expect(store['AI 助手/conversations/aevil.json']).toBeDefined()
    expect(
      Object.keys(store).some((p) => p.includes('evil.json') && p.includes('../')),
    ).toBe(false)
  })

  it('returns null for a missing or corrupt file', async () => {
    const { app } = mkApp({
      'AI 助手/conversations/bad.json': '{not json',
      'AI 助手/conversations/shapeless.json': JSON.stringify({ nope: 1 }),
    })
    expect(await loadConversation(app, undefined, 'missing')).toBeNull()
    expect(await loadConversation(app, undefined, 'bad')).toBeNull()
    expect(await loadConversation(app, undefined, 'shapeless')).toBeNull()
  })
})

describe('index', () => {
  it('is upserted most-recently-updated-first on each save', async () => {
    const { app } = mkApp()
    await saveConversation(app, undefined, mkConv({ id: 'a', updatedAt: 100 }))
    await saveConversation(app, undefined, mkConv({ id: 'b', updatedAt: 300 }))
    await saveConversation(app, undefined, mkConv({ id: 'a', updatedAt: 400 }))

    const entries = await loadIndex(app, undefined)
    expect(entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(entries[0].updatedAt).toBe(400)
  })

  it('rebuilds itself by scanning when missing', async () => {
    const { app, store } = mkApp({
      'AI 助手/conversations/a.json': JSON.stringify(
        mkConv({ id: 'a', updatedAt: 100 }),
      ),
      'AI 助手/conversations/b.json': JSON.stringify(
        mkConv({ id: 'b', updatedAt: 200 }),
      ),
    })
    const entries = await loadIndex(app, undefined)
    expect(entries.map((e) => e.id)).toEqual(['b', 'a'])
    // …and persists the rebuilt index for next time.
    expect(store['AI 助手/conversations/index.json']).toBeDefined()
  })

  it('rebuilds when the index file is corrupt', async () => {
    const { app } = mkApp({
      'AI 助手/conversations/index.json': '{{{',
      'AI 助手/conversations/a.json': JSON.stringify(mkConv({ id: 'a' })),
    })
    const entries = await loadIndex(app, undefined)
    expect(entries.map((e) => e.id)).toEqual(['a'])
  })

  it('drops invalid index entries instead of failing', async () => {
    const { app } = mkApp({
      'AI 助手/conversations/index.json': JSON.stringify({
        version: 1,
        entries: [{ id: 'ok', title: '好' }, { junk: true }, 42],
      }),
    })
    const entries = await loadIndex(app, undefined)
    expect(entries.map((e) => e.id)).toEqual(['ok'])
  })

  it('skips unreadable files during a rebuild (rebuildIndex is lenient)', async () => {
    const { app } = mkApp({
      'AI 助手/conversations/good.json': JSON.stringify(
        mkConv({ id: 'good' }),
      ),
      'AI 助手/conversations/bad.json': 'not-json',
      'AI 助手/conversations/index.json': 'corrupt',
    })
    const entries = await rebuildIndex(app, undefined)
    expect(entries.map((e) => e.id)).toEqual(['good'])
  })

  it('finds history inside a dot folder the indexed vault APIs cannot see', async () => {
    // Regression: the fake app exposes ONLY vault.adapter — exactly the
    // situation for a dot-prefixed data folder under real Obsidian (users
    // may still point aiFolder at one; legacy installs used .obsidian-ai),
    // where getFiles() returns nothing. History must still be discovered
    // and indexed.
    const { app, store } = mkApp({
      '.obsidian-ai/conversations/only.json': JSON.stringify(
        mkConv({ id: 'only', title: '你好' }),
      ),
    })
    const entries = await loadIndex(app, '.obsidian-ai')
    expect(entries.map((e) => e.id)).toEqual(['only'])
    expect(entries[0].title).toBe('你好')
    // The self-healed index is persisted next to the conversations.
    expect(store['.obsidian-ai/conversations/index.json']).toBeDefined()
  })
})

describe('deleteConversation', () => {
  it('removes the file and its index entry', async () => {
    const { app, store } = mkApp()
    await saveConversation(app, undefined, mkConv({ id: 'a' }))
    await saveConversation(app, undefined, mkConv({ id: 'b', updatedAt: 200 }))
    await deleteConversation(app, undefined, 'a')

    expect(store['AI 助手/conversations/a.json']).toBeUndefined()
    expect((await loadIndex(app, undefined)).map((e) => e.id)).toEqual(['b'])
  })

  it('is idempotent for unknown ids', async () => {
    const { app } = mkApp()
    await saveConversation(app, undefined, mkConv({ id: 'a' }))
    await expect(
      deleteConversation(app, undefined, 'never-existed'),
    ).resolves.toBeUndefined()
    expect((await loadIndex(app, undefined)).length).toBe(1)
  })

  it("deletes the conversation's bound attachments, not unrelated notes (追加⑱)", async () => {
    const { app, store } = mkApp({
      'attachments/pic1.png': '<binary>',
      'attachments/doc.pdf': '<binary>',
      'notes/keepme.md': 'an unrelated vault note',
    })
    await saveConversation(
      app,
      undefined,
      mkConv({
        id: 'a',
        attachments: ['attachments/pic1.png', 'attachments/doc.pdf'],
      }),
    )
    await deleteConversation(app, undefined, 'a')

    expect(store['attachments/pic1.png']).toBeUndefined()
    expect(store['attachments/doc.pdf']).toBeUndefined()
    // A note the user referenced (not an attachment) is untouched.
    expect(store['notes/keepme.md']).toBe('an unrelated vault note')
    expect(store['AI 助手/conversations/a.json']).toBeUndefined()
  })
})

describe('flattenConversationTree', () => {
  const meta = (
    id: string,
    over: Partial<ConversationMeta> = {},
  ): ConversationMeta => ({
    id,
    title: id,
    createdAt: 100,
    updatedAt: 100,
    parentId: null,
    parentMessageCount: 0,
    messageCount: 1,
    ...over,
  })

  it('orders roots by updatedAt desc and children by createdAt asc', () => {
    const metas = [
      meta('r1', { updatedAt: 200, createdAt: 100 }),
      meta('r2', { updatedAt: 300, createdAt: 50 }),
      meta('c1', { parentId: 'r1', createdAt: 110 }),
      meta('c2', { parentId: 'r1', createdAt: 105 }),
      meta('orphan', { parentId: 'gone', updatedAt: 50 }),
    ]
    const flat = flattenConversationTree(metas)
    expect(flat.map((n) => n.meta.id)).toEqual(['r2', 'r1', 'c2', 'c1', 'orphan'])
    expect(flat.map((n) => n.depth)).toEqual([0, 0, 1, 1, 0])
  })

  it('nests multi-level branches', () => {
    const metas = [
      meta('root'),
      meta('child', { parentId: 'root', createdAt: 1 }),
      meta('grand', { parentId: 'child', createdAt: 2 }),
    ]
    const flat = flattenConversationTree(metas)
    expect(flat.map((n) => n.meta.id)).toEqual(['root', 'child', 'grand'])
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2])
  })

  it('returns [] for an empty list', () => {
    expect(flattenConversationTree([])).toEqual([])
  })
})

describe('conversationDepth', () => {
  const meta = (
    id: string,
    parentId: string | null,
  ): ConversationMeta => ({
    id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    parentId,
    parentMessageCount: 0,
    messageCount: 0,
  })

  it('counts steps up to the root', () => {
    const metas = [
      meta('a', null),
      meta('b', 'a'),
      meta('c', 'b'),
    ]
    expect(conversationDepth(metas, 'a')).toBe(0)
    expect(conversationDepth(metas, 'b')).toBe(1)
    expect(conversationDepth(metas, 'c')).toBe(2)
  })

  it('is 0 for unknown ids and missing parents', () => {
    expect(conversationDepth([], 'x')).toBe(0)
    expect(conversationDepth([meta('x', 'missing')], 'x')).toBe(0)
  })

  it('terminates on a cycle', () => {
    const metas = [meta('a', 'b'), meta('b', 'a')]
    expect(conversationDepth(metas, 'a')).toBeLessThan(10)
  })
})

describe('agentId (多 Agent 体系)', () => {
  it('persists agentId through save → load and surfaces it on the index meta', async () => {
    const { app } = mkApp()
    await saveConversation(app, 'AI 助手', mkConv({ id: 'c1', agentId: '追问启发' }))
    const loaded = await loadConversation(app, 'AI 助手', 'c1')
    expect(loaded?.agentId).toBe('追问启发')
    const index = await loadIndex(app, 'AI 助手')
    expect(index.find((m) => m.id === 'c1')?.agentId).toBe('追问启发')
  })

  it('stays undefined for legacy conversations without the field', async () => {
    const { app } = mkApp()
    await saveConversation(app, undefined, mkConv({ id: 'legacy' }))
    const loaded = await loadConversation(app, undefined, 'legacy')
    expect(loaded?.agentId).toBeUndefined()
    const index = await loadIndex(app, undefined)
    expect(index.find((m) => m.id === 'legacy')?.agentId).toBeUndefined()
  })

  it('drops a non-string agentId from a corrupt file (tolerant load)', async () => {
    const path = `${conversationsFolder(undefined)}/bad.json`
    const conv = mkConv({ id: 'bad' })
    const { app } = mkApp({
      [path]: JSON.stringify({ ...conv, agentId: 42 }),
    })
    const loaded = await loadConversation(app, undefined, 'bad')
    expect(loaded).not.toBeNull()
    expect(loaded?.agentId).toBeUndefined()
  })
})

describe('hermesSessionId (任务四：Hermes 视图索引字段)', () => {
  it('persists through save → load and surfaces on the index meta', async () => {
    const { app } = mkApp()
    await saveConversation(
      app,
      undefined,
      mkConv({ id: 'c1', hermesSessionId: 'sess-abc123' }),
    )
    const loaded = await loadConversation(app, undefined, 'c1')
    expect(loaded?.hermesSessionId).toBe('sess-abc123')
    const index = await loadIndex(app, undefined)
    expect(index.find((m) => m.id === 'c1')?.hermesSessionId).toBe('sess-abc123')
  })

  it('stays undefined for non-hermes conversations', async () => {
    const { app } = mkApp()
    await saveConversation(app, undefined, mkConv({ id: 'plain' }))
    const index = await loadIndex(app, undefined)
    expect(index.find((m) => m.id === 'plain')?.hermesSessionId).toBeUndefined()
  })

  it('self-heals into old indexes via rebuildIndex (zero migration)', async () => {
    // Simulate a pre-field install: conversation file already carries the
    // binding, but the index was written before the field existed (stale).
    const { app } = mkApp({
      'AI 助手/conversations/h1.json': JSON.stringify(
        mkConv({ id: 'h1', hermesSessionId: 'sess-old' }),
      ),
      'AI 助手/conversations/index.json': JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'h1',
            title: '对话',
            createdAt: 100,
            updatedAt: 100,
            parentId: null,
            parentMessageCount: 0,
            messageCount: 2,
          },
        ],
      }),
    })
    // Corrupt-free but field-less index is "healthy" per loadIndex — the
    // rebuild path is what materializes the field; verify it directly.
    const rebuilt = await rebuildIndex(app, undefined)
    expect(rebuilt.find((m) => m.id === 'h1')?.hermesSessionId).toBe('sess-old')
  })

  it('drops a non-string hermesSessionId from a corrupt file (tolerant load)', async () => {
    const path = `${conversationsFolder(undefined)}/bad.json`
    const conv = mkConv({ id: 'bad' })
    const { app } = mkApp({
      [path]: JSON.stringify({ ...conv, hermesSessionId: 42 }),
    })
    const loaded = await loadConversation(app, undefined, 'bad')
    expect(loaded).not.toBeNull()
    expect(loaded?.hermesSessionId).toBeUndefined()
  })
})
