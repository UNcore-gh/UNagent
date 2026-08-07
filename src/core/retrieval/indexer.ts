// indexer — incremental vector-index maintenance + semantic search.
//
// 铁律2 修订版边界：本地只做「切块 + 点积」这类平凡 JS；embedding 计算
// 全部走远程 HTTP（embedClient）。触发链三条（main.ts 接线）：onload 延迟
// 后台增量、vault 事件 2s 防抖 markDirty、设置页手动 syncNow；工具调用前
// 若索引过期也会先 await 一次增量同步。

import type { App, CachedMetadata, TFile } from 'obsidian'
import { chunkNote, NoteChunk, ChunkSection } from './chunker'
import { EmbedConfig, embedBatch, EMBED_BATCH_SIZE } from './embedClient'
import { topK } from './cosine'
import { StoredChunk, VectorStore } from './vectorStore'
import { isExcludedPath } from '../../utils/exclusions'

/** Notes larger than this many chars are skipped (cost guard). */
export const MAX_INDEX_CHARS = 200_000

/** How many worst hits to pull before per-note dedup. */
const OVERFETCH = 2

export interface EmbedChannelConfig extends EmbedConfig {
  enabled: boolean
}

export interface IndexerConfig {
  app: App
  getEmbedConfig: () => EmbedChannelConfig
  getAiFolder: () => string
  getExcludedFolders: () => string[]
}

export interface SyncReport {
  added: number
  updated: number
  removed: number
  total: number
  /** False when the channel is off / unconfigured — nothing was synced. */
  synced: boolean
}

export interface SemanticHit {
  path: string
  heading: string | null
  score: number
  snippet: string
}

export class RetrievalIndexer {
  readonly store: VectorStore
  private syncing: Promise<SyncReport> | null = null
  private dirty = true

  constructor(private readonly cfg: IndexerConfig) {
    this.store = new VectorStore(cfg.app, cfg.getAiFolder)
  }

  markDirty(): void {
    this.dirty = true
  }

  /** True when the semantic channel is switched on AND has an API key. */
  channelReady(): boolean {
    const c = this.cfg.getEmbedConfig()
    return c.enabled && c.apiKey.trim() !== ''
  }

  status(): { count: number; updatedAt: number; model: string; dirty: boolean } {
    return {
      count: this.store.count,
      updatedAt: this.store.updatedAt,
      model: this.store.model,
      dirty: this.dirty,
    }
  }

  /**
   * Incremental sync: embed added/changed notes, drop deleted ones.
   * Single-flight — concurrent callers join the running sync. Silent no-op
   * (synced:false) when the channel is disabled or has no API key.
   */
  async syncNow(signal?: AbortSignal): Promise<SyncReport> {
    if (this.syncing) return this.syncing
    const run = this.doSync(signal).finally(() => {
      this.syncing = null
    })
    this.syncing = run
    return run
  }

  private async doSync(signal?: AbortSignal): Promise<SyncReport> {
    const embed = this.cfg.getEmbedConfig()
    const empty: SyncReport = { added: 0, updated: 0, removed: 0, total: this.store.count, synced: false }
    if (!embed.enabled || !embed.apiKey.trim()) return empty

    if (!this.store.loaded) await this.store.load()
    // Model switch ⇒ dimension space changed; rebuild from scratch.
    const priorChunks = this.store.model && this.store.model !== embed.model ? [] : this.store.chunks
    const priorRows = priorChunks.length === this.store.count ? this.store.matrixRows() : []

    // Group prior rows by path with their signature (joined chunk hashes).
    const priorByPath = new Map<string, { sig: string; rows: number[]; chunks: StoredChunk[] }>()
    for (let i = 0; i < priorChunks.length; i++) {
      const c = priorChunks[i]
      let entry = priorByPath.get(c.path)
      if (!entry) {
        entry = { sig: '', rows: [], chunks: [] }
        priorByPath.set(c.path, entry)
      }
      entry.rows.push(i)
      entry.chunks.push(c)
      entry.sig += (entry.sig ? ',' : '') + String(c.hash)
    }

    // Scan the vault for indexable notes.
    const aiFolder = this.cfg.getAiFolder()
    const excluded = this.cfg.getExcludedFolders()
    const fresh = new Map<string, NoteChunk[]>()
    for (const file of this.cfg.app.vault.getMarkdownFiles()) {
      if (aiFolder && (file.path === aiFolder || file.path.startsWith(aiFolder + '/'))) continue
      if (isExcludedPath(file.path, excluded)) continue
      const chunks = await this.chunkFile(file)
      if (chunks.length > 0) fresh.set(file.path, chunks)
    }

    // Diff: kept / to-embed / removed.
    const keptChunks: StoredChunk[] = []
    const keptVectors: Float32Array[] = []
    const toEmbed: NoteChunk[] = []
    let added = 0
    let updated = 0
    for (const [path, chunks] of fresh) {
      const sig = chunks.map((c) => c.hash).join(',')
      const prior = priorByPath.get(path)
      if (prior && prior.sig === sig && prior.rows.length === chunks.length) {
        for (const row of prior.rows) {
          keptChunks.push(priorChunks[row])
          keptVectors.push(priorRows[row])
        }
        continue
      }
      if (prior) updated += 1
      else added += 1
      toEmbed.push(...chunks)
    }
    const removed = [...priorByPath.keys()].filter((p) => !fresh.has(p)).length

    if (toEmbed.length === 0 && removed === 0 && this.store.loaded) {
      this.dirty = false
      return { added: 0, updated: 0, removed: 0, total: keptChunks.length, synced: true }
    }

    // Embed in batches, checking the abort signal between batches.
    const newVectors: Float32Array[] = []
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
      if (signal?.aborted) return { added, updated, removed, total: this.store.count, synced: false }
      const batch = toEmbed.slice(i, i + EMBED_BATCH_SIZE)
      const vectors = await embedBatch(
        embed,
        batch.map((c) => c.text),
      )
      newVectors.push(...vectors)
      // Yield so huge first-time builds never pin the main thread.
      if (i + EMBED_BATCH_SIZE < toEmbed.length) {
        await new Promise<void>((r) => setTimeout(r, 0))
      }
    }
    const dim = newVectors[0]?.length ?? this.store.dim
    if (newVectors.length > 0 && dim === 0) {
      throw new Error('Embedding 服务返回了空维度向量')
    }

