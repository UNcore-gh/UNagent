// Shared helpers for the note-management tools. Everything here stays within
// Obsidian's vault / metadataCache / fileManager APIs — mobile-safe, no fs,
// no child_process, no local database (three iron rules).

import { App, CachedMetadata, TFile, TFolder, normalizePath } from 'obsidian'

/**
 * Resolve a note reference to a TFile. Accepts a full path, a path without
 * extension, or a bare note name; falls back to wiki-link resolution and a
 * unique-basename match. Returns null when nothing (or multiple) match.
 */
export function resolveFile(app: App, ref: string): TFile | null {
  const target = ref.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim()
  if (!target) return null

  const tryPath = (p: string): TFile | null => {
    const file = app.vault.getAbstractFileByPath(normalizePath(p))
    return file instanceof TFile ? file : null
  }

  const direct = tryPath(target)
  if (direct) return direct
  if (!/\.[^/]+$/.test(target)) {
    const withExt = tryPath(`${target}.md`)
    if (withExt) return withExt
  }

  // Wiki-link style resolution (handles shortest-path settings).
  const linked = app.metadataCache.getFirstLinkpathDest?.(target, '')
  if (linked instanceof TFile) return linked

  // Unique basename match as a last resort.
  const basename = target.split('/').pop()?.toLowerCase()
  if (basename) {
    const matches = app.vault
      .getMarkdownFiles()
      .filter((f) => f.basename.toLowerCase() === basename)
    if (matches.length === 1) return matches[0]
  }

  return null
}

/** Create a folder (and any missing parents). No-op if it already exists. */
export async function ensureFolderExists(
  app: App,
  folderPath: string,
): Promise<void> {
  const normalized = normalizePath(folderPath)
  if (!normalized || normalized === '/') return
  const existing = app.vault.getAbstractFileByPath(normalized)
  if (existing) return
  const segments = normalized.split('/').filter(Boolean)
  let current = ''
  for (const seg of segments) {
    current = current ? `${current}/${seg}` : seg
    const node = app.vault.getAbstractFileByPath(current)
    if (!node) {
      await app.vault.createFolder(current)
    } else if (!(node instanceof TFolder)) {
      throw new Error(`路径已被文件占用：${current}`)
    }
  }
}

/** Parent folder path for a note path ('' for the vault root). */
export function parentFolderOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx === -1 ? '' : filePath.slice(0, idx)
}

/**
 * Write an undo snapshot back to its ORIGINAL path — EXACT path only.
 *
 * Never use resolveFile here: its wiki-link / unique-basename fallbacks
 * could point at an unrelated note that merely shares a name, and silently
 * overwriting it with an old snapshot is data corruption. Hit → overwrite;
 * miss → re-create at the path (ensuring the parent folder first — it may
 * have been removed along with the file). If the path is occupied by a
 * FOLDER, throw: the callers (UndoStack.undoLast / rollbackFrom) turn the
 * error into a 「撤销/回滚失败」 Notice instead of doing something wrong.
 * Shared by the tool-layer reverts (deleteNote.ts) and the persisted-store
 * hydration (main.ts rebuildUndoRevert) so both behave identically.
 */
export async function revertSnapshot(
  app: App,
  path: string,
  before: string,
): Promise<void> {
  const node = app.vault.getAbstractFileByPath(normalizePath(path))
  if (node instanceof TFile) {
    await app.vault.modify(node, before)
    return
  }
  if (node !== null) {
    throw new Error(`路径「${path}」已被文件夹占用，无法恢复文件`)
  }
  await ensureFolderExists(app, parentFolderOf(path))
  await app.vault.create(path, before)
}

/** A JSON-safe clone of a file's frontmatter (without the position field). */
export function getFrontmatterClone(
  app: App,
  file: TFile,
): Record<string, unknown> {
  const cache = app.metadataCache.getFileCache(file)
  const fm = cache?.frontmatter
  if (!fm) return {}
  const clone: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'position') continue
    clone[k] = v
  }
  return clone
}

/** All tags for a file: frontmatter tags + inline #tags, de-duplicated, no '#'. */
export function collectTags(cache: CachedMetadata | null): string[] {
  const out = new Set<string>()
  const normalize = (t: unknown) => {
    if (typeof t !== 'string') return
    out.add(t.replace(/^#/, '').trim())
  }
  const fmTags = cache?.frontmatter?.tags
  if (Array.isArray(fmTags)) fmTags.forEach(normalize)
  else if (typeof fmTags === 'string') {
    fmTags.split(',').forEach((s) => normalize(s.trim()))
  }
  for (const t of cache?.tags ?? []) normalize(t.tag)
  out.delete('')
  return Array.from(out)
}

/** Heading texts for a file (from cache, no file read). */
export function collectHeadings(cache: CachedMetadata | null): string[] {
  return (cache?.headings ?? []).map((h) => h.heading)
}

/**
 * Split raw markdown into its leading YAML frontmatter block and the body.
 * Returns frontmatter including its `---` fences (or '' if none) and the body.
 */
export function splitFrontmatter(content: string): {
  frontmatter: string
  body: string
} {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!match) return { frontmatter: '', body: content }
  return { frontmatter: match[0], body: content.slice(match[0].length) }
}

/**
 * Replace the body of the section under a heading of the given title.
 * The section spans until the next heading of level <= the target's level.
 * Returns null if the heading isn't found.
 */
export function replaceSection(
  body: string,
  sectionTitle: string,
  newContent: string,
): string | null {
  const lines = body.split('\n')
  const wanted = sectionTitle.trim().toLowerCase()

  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+(.*)$/)
    if (m && m[2].trim().toLowerCase() === wanted) {
      start = i
      level = m[1].length
      break
    }
  }
  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+/)
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }

  const heading = lines[start]
  const replacement = `${heading}\n${newContent.replace(/\n+$/, '')}\n`
  const before = lines.slice(0, start).join('\n')
  const after = lines.slice(end).join('\n')
  return [before, replacement, after].filter((s) => s.length > 0).join('\n')
}

