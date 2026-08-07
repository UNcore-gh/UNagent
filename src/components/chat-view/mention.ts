// Pure logic behind the @-mention picker: trigger detection in the composer
// text, replacement on selection, and candidate building from the vault
// (notes / folders / tags — keyword + metadata only, per the no-RAG rule).
//
// The NUMBER of '@' characters selects the candidate type:
//   '@'    → note reference   (level 1)
//   '@@'   → folder reference (level 2)
//   '@@@'  → tag reference    (level 3, 4+ collapses to 3)
// Each level returns a single-kind ranked list (no mixing), so the picker
// header can say exactly what it's inserting.

import { App, TFile, TFolder } from 'obsidian'
import { collectTags } from '../../tools/util'
import {
  isAudioExt,
  isCanvasExt,
  isImageExt,
  isVideoExt,
  linkForPath,
} from '../../utils/attachments'
import { isExcludedPath } from '../../utils/exclusions'

export type MentionLevel = 1 | 2 | 3

/** An in-progress mention: run start, level, and the query after the run. */
export interface Mention {
  /** Index of the first '@' in the contiguous run. */
  at: number
  level: MentionLevel
  query: string
}

export type MentionKind = 'note' | 'folder' | 'tag' | 'file'

export interface MentionCandidate {
  kind: MentionKind
  id: string
  /** Display title (basename / folder name / #tag). */
  title: string
  /** Secondary line (path / usage count). */
  subtitle?: string
  /** Text that replaces '@query' in the composer. */
  insert: string
  /** Per-row icon override (used by the file attach picker). */
  icon?: string
}

/**
 * Detect the mention being typed at `caret`. A mention is the last run of
 * '@' with no newline between it and the caret (spaces allowed — note names
 * contain them, and the query doubles as keyword search). The run length
 * (capped at 3) picks the candidate kind.
 */
export function getActiveMention(value: string, caret: number): Mention | null {
  const before = value.slice(0, caret)
  const last = before.lastIndexOf('@')
  if (last === -1) return null
  const query = before.slice(last + 1)
  if (/[\r\n]/.test(query)) return null
  if (query.length > 60) return null
  // Walk left over the contiguous '@' run.
  let at = last
  while (at > 0 && before[at - 1] === '@') at--
  const runLen = last - at + 1
  const level = (runLen >= 3 ? 3 : runLen) as MentionLevel
  return { at, level, query }
}

/** Replace '@query' with the chosen reference; returns new text + caret. */
export function insertMention(
  value: string,
  at: number,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const after = value.slice(caret)
  // Add a separating space unless one already follows the caret.
  const needsSpace = !/^\s/.test(after)
  const text = value.slice(0, at) + insert + (needsSpace ? ' ' : '') + after
  return { text, caret: at + insert.length + (needsSpace ? 1 : 0) }
}

/** Max rows per level's result list (the pinned active note is separate). */
const TOTAL_CAP = 24

/** Rank tiers for one candidate kind: exact > prefix > contains > path. */
interface RankSpec {
  exact: number
  prefix: number
  contains: number
  /** Substring hit on the secondary (path) text; omit = no path tier. */
  path?: number
}

/** Rank tiers per candidate kind (module-level to avoid per-call alloc). */
const NOTE_SPEC: RankSpec = { exact: 100, prefix: 80, contains: 60, path: 30 }
const FOLDER_SPEC: RankSpec = { exact: 90, prefix: 70, contains: 50, path: 40 }
const TAG_SPEC: RankSpec = { exact: 85, prefix: 65, contains: 45 }

/** Score a candidate with tiered substring matching; -1 = no hit at all. */
function rankScore(
  q: string,
  primary: string,
  spec: RankSpec,
  secondary?: string,
): number {
  const t = primary.toLowerCase()
  if (t === q) return spec.exact
  if (t.startsWith(q)) return spec.prefix
  if (t.includes(q)) return spec.contains
  if (
    spec.path !== undefined &&
    secondary !== undefined &&
    secondary.toLowerCase().includes(q)
  ) {
    return spec.path
  }
  return -1
}

// metadataCache.getTags exists at runtime but is missing from some d.ts builds.
interface MetadataCacheWithTags {
  getTags(): Record<string, number>
}

