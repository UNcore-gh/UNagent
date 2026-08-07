// undoStore (Task #6): serialization round-trip, self-healing parse of bad
// JSON / malformed entries, persistence limits, and adapter-only I/O against
// an in-memory fake that exposes NOTHING but vault.adapter (dot-folder
// reality: indexed vault APIs are blind there).

import type { App } from 'obsidian'
import {
  MAX_SNAPSHOT_CHARS,
  MAX_UNDO_PERSISTED,
  applyLimits,
  genUndoId,
  loadUndoStore,
  parseEntries,
  saveUndoStore,
  serializeEntries,
  type UndoData,
} from '../undoStore'

function mkEntry(over: Partial<UndoData> = {}): UndoData {
  return {
    id: 'id1',
    label: '编辑 Note',
    at: 1700000000000,
    kind: 'modify',
    path: 'Notes/Note.md',
    before: 'hello',
    ...over,
  }
}

/** In-memory adapter fake — deliberately NO vault-level indexed APIs. */
function mkApp(initial: Record<string, string> = {}): {
  app: App
  store: Record<string, string>
} {
  const store: Record<string, string> = { ...initial }
  const app = {
    vault: {
      adapter: {
        exists: async (p: string) => p in store,
        read: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p]
        },
        write: async (p: string, data: string) => {
          store[p] = data
        },
        mkdir: async (_p: string) => undefined,
      },
    },
  } as unknown as App
  return { app, store }
}

describe('serializeEntries / parseEntries', () => {
  it('round-trips entries through JSON', () => {
    const entries = [
      mkEntry(),
      mkEntry({ id: 'id2', kind: 'delete', convId: 'c1', turnNo: 3, before: '' }),
    ]
    expect(parseEntries(serializeEntries(entries))).toEqual(entries)
  })

  it('self-heals to [] on null, empty, bad JSON or non-array payloads', () => {
    expect(parseEntries(null)).toEqual([])
    expect(parseEntries('')).toEqual([])
    expect(parseEntries('{not json')).toEqual([])
    expect(parseEntries('{"id":"x"}')).toEqual([])
    expect(parseEntries('"plain string"')).toEqual([])
  })

  it('filters out entries with missing or wrongly-typed fields', () => {
    const good = mkEntry()
    const raw = [
      good,
      { ...good, id: '' }, // empty id
      { ...good, before: 123 }, // wrong type
      { ...good, kind: 'explode' }, // unknown kind
      { ...good, at: 'yesterday' }, // wrong type
      { ...good, path: '' }, // empty path
      { ...good, turnNo: '2' }, // wrong type
      'garbage',
      null,
      42,
    ]
    expect(parseEntries(JSON.stringify(raw))).toEqual([good])
  })
})

describe('applyLimits', () => {
  it('drops the OLDEST entries when over the count limit', () => {
    const entries = Array.from({ length: MAX_UNDO_PERSISTED + 3 }, (_, i) =>
      mkEntry({ id: `e${i}`, before: `content-${i}` }),
    )
    const kept = applyLimits(entries)
    expect(kept).toHaveLength(MAX_UNDO_PERSISTED)
    expect(kept[0].id).toBe('e3') // e0..e2 (oldest) dropped
    expect(kept[kept.length - 1].id).toBe(`e${MAX_UNDO_PERSISTED + 2}`)
  })

  it('excludes entries whose before snapshot exceeds 100KB (never truncates)', () => {
    const big = mkEntry({ id: 'big', before: 'x'.repeat(MAX_SNAPSHOT_CHARS + 1) })
    const boundary = mkEntry({ id: 'edge', before: 'y'.repeat(MAX_SNAPSHOT_CHARS) })
    const small = mkEntry({ id: 'small', before: 'z' })
    const kept = applyLimits([big, boundary, small])
    expect(kept.map((e) => e.id)).toEqual(['edge', 'small'])
    // Nothing was truncated — survivors keep their full snapshot.
    expect(kept[0].before).toHaveLength(MAX_SNAPSHOT_CHARS)
  })

  it('respects a custom maxCount', () => {
    const entries = [mkEntry({ id: 'a' }), mkEntry({ id: 'b' }), mkEntry({ id: 'c' })]
    expect(applyLimits(entries, 2).map((e) => e.id)).toEqual(['b', 'c'])
  })
})

describe('loadUndoStore / saveUndoStore', () => {
  it('saves and loads via the adapter under aiFolder/undo.json', async () => {
    const { app, store } = mkApp()
    const entries = [mkEntry(), mkEntry({ id: 'id2', kind: 'delete' })]
    await saveUndoStore(app, '.obsidian-ai', entries)
    expect(Object.keys(store)).toEqual(['.obsidian-ai/undo.json'])
    await expect(loadUndoStore(app, '.obsidian-ai')).resolves.toEqual(entries)
  })

  it('loads [] when the store file is missing', async () => {
    const { app } = mkApp()
    await expect(loadUndoStore(app, 'AI 助手')).resolves.toEqual([])
  })

  it('loads [] when the store file is corrupt', async () => {
    const { app } = mkApp({ 'AI 助手/undo.json': '[[broken' })
    await expect(loadUndoStore(app, 'AI 助手')).resolves.toEqual([])
  })
})

describe('genUndoId', () => {
  it('produces non-empty, distinct ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => genUndoId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id.length).toBeGreaterThan(4)
  })
})
