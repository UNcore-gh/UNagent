// vectorStore: meta.json + vectors.bin round-trip through a fake vault
// adapter (same adapter contract as vaultIO). Corruption must leave the
// store empty (caller does a full rebuild).

import type { App } from 'obsidian'
import { VectorStore, StoredChunk } from '../vectorStore'

function mkApp(): { app: App; files: Map<string, string | ArrayBuffer> } {
  const files = new Map<string, string | ArrayBuffer>()
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p) as string,
    write: async (p: string, data: string) => {
      files.set(p, data)
    },
    writeBinary: async (p: string, data: ArrayBuffer) => {
      files.set(p, data)
    },
    readBinary: async (p: string) => files.get(p) as ArrayBuffer,
    mkdir: async () => {},
    remove: async (p: string) => {
      files.delete(p)
    },
  }
  return { app: { vault: { adapter } } as unknown as App, files }
}

const chunks: StoredChunk[] = [
  { path: 'A.md', heading: null, hash: 1 },
  { path: 'B.md', heading: '章节', hash: 2 },
]
const vectors = [Float32Array.from([1, 0, 0]), Float32Array.from([0.5, 0.5, 0])]

describe('VectorStore', () => {
  it('round-trips save → load with aligned rows', async () => {
    const { app, files } = mkApp()
    const store = new VectorStore(app, () => 'AI 助手')
    await store.save(chunks, vectors, 'emb-1', 3)
    expect(files.has('AI 助手/.retrieval/meta.json')).toBe(true)
    expect(files.has('AI 助手/.retrieval/vectors.bin')).toBe(true)

    const fresh = new VectorStore(app, () => 'AI 助手')
    expect(fresh.loaded).toBe(false)
    expect(await fresh.load()).toBe(true)
    expect(fresh.model).toBe('emb-1')
    expect(fresh.dim).toBe(3)
    expect(fresh.count).toBe(2)
    expect(fresh.chunks).toEqual(chunks)
    expect(Array.from(fresh.matrixRows()[1])).toEqual([0.5, 0.5, 0])
    expect(fresh.updatedAt).toBeGreaterThan(0)
  })

  it('returns false (stays empty) when files are missing', async () => {
    const { app } = mkApp()
    const store = new VectorStore(app, () => 'AI 助手')
    expect(await store.load()).toBe(false)
    expect(store.count).toBe(0)
  })

  it('returns false when the binary byte count mismatches the meta', async () => {
    const { app, files } = mkApp()
    const store = new VectorStore(app, () => 'AI 助手')
    await store.save(chunks, vectors, 'emb-1', 3)
    // Truncate the binary: 2 chunks × dim 3 × 4 bytes = 24 → keep 16.
    const bin = files.get('AI 助手/.retrieval/vectors.bin') as ArrayBuffer
    files.set('AI 助手/.retrieval/vectors.bin', bin.slice(0, 16))

    const fresh = new VectorStore(app, () => 'AI 助手')
    expect(await fresh.load()).toBe(false)
    expect(fresh.count).toBe(0)
  })

  it('returns false on corrupt JSON meta', async () => {
    const { app, files } = mkApp()
    files.set('AI 助手/.retrieval/meta.json', '{oops')
    const store = new VectorStore(app, () => 'AI 助手')
    expect(await store.load()).toBe(false)
  })

  it('clear() removes both files and resets state', async () => {
    const { app, files } = mkApp()
    const store = new VectorStore(app, () => 'AI 助手')
    await store.save(chunks, vectors, 'emb-1', 3)
    await store.clear()
    expect(files.size).toBe(0)
    expect(store.loaded).toBe(false)
    expect(store.count).toBe(0)
    // Idempotent — clearing twice does not throw.
    await store.clear()
  })
})