/**
 * Build the picker contents for a level + query:
 *   active  — the current note, pinned (level 1 only; null otherwise)
 *   results — a single-kind ranked list for that level
 * Empty queries fall back to recent notes (1), folders by name (2), or
 * popular tags (3). Files/folders under `exclusions` are filtered out of
 * every level; tag counts are recomputed over included files only when
 * exclusions are active.
 */
export function buildCandidates(
  app: App,
  query: string,
  level: MentionLevel,
  exclusions: string[] = [],
): { active: MentionCandidate | null; results: MentionCandidate[] } {
  const q = query.trim().toLowerCase()

  if (level === 1)
    return { active: activeNote(app, exclusions), results: noteResults(app, q, exclusions) }
  if (level === 2) return { active: null, results: folderResults(app, q, exclusions) }
  return { active: null, results: tagResults(app, q, exclusions) }
}

function activeNote(app: App, exclusions: string[]): MentionCandidate | null {
  const active = app.workspace.getActiveFile()
  if (!(active instanceof TFile) || active.extension !== 'md') return null
  if (isExcludedPath(active.path, exclusions)) return null
  return noteCandidate(active, basenameCounts(app))
}

function basenameCounts(app: App): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of app.vault.getMarkdownFiles()) {
    counts.set(f.basename, (counts.get(f.basename) ?? 0) + 1)
  }
  return counts
}

function noteCandidate(
  f: TFile,
  baseCount: Map<string, number>,
): MentionCandidate {
  const unique = (baseCount.get(f.basename) ?? 0) <= 1
  const insert = unique
    ? `[[${f.basename}]]`
    : `[[${f.path.replace(/\.md$/, '')}|${f.basename}]]`
  const parent = f.parent && f.parent.path !== '/' ? f.parent.path : ''
  return {
    kind: 'note',
    id: `note:${f.path}`,
    title: f.basename,
    subtitle: parent || f.path,
    insert,
  }
}

function noteResults(app: App, q: string, exclusions: string[]): MentionCandidate[] {
  const active = app.workspace.getActiveFile()
  const baseCount = basenameCounts(app)
  const scored = app.vault
    .getMarkdownFiles()
    .filter((f) => f !== active && !isExcludedPath(f.path, exclusions))
    .map((f) => ({
      candidate: noteCandidate(f, baseCount),
      s: q ? rankScore(q, f.basename, NOTE_SPEC, f.path) : 1,
      aux: f.stat.mtime,
    }))
    .filter((x) => x.s >= 0)
  return scored
    .sort((a, b) => b.s - a.s || b.aux - a.aux || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, TOTAL_CAP)
    .map((x) => x.candidate)
}

function folderResults(app: App, q: string, exclusions: string[]): MentionCandidate[] {
  const scored = app.vault
    .getAllLoadedFiles()
    .filter(
      (a): a is TFolder =>
        a instanceof TFolder &&
        a.path !== '/' &&
        !isExcludedPath(a.path, exclusions),
    )
    .map((f) => ({
      candidate: {
        kind: 'folder' as const,
        id: `folder:${f.path}`,
        title: f.name,
        subtitle: f.path,
        insert: `[[${f.path}/]]`,
      },
      s: q ? rankScore(q, f.name, FOLDER_SPEC, f.path) : 1,
    }))
    .filter((x) => x.s >= 0)
  return scored
    .sort((a, b) => b.s - a.s || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, TOTAL_CAP)
    .map((x) => x.candidate)
}

