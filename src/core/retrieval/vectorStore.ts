// vectorStore — persistence for the vector index under `{aiFolder}/.retrieval/`.
//
// 铁律2 修订版边界：向量只是「远程 embedding 的本地缓存」——存储合规
// （插件内部数据走 vaultIO adapter，同 conversations/ 纪律）；点文件夹
// Obsidian 不索引，用户文件列表永远看不到它。
//
// Layout:
//   meta.json   {version, model, dim, updatedAt, chunks:[{path, heading, hash}]}
//   vectors.bin Float32 rows concatenated, row i = chunks[i], dim*4 bytes each.
// Model change ⇒ whole index invalid (caller rebuilds). Corrupt/short binary
// ⇒ load() returns false and the store stays empty (caller rebuilds).

import type { App } from 'obsidian'
import { readBinary, readText, removePath, writeBinary, writeText } from '../../utils/vaultIO'

export interface StoredChunk {
  path: string
  heading: string | null
  hash: number
}

interface MetaFile {
  version: 1
  model: string
  dim: number
  updatedAt: number
  chunks: StoredChunk[]
}

export class VectorStore {
  private meta: MetaFile | null = null
  private matrix: Float32Array[] = []

  constructor(
    private readonly app: App,
    private readonly folder: () => string,
  ) {}

  private dir(): string {
    return `${this.folder()}/.retrieval`
  }

  get loaded(): boolean {
    return this.meta !== null
  }

  get chunks(): StoredChunk[] {
    return this.meta?.chunks ?? []
  }

  get model(): string {
    return this.meta?.model ?? ''
  }

  get dim(): number {
    return this.meta?.dim ?? 0
  }

  get updatedAt(): number {
    return this.meta?.updatedAt ?? 0
  }

  get count(): number {
    return this.matrix.length
  }

  /** Row vectors aligned with `chunks` (empty before a successful load). */
  matrixRows(): Float32Array[] {
    return this.matrix
  }

  /**
   * Load meta.json + vectors.bin. Returns true only when both are present,
   * consistent (byte length matches chunk count × dim) and parseable;
   * any corruption leaves the store empty so the caller does a full rebuild.
   */
  async load(): Promise<boolean> {
    const metaText = await readText(this.app, `${this.dir()}/meta.json`)
    if (!metaText) return false
    let meta: MetaFile
    try {
      meta = JSON.parse(metaText) as MetaFile
    } catch {
      return false
    }
    if (!meta || meta.version !== 1 || !Array.isArray(meta.chunks)) return false

    const bin = await readBinary(this.app, `${this.dir()}/vectors.bin`)
    const expected = meta.chunks.length * meta.dim * 4
    if (!bin || bin.byteLength !== expected) return false

    const rows: Float32Array[] = []
    const floats = new Float32Array(bin)
    for (let i = 0; i < meta.chunks.length; i++) {
      // slice() copies — the backing ArrayBuffer can be GC'd independently.
      rows.push(floats.slice(i * meta.dim, (i + 1) * meta.dim))
    }
    this.meta = meta
    this.matrix = rows
    return true
  }

  /** Persist a full replacement of the index (indexer builds the arrays). */
  async save(
    chunks: StoredChunk[],
    vectors: Float32Array[],
    model: string,
    dim: number,
  ): Promise<void> {
    const flat = new Float32Array(chunks.length * dim)
    for (let i = 0; i < vectors.length; i++) {
      flat.set(vectors[i], i * dim)
    }
    const meta: MetaFile = {
      version: 1,
      model,
      dim,
      updatedAt: Date.now(),
      chunks,
    }
    await writeText(this.app, `${this.dir()}/meta.json`, JSON.stringify(meta))
    await writeBinary(
      this.app,
      `${this.dir()}/vectors.bin`,
      flat.buffer.slice(0) as ArrayBuffer,
    )
    this.meta = meta
    this.matrix = vectors
  }

  /** Drop persisted files (e.g. model switch) — idempotent. */
  async clear(): Promise<void> {
    await removePath(this.app, `${this.dir()}/meta.json`)
    await removePath(this.app, `${this.dir()}/vectors.bin`)
    this.meta = null
    this.matrix = []
  }
}
