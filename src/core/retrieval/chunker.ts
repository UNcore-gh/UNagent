// chunker — split a note into embeddable chunks, anchored on headings.
//
// 铁律2 修订版边界：chunker 是纯函数（可测），只做文本切分；embedding
// 计算永远在远程（embedClient.ts），本地不跑任何模型。
//
// Contract: the caller passes metadataCache SECTIONS (offsets into the raw
// content) so this module stays obsidian-API-free and testable. Frontmatter
// never appears in `sections` (it lives in cache.frontmatter), so it is
// excluded from chunks for free.

/** Hard cap for one chunk BODY (context line excluded); longer
 *  heading-sections are hard-split. Lower = less embedding dilution for
 *  short phrases buried in long sections (cost: more chunks per note). */
export const MAX_CHUNK_CHARS = 400

/** Minimal section shape from metadataCache (offsets into the note body). */
export interface ChunkSection {
  type: string
  /** Character offset of the section start in the raw content. */
  start: number
  /** Character offset of the section end (exclusive) in the raw content. */
  end: number
}

export interface NoteChunk {
  path: string
  /** Heading text (without #) this chunk falls under; null = note preamble. */
  heading: string | null
  text: string
  /** djb2 hash of `text` — cheap content-change detection for the indexer. */
  hash: number
}

/** djb2 string hash (fast, non-cryptographic; plenty for change detection). */
export function djb2Hash(text: string): number {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return h | 0
}

/** One-line context header prepended to every chunk before embedding:
 *  path + heading give the vector discriminative signal for title-like
 *  queries (and keep hard-split slices anchored to their section). */
export function chunkContext(path: string, heading: string | null): string {
  return heading ? `${path} › ${heading}` : path
}

/** Split a long chunk body into MAX_CHUNK_CHARS slices (hard split). */
export function splitLong(text: string, max = MAX_CHUNK_CHARS): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += max) {
    const slice = text.slice(i, i + max)
    if (slice.trim()) out.push(slice)
  }
  return out
}

/**
 * Chunk one note: accumulate section text under the current heading; every
 * heading starts a fresh chunk. Long runs are hard-split so no chunk BODY
 * exceeds MAX_CHUNK_CHARS. Every chunk text carries a one-line context
 * header (path › heading) for embedding discriminability. Whitespace-only
 * chunks are dropped. The note's leading text (before any heading) gets
 * heading=null.
 */
export function chunkNote(
  path: string,
  content: string,
  sections: ChunkSection[],
): NoteChunk[] {
  const chunks: NoteChunk[] = []
  let heading: string | null = null
  let buffer = ''

  const flush = (): void => {
    const body = buffer.trim()
    buffer = ''
    if (!body) return
    const ctx = chunkContext(path, heading)
    for (const slice of splitLong(body)) {
      const text = `${ctx}\n${slice}`
      chunks.push({ path, heading, text, hash: djb2Hash(text) })
    }
  }

  for (const sec of sections) {
    const raw = content.slice(sec.start, sec.end)
    if (sec.type === 'heading') {
      flush()
      heading = raw.replace(/^#+\s*/, '').trim() || null
      continue
    }
    buffer += (buffer ? '\n' : '') + raw
  }
  flush()
  return chunks
}