function tagCounts(app: App, exclusions: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (exclusions.length === 0) {
    // Fast path: Obsidian's vault-wide aggregate (kept by Obsidian itself).
    const src: Record<string, number> =
      (app.metadataCache as unknown as MetadataCacheWithTags).getTags?.() ?? {}
    for (const [raw, count] of Object.entries(src)) {
      counts.set(raw.replace(/^#/, ''), count)
    }
    return counts
  }
  // Exclusions active: recompute over included files only (still metadata-
  // only via the cache — no file reads, per the no-RAG rule).
  for (const f of app.vault.getMarkdownFiles()) {
    if (isExcludedPath(f.path, exclusions)) continue
    for (const t of collectTags(app.metadataCache.getFileCache(f))) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return counts
}

function tagResults(app: App, q: string, exclusions: string[]): MentionCandidate[] {
  // '#' prefix on the query is ignored.
  const tagQuery = q.replace(/^#/, '')
  const scored = Array.from(tagCounts(app, exclusions).entries())
    .map(([raw, count]) => ({
      candidate: {
        kind: 'tag' as const,
        id: `tag:${raw}`,
        title: `#${raw}`,
        subtitle: `${count} 篇笔记`,
        insert: `#${raw}`,
      },
      s: q ? rankScore(tagQuery, raw, TAG_SPEC) : 1,
      aux: count,
    }))
    .filter((x) => x.s >= 0)
  return scored
    .sort((a, b) => b.s - a.s || b.aux - a.aux || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, TOTAL_CAP)
    .map((x) => x.candidate)
}

/**
 * Build candidates for the paperclip "attach vault file" picker: EVERY file
 * type in the vault (minus exclusions). Markdown files become note-style
 * `[[…]]` references (unique-basename aware); images / pdf embed as
 * `![[path]]`; anything else links as `[[path]]`. Empty query falls back to
 * the most recently modified files — what an attach dialog usually wants.
 */
export function buildFileCandidates(
  app: App,
  query: string,
  exclusions: string[] = [],
): MentionCandidate[] {
  const q = query.trim().toLowerCase()
  const baseCount = basenameCounts(app)
  const scored = app.vault
    .getFiles()
    .filter((f) => !isExcludedPath(f.path, exclusions))
    .map((f) => ({
      candidate:
        f.extension === 'md' ? noteCandidate(f, baseCount) : fileCandidate(f),
      s: q ? rankScore(q, f.name, NOTE_SPEC, f.path) : 1,
      aux: f.stat.mtime,
    }))
    .filter((x) => x.s >= 0)
  return scored
    .sort((a, b) => b.s - a.s || b.aux - a.aux || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, TOTAL_CAP)
    .map((x) => x.candidate)
}

function fileCandidate(f: TFile): MentionCandidate {
  const parent = f.parent && f.parent.path !== '/' ? f.parent.path : ''
  return {
    kind: 'file',
    id: `file:${f.path}`,
    title: f.name,
    subtitle: parent || f.path,
    insert: linkForPath(f.path),
    icon: isImageExt(f.extension)
      ? 'image'
      : isCanvasExt(f.extension)
        ? 'paintbrush'
        : isVideoExt(f.extension)
          ? 'video'
          : isAudioExt(f.extension)
            ? 'audio-lines'
            : 'file',
  }
}

/* ── in-input value tokenizing (for the composer's live highlight) ────── */

/** A reference kind for the light-blue in-input highlight. */
export type MentionTokenKind = 'file' | 'folder' | 'tag' | 'ref'

export interface MentionSegment {
  type: 'mention'
  kind: MentionTokenKind
  text: string
}
export interface TextSegment {
  type: 'text'
  text: string
}
export type ValueSegment = MentionSegment | TextSegment

const MENTION_TOKEN =
  /\[\[[^\]]+\]\]「[^\n」]*」|!?\[\[[^\]]+\]\]|#[\w一-鿿-]+/g

/**
 * Split a composer value into plain text and mention tokens — wiki links
 * (notes / files / folder refs `[[…/]]`) and #tags — so the overlay can
 * highlight the references. Pure color change (no width change), so the
 * rendered text stays pixel-aligned with the textarea.
 */
export function segmentValue(value: string): ValueSegment[] {
  const out: ValueSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  MENTION_TOKEN.lastIndex = 0
  while ((m = MENTION_TOKEN.exec(value))) {
    if (m.index > last) out.push({ type: 'text', text: value.slice(last, m.index) })
    const token = m[0]
    const kind: MentionTokenKind = token.startsWith('#')
      ? 'tag'
      : /\[\[[^\]]+\]\]「/.test(token)
        ? 'ref'
        : token.endsWith('/]]')
          ? 'folder'
          : 'file'
    out.push({ type: 'mention', kind, text: token })
    last = m.index + token.length
  }
  if (last < value.length) out.push({ type: 'text', text: value.slice(last) })
  return out
}

/** A run of consecutive same-kind mentions (whitespace-only gaps collapse). */
export interface MentionRun {
  type: 'mention'
  kind: MentionTokenKind
  /** The mention tokens in the run. */
  texts: string[]
  /** Raw span covered by the run (tokens + separating spaces) — its width
   *  must match the textarea layout, so a count chip can size to it. */
  raw: string
}
export type RenderRun = TextSegment | MentionRun

/**
 * Collapse consecutive same-kind mention segments (joined by whitespace-only
 * text) into one MentionRun. A run of one renders as the token itself (light
 * blue); a run of several renders as a "文件夹×4"-style count chip.
 */
export function groupMentions(segments: ValueSegment[]): RenderRun[] {
  const out: RenderRun[] = []
  let i = 0
  while (i < segments.length) {
    const seg = segments[i]
    if (seg.type !== 'mention') {
      out.push({ type: 'text', text: seg.text })
      i++
      continue
    }
    const kind = seg.kind
    const parts: ValueSegment[] = [seg]
    let j = i + 1
    while (j < segments.length) {
      const s = segments[j]
      if (s.type === 'mention' && s.kind === kind) {
        parts.push(s)
        j++
        continue
      }
      // Whitespace only counts as part of the run when it sits BETWEEN two
      // same-kind mentions (otherwise it stays ordinary text).
      const next = segments[j + 1]
      if (
        s.type === 'text' &&
        /^\s*$/.test(s.text) &&
        next?.type === 'mention' &&
        next.kind === kind
      ) {
        parts.push(s)
        j++
        continue
      }
      break
    }
    out.push({
      type: 'mention',
      kind,
      texts: parts.filter((s): s is MentionSegment => s.type === 'mention').map((s) => s.text),
      raw: parts.map((s) => s.text).join(''),
    })
    i = j
  }
  return out
}

/* ── display-value mapping (the input shows compact chips, the raw refs are
     expanded back on send) ────────────────────────────────────────────── */

/** Kind-specific chip labels (用户指示): @ 笔记/文件夹/标签各用专属字；「引用」
 *  只用于对文件内选中文字的引用（＋按钮）。 */
export const MENTION_KIND_LABEL: Record<MentionTokenKind, string> = {
  file: '文件',
  folder: '文件夹',
  tag: '标签',
  ref: '引用',
}

/** Invisible 1em pad prepended to every chip marker (mentions AND commands,
 *  追加㊱) so the textarea lays out the SAME width as the visible chip
 *  (icon 1em + label). Without it the caret would sit one char short of the
 *  chip's end (用户报). 　 is the ideographic space — exactly one CJK em,
 *  matching the icon's width. */
export const MENTION_MARKER_PAD = '\u3000'

/** One replaced span: value [vs,ve) ↔ display marker [ds,de). */
export interface DisplaySpan {
  vs: number
  ve: number
  ds: number
  de: number
  /** The text the textarea actually lays out. INCLUDES the MENTION_MARKER_PAD
   *  (so layout width == chip width: pad 1em ≈ the chip's leading icon). */
  marker: string
  /** The visible chip text (without the pad). */
  label?: string
  /** 'command' renders as the amber/green pill; 'mention' as a light-blue chip. */
  kind: 'command' | 'mention'
  /** Command pill flavor: 1 = '/cmd', 2 = '//skill-name' (icon differs). */
  level?: 1 | 2
  /** The mention kind (file/folder/tag/ref) — for the chip's icon. */
  mkind?: MentionTokenKind
  /** ref 引用的选中原文（追加73）——chip 外观保持简洁，原文只进悬停 tooltip。 */
  snippet?: string
}

/** The compact chip text a mention run renders as ("笔记" / "笔记×3"). */
export function runMarkerText(kind: MentionTokenKind, count: number): string {
  const label = MENTION_KIND_LABEL[kind] ?? kind
  return count > 1 ? `${label}×${count}` : label
}

/** The quoted text carried by a ref token `[[…]]「…」` ('' when absent).
 *  追加72/73: chip 外观保持简洁的「引用」，选中原文收进悬停 tooltip（内部
 *  可见、外部干净）——消息 chip 走 title，输入框 chip 走 span.snippet。 */
export function refTokenSnippet(token: string): string {
  const m = token.match(/\]\]「([^\n」]*)」/)
  return m ? m[1].trim() : ''
}