/**
 * Find every occurrence of `needle` in `haystack`, returning start offsets.
 * Matches are NON-overlapping: after a hit, the search resumes at
 * `index + needle.length` (skipping the matched span). An empty needle
 * returns [] (infinite matches are meaningless).
 */
export function findOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + needle.length
  }
  return out
}

export type StrReplaceResult =
  | { next: string }
  | { error: 'not_found'; suggestion?: SimilarPassage }
  | {
      error: 'ambiguous'
      count: number
      candidates: Array<{ line: number; context: string }>
    }

/**
 * Replace a unique occurrence of `oldText` with `newText`. Requires exactly
 * one (non-overlapping) match; otherwise reports not_found or ambiguous with
 * up to 3 candidate locations (1-based line + ~40-char surrounding context,
 * newlines collapsed to spaces, overlong context truncated).
 * An empty `oldText` is treated as not_found: there is nothing to anchor a
 * replacement on, and reporting "not found" keeps the caller's error paths
 * simple (documented choice — callers also guard against empty input).
 *
 * On not_found the result additionally carries a fuzzy `suggestion` when one
 * is found (see findSimilarPassage): the most similar passage in the note,
 * verbatim, so the model can correct its old_text in ONE retry instead of
 * the old fail → re-read → retry loop that ate two rounds of the 8-round
 * tool budget.
 */
export function strReplace(
  content: string,
  oldText: string,
  newText: string,
): StrReplaceResult {
  if (!oldText) return { error: 'not_found' }
  const hits = findOccurrences(content, oldText)
  if (hits.length === 0) {
    const suggestion = findSimilarPassage(content, oldText) ?? undefined
    return suggestion ? { error: 'not_found', suggestion } : { error: 'not_found' }
  }
  if (hits.length > 1) {
    const candidates = hits.slice(0, 3).map((offset) => {
      const line = content.slice(0, offset).split('\n').length
      const raw = content.slice(Math.max(0, offset - 40), offset + oldText.length + 40)
      let context = raw.replace(/\s+/g, ' ').trim()
      if (context.length > 80) context = context.slice(0, 77) + '...'
      return { line, context }
    })
    return { error: 'ambiguous', count: hits.length, candidates }
  }
  const idx = hits[0]
  return { next: content.slice(0, idx) + newText + content.slice(idx + oldText.length) }
}

/* ── str_replace 模糊兜底 ─────────────────────────────────────────────
 * 精确匹配失败时，按行找出笔记里与 old_text 最相似的片段回报给模型。
 * 比较前做归一化（空白折叠 + 全角→半角标点 + 小写），所以最常见的两类
 * 失败——空白符差异、中英文标点差半个——会得到接近 1 的高分提示，模型
 * 直接照抄 suggestion.text 重试即可，省掉一次 read_note 往返。
 * 成本有界：锚定行全库线性扫一遍（O(总字符)）+ 仅对包含锚点的少数窗口
 * 对齐打分；超大内容/超长 old_text 直接放弃（这种失败重读也帮不了多少）。 */

/** Fuzzy comparison floor — below this the hint would be noise. */
const FUZZY_MIN_SIMILARITY = 0.5
/** The anchor line must land somewhere at least this plausible. */
const FUZZY_ANCHOR_MIN = 0.2
/** Guard rails: keep the failure path cheap on mobile. */
const FUZZY_MAX_CONTENT_LINES = 20000
const FUZZY_MAX_OLD_LINES = 200

/** Full-width → half-width punctuation map used by normalizeForComparison. */
const FUZZY_PUNCT: Record<string, string> = {
  '，': ',',
  '、': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
}

/**
 * Normalize text for fuzzy comparison only: full-width punctuation folded to
 * half-width, whitespace runs collapsed to one space, lowercased, trimmed.
 * Never used for the actual replacement — only for scoring candidates.
 */