    // Reassemble in scan order: kept rows first per path already placed,
    // then append embedded chunks grouped by path.
    const outChunks = [...keptChunks]
    const outVectors = [...keptVectors]
    let cursor = 0
    for (const [path, chunks] of fresh) {
      const sig = chunks.map((c) => c.hash).join(',')
      const prior = priorByPath.get(path)
      if (prior && prior.sig === sig && prior.rows.length === chunks.length) continue
      for (const chunk of chunks) {
        outChunks.push({ path, heading: chunk.heading, hash: chunk.hash })
        outVectors.push(newVectors[cursor++])
      }
    }

    await this.store.save(outChunks, outVectors, embed.model, dim)
    this.dirty = false
    return { added, updated, removed, total: outChunks.length, synced: true }
  }

  /** Chunk one vault file; oversized notes are skipped whole (cost guard). */
  private async chunkFile(file: TFile): Promise<NoteChunk[]> {
    try {
      const content = await this.cfg.app.vault.cachedRead(file)
      if (content.length > MAX_INDEX_CHARS) return []
      const cache: CachedMetadata | null = this.cfg.app.metadataCache.getFileCache(file)
      const sections: ChunkSection[] = (cache?.sections ?? []).map((s) => ({
        type: s.type,
        start: s.position.start.offset,
        end: s.position.end.offset,
      }))
      return chunkNote(file.path, content, sections)
    } catch {
      return []
    }
  }

  /**
   * Semantic search: sync if stale, embed the query (one API call), brute
   * top-k, then dedup per note keeping the best chunk. Caller verifies the
   * channel is enabled/configured first.
   */
  async search(query: string, limit: number, signal?: AbortSignal): Promise<SemanticHit[]> {
    if (this.dirty) await this.syncNow(signal)
    if (!this.store.loaded) await this.store.load()
    if (this.store.count === 0) return []

    const embed = this.cfg.getEmbedConfig()
    const [q] = await embedBatch(embed, [query])
    const hits = topK(q, this.store.matrixRows(), limit * OVERFETCH)

    const seen = new Set<string>()
    const out: SemanticHit[] = []
    const chunks = this.store.chunks
    for (const hit of hits) {
      const chunk = chunks[hit.index]
      if (!chunk || seen.has(chunk.path)) continue
      seen.add(chunk.path)
      out.push({
        path: chunk.path,
        heading: chunk.heading,
        score: Math.round(hit.score * 1000) / 1000,
        snippet: await sectionSnippet(this.cfg.app, chunk.path, chunk.heading),
      })
      if (out.length >= limit) break
    }
    return out
  }
}

/**
 * Extract a short snippet from the section under `heading` (or the note's
 * leading text when heading is null). Best-effort: unreadable notes give ''.
 */
export async function sectionSnippet(
  app: App,
  path: string,
  heading: string | null,
  max = 150,
): Promise<string> {
  const file = app.vault.getMarkdownFiles().find((f) => f.path === path)
  if (!file) return ''
  let content: string
  try {
    content = await app.vault.cachedRead(file)
  } catch {
    return ''
  }
  let body = content
  if (heading) {
    const marker = new RegExp(
      `^#{1,6}\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm',
    )
    const m = marker.exec(content)
    if (m) body = content.slice(m.index + m[0].length)
  }
  const text = body.trim().slice(0, max)
  if (!text) return ''
  return body.trim().length > max ? text + '…' : text
}

/* ── singleton access (tools are static objects; main.ts wires the instance) ── */

let instance: RetrievalIndexer | null = null

export function initRetrievalIndexer(cfg: IndexerConfig): RetrievalIndexer {
  instance = new RetrievalIndexer(cfg)
  return instance
}

export function getRetrievalIndexer(): RetrievalIndexer | null {
  return instance
}

/** Test helper — drop the singleton between suites. */
export function resetRetrievalIndexer(): void {
  instance = null
}