/**
 * The DISPLAY text the textarea actually shows: the leading command (if a
 * known "/cmd " invocation) and every mention run are replaced by their
 * compact chip markers ("顺便一问" / "笔记" / "笔记×3"), so the textarea's
 * layout matches the visible chips — the caret stays aligned. `spans` maps
 * between value positions and display positions.
 */
export function buildDisplay(
  value: string,
  cmd: { end: number; label: string; level?: 1 | 2 } | null,
): { display: string; spans: DisplaySpan[] } {
  const spans: DisplaySpan[] = []
  let out = ''
  let vpos = 0
  if (cmd) {
    const ve = cmd.end + 1 // the "/cmd " run incl. the separator space
    // Same pad+label shape as mention chips (追加㊱): the chip shows a leading
    // icon, the textarea's invisible pad carries its width.
    const marker = MENTION_MARKER_PAD + cmd.label
    spans.push({
      vs: 0,
      ve,
      ds: 0,
      de: marker.length,
      marker,
      label: cmd.label,
      kind: 'command',
      level: cmd.level,
    })
    out += marker
    vpos = ve
  }
  for (const run of groupMentions(segmentValue(value.slice(vpos)))) {
    if (run.type === 'text') {
      out += run.text
      vpos += run.text.length
      continue
    }
    // 追加73: chip 外观维持简洁的 kind 标签；引用的选中原文收进 span.snippet，
    // 由覆盖层放进悬停 tooltip（内部可见、外部干净）。
    const label = runMarkerText(run.kind, run.texts.length)
    const snippet =
      run.kind === 'ref' && run.texts.length === 1
        ? refTokenSnippet(run.texts[0])
        : ''
    const marker = MENTION_MARKER_PAD + label
    const vs = vpos
    const ve = vpos + run.raw.length
    spans.push({
      vs,
      ve,
      ds: out.length,
      de: out.length + marker.length,
      marker,
      label,
      kind: 'mention',
      mkind: run.kind,
      ...(snippet ? { snippet } : {}),
    })
    out += marker
    vpos = ve
  }
  return { display: out, spans }
}