export function normalizeForComparison(s: string): string {
  return s
    .replace(/[，、。！？；：（）【】“”‘’]/g, (m) => FUZZY_PUNCT[m] ?? m)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Character-bigram multiset (CJK-friendly; single chars kept as tokens). */
function charBigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  if (s.length === 1) {
    m.set(s, 1)
    return m
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** Dice coefficient over two bigram multisets (0..1). */
function diceCoefficient(a: Map<string, number>, b: Map<string, number>): number {
  let totalA = 0
  let totalB = 0
  a.forEach((c) => {
    totalA += c
  })
  b.forEach((c) => {
    totalB += c
  })
  if (totalA === 0 || totalB === 0) return 0
  const [small, large] = totalA <= totalB ? [a, b] : [b, a]
  let inter = 0
  small.forEach((count, g) => {
    const other = large.get(g)
    if (other) inter += Math.min(count, other)
  })
  return (2 * inter) / (totalA + totalB)
}

/** Drop leading/trailing blank lines. */
function trimBlankEdges(lines: string[]): string[] {
  let s = 0
  let e = lines.length - 1
  while (s <= e && !lines[s].trim()) s++
  while (e >= s && !lines[e].trim()) e--
  return lines.slice(s, e + 1)
}

export interface SimilarPassage {
  /** 1-based first line of the candidate passage. */
  startLine: number
  /** 1-based last line (inclusive). */
  endLine: number
  /** Dice similarity (0..1) computed on normalized text. */
  similarity: number
  /** The candidate passage VERBATIM from the content — copy-ready as a
   *  corrected old_text. */
  text: string
}

/**
 * Find the passage of `content` most similar to `oldText`, line-aligned.
 * Returns null when nothing clears FUZZY_MIN_SIMILARITY (or the inputs are
 * degenerate/over the guard rails). Strategy: pick the longest non-blank
 * line of oldText as an anchor, linearly scan content lines for its best
 * bigram match, then score only the window alignments that contain that
 * anchor line (bounded count = oldText's line count).
 *
 * Fast path: every line is normalized ONCE up front (normalize is the
 * costliest step of the naive version, which re-normalized per scan line
 * AND per window). Lines sharing no character with the anchor are skipped
 * entirely — their bigram intersection is empty, so their Dice is provably
 * 0, which can never beat the best-so-far. Skipping is lossless.
 */
export function findSimilarPassage(
  content: string,
  oldText: string,
): SimilarPassage | null {
  const oldLines = trimBlankEdges(oldText.split('\n'))
  const windowSize = oldLines.length
  if (windowSize === 0 || windowSize > FUZZY_MAX_OLD_LINES) return null
  const allLines = content.split('\n')
  if (allLines.length > FUZZY_MAX_CONTENT_LINES || allLines.length < windowSize) {
    return null
  }

  // Normalize once; all later stages reuse these cached forms.
  const normLines = allLines.map((l) => normalizeForComparison(l))
  const oldNorm = oldLines.map((l) => normalizeForComparison(l))

  // Anchor: the longest non-blank old line, judged on normalized form.
  let anchorIdx = 0
  for (let i = 1; i < oldNorm.length; i++) {
    if (oldNorm[i].length > oldNorm[anchorIdx].length) anchorIdx = i
  }
  const anchorNorm = oldNorm[anchorIdx]
  if (!anchorNorm) return null
  const anchorGrams = charBigrams(anchorNorm)
  if (anchorGrams.size === 0) return null

  // Character-set pre-filter: skip lines that share no char with the anchor
  // (empty bigram intersection → Dice exactly 0 → can never win).
  const anchorChars = new Set(anchorNorm)
  const sharesChar = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) if (anchorChars.has(s[i])) return true
    return false
  }

  let bestIdx = -1
  let bestAnchorScore = 0
  for (let i = 0; i < normLines.length; i++) {
    const norm = normLines[i]
    if (!norm || !sharesChar(norm)) continue
    const score = diceCoefficient(anchorGrams, charBigrams(norm))
    if (score > bestAnchorScore) {
      bestAnchorScore = score
      bestIdx = i
    }
  }
  if (bestIdx === -1 || bestAnchorScore < FUZZY_ANCHOR_MIN) return null

  // Score every window alignment that keeps the anchor line inside.
  // Pre-normalized lines joined with ' ' mirror normalize()'s whitespace
  // collapsing exactly (each norm line is already trimmed internally).
  const targetGrams = charBigrams(oldNorm.join(' '))
  const lo = Math.max(0, bestIdx - windowSize + 1)
  const hi = Math.min(bestIdx, allLines.length - windowSize)
  let bestStart = lo
  let bestSim = -1
  for (let start = lo; start <= hi; start++) {
    const windowNorm = normLines.slice(start, start + windowSize).join(' ')
    const sim = diceCoefficient(targetGrams, charBigrams(windowNorm))
    if (sim > bestSim) {
      bestSim = sim
      bestStart = start
    }
  }
  if (bestSim < FUZZY_MIN_SIMILARITY) return null

  // Report without blank edge lines; the text stays verbatim so the model
  // can paste it straight back as the corrected old_text.
  let s = bestStart
  let e = bestStart + windowSize - 1
  while (s < e && !allLines[s].trim()) s++
  while (e > s && !allLines[e].trim()) e--
  return {
    startLine: s + 1,
    endLine: e + 1,
    similarity: bestSim,
    text: allLines.slice(s, e + 1).join('\n'),
  }
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return [value]
  return []
}
