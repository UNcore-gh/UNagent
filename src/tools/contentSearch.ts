// contentSearch: keyword scan over note BODIES (still no vector index —
// three iron rules hold). Mobile-safe by construction: small batches with
// main-thread yields, hard caps on file count / file size / scanned chars,
// and AbortSignal checks before every file. Triggered by search_notes on
// explicit `content: true` OR automatically when the metadata pass recalls
// fewer than 3 hits (zero-hit fallback — recall over strict opt-in).

import type { App, TFile } from 'obsidian'

/** Files read per batch before yielding back to the main thread. */
const BATCH_SIZE = 16
/** Hard cap: never scan more than this many file bodies per search. */
const MAX_FILES_SCANNED = 300
/** Files larger than this (bytes/chars) are skipped outright. */
const MAX_FILE_SIZE = 512 * 1024
/** Only the leading N characters of each body are searched. */
const MAX_SCAN_CHARS = 50000

export interface ContentHit {
  path: string
  title: string
  snippet: string
}

/**
 * Extract a snippet around the first (case-insensitive) occurrence of
 * `query` in `content`: `radius` characters on each side, with a leading /
 * trailing '…' whenever the snippet is clipped at the content boundary.
 * The matched word itself is preserved verbatim (original casing).
 * Returns '' when there is no match (or on empty input).
 */
export function extractSnippet(
  content: string,
  query: string,
  radius = 60,
): string {
  if (!content || !query) return ''
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + query.length + radius)
  let snippet = content.slice(start, end)
  if (start > 0) snippet = '…' + snippet
  if (end < content.length) snippet += '…'
  return snippet
}

/**
 * Scan note bodies for ANY of `tokens` (already lowercased by the caller)
 * using vault.cachedRead (memory-cached, mobile-safe). Processes files in
 * batches of 16 with a `setTimeout(0)` yield between batches so the UI stays
 * alive.
 *
 * Guards: checks `signal.aborted` before each file (returns partial hits),
 * skips files > 512KB, only searches the first 50000 chars of each body,
 * and stops after scanning 300 files or collecting `limit` hits.
 * Individual read failures are silently skipped.
 */
export async function scanContent(
  app: App,
  files: TFile[],
  tokens: string[],
  opts: { limit: number; signal?: AbortSignal },
): Promise<ContentHit[]> {
  const hits: ContentHit[] = []
  const qs = tokens.map((t) => t.toLowerCase()).filter(Boolean)
  if (qs.length === 0) return hits

  let scanned = 0
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    // Yield between batches so long scans never block the main thread.
    if (i > 0) await new Promise<void>((r) => setTimeout(r, 0))

    const batch = files.slice(i, i + BATCH_SIZE)
    for (const file of batch) {
      if (opts.signal?.aborted) return hits
      if (hits.length >= opts.limit || scanned >= MAX_FILES_SCANNED) {
        return hits
      }

      // Size guard: cheap stat check before paying for a read.
      const size = file.stat?.size
      if (typeof size === 'number' && size > MAX_FILE_SIZE) continue

      scanned += 1
      try {
        const content = await app.vault.cachedRead(file)
        if (content.length > MAX_FILE_SIZE) continue
        const window = content.slice(0, MAX_SCAN_CHARS)
        const lowered = window.toLowerCase()
        const hit = qs.find((q) => lowered.includes(q))
        if (hit) {
          hits.push({
            path: file.path,
            title: file.basename,
            snippet: extractSnippet(window, hit),
          })
        }
      } catch {
        // Unreadable file: skip it, keep scanning the rest.
      }
    }
  }
  return hits
}