/** Map a display position to the value position. Marker ends land on the run's
 *  value end (Backspace right after a chip deletes the whole run); positions
 *  strictly inside a marker clamp to its start (chips are atomic). */
export function mapDisplayToValue(spans: DisplaySpan[], dp: number): number {
  let vpos = 0
  let dpos = 0
  for (const s of spans) {
    const textLen = s.vs - vpos
    if (dp <= dpos + textLen) return vpos + (dp - dpos)
    dpos += textLen
    vpos += textLen
    const markerLen = s.de - s.ds
    if (dp < dpos + markerLen) return s.vs
    if (dp === dpos + markerLen) return s.ve
    dpos += markerLen
    vpos = s.ve
  }
  return vpos + (dp - dpos)
}

/** Map a value position to the display position (for placing the caret).
 *  Positions inside/at a run land on the marker's end (the chip is short). */
export function mapValueToDisplay(spans: DisplaySpan[], vp: number): number {
  let vpos = 0
  let dpos = 0
  for (const s of spans) {
    const textLen = s.vs - vpos
    if (vp <= vpos + textLen) return dpos + (vp - vpos)
    dpos += textLen
    vpos += textLen
    if (vp <= s.ve) return Math.min(dpos + (vp - s.vs), s.de)
    dpos += s.de - s.ds
    vpos = s.ve
  }
  return dpos + (vp - vpos)
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  return i
}
function commonSuffixLen(a: string, b: string): number {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/**
 * Reconstruct the raw VALUE from an edited display. The user's edits (typed
 * text / deletions / a whole chip backspace) happen between the compact
 * markers; diffing the old display against the new one and mapping the edited
 * range back through the spans recovers the raw refs.
 */
export function valueFromDisplay(
  oldValue: string,
  newDisplay: string,
  cmd: { end: number; label: string } | null,
): string {
  const { display: oldDisplay, spans } = buildDisplay(oldValue, cmd)
  const p = commonPrefixLen(oldDisplay, newDisplay)
  // Clamp the suffix so it never overlaps the prefix — overlapping ranges make
  // a deletion ambiguous (repeated text). Prefix wins; the suffix covers the
  // rest.
  const s = Math.min(
    commonSuffixLen(oldDisplay, newDisplay),
    Math.max(0, Math.min(oldDisplay.length, newDisplay.length) - p),
  )
  const newEdited = newDisplay.slice(p, newDisplay.length - s)
  const vpStart = mapDisplayToValue(spans, p)
  const vpEnd = mapDisplayToValue(spans, oldDisplay.length - s)
  return oldValue.slice(0, vpStart) + newEdited + oldValue.slice(vpEnd)
}
