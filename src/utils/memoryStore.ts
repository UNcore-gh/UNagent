// Persistent AI "brain files" — plain vault notes under the AI data folder
// (default `AI 助手/`, visible in Obsidian so the user can read and edit them
// at any time). Two entry-based targets live here:
//   memory.md — long-term memory: durable facts, lessons, conventions
//   user.md   — user profile: who the user is, identity, preferences, habits
// (The third evolution file, agent.md — persona & rules — is a free-form
// document managed by the user / edit_note, see utils/evolutionSetup.ts.)
//
// Follows the "frozen snapshot" pattern (borrowed from hermes-agent's memory
// tool): a snapshot of each file is injected into the system prompt at the
// start of a conversation; writes made mid-session update the file
// immediately but do NOT alter the live system prompt — they take effect
// next conversation. Both files are ordinary notes the user can open, edit,
// or delete at any time.
//
// Entry format: one bullet line ("- …") per entry. Non-bullet lines (like
// the explanatory prose in the seeded templates) are ignored for injection
// and — as a preserved "preamble" — survive rewrites, so hand-written
// explanations are not destroyed when the AI appends an entry.
//
// I/O goes through the raw adapter (utils/vaultIO): the data folder may be
// dot-prefixed (user-customized), invisible to Obsidian's indexed vault
// APIs — adapter paths work everywhere. Mobile-safe (no fs, no local
// database).

import { App } from 'obsidian'
import { readText, writeText } from './vaultIO'

/** Fallback AI data folder when settings leave it blank. VISIBLE by default
 *  (no dot prefix) so the evolution files are browsable in the file list. */
export const DEFAULT_AI_FOLDER = 'AI 助手'

/** Which brain file an entry belongs to. */
export type MemoryTarget = 'memory' | 'user'

interface TargetConfig {
  /** File name inside the AI data folder. */
  file: string
  /** Heading used when the file is created from scratch. */
  heading: string
  maxEntryChars: number
  maxTotalChars: number
  maxEntries: number
}

const TARGETS: Record<MemoryTarget, TargetConfig> = {
  memory: {
    file: 'memory.md',
    heading: '# AI 记忆',
    maxEntryChars: 500,
    maxTotalChars: 4000,
    maxEntries: 60,
  },
  user: {
    file: 'user.md',
    heading: '# 用户画像',
    maxEntryChars: 500,
    maxTotalChars: 2000,
    maxEntries: 40,
  },
}

/** Coerce a raw target argument (tool input) — anything but 'user' is
 *  treated as the default 'memory'. */
export function normalizeTarget(raw: unknown): MemoryTarget {
  return raw === 'user' ? 'user' : 'memory'
}

/** Brain-file path derived from the AI data folder (settings-configurable). */
export function memoryPath(
  aiFolder?: string,
  target: MemoryTarget = 'memory',
): string {
  const base =
    (aiFolder ?? '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_AI_FOLDER
  return `${base}/${TARGETS[target].file}`
}

/** Default memory-note location, relative to the vault root (kept for
 *  callers/tests). */
export const MEMORY_PATH = memoryPath()

// Bounds keep the injected prompt block small and predictable (per-target
// values live in TARGETS; these mirror the memory target for legacy callers).
export const MAX_ENTRIES = TARGETS.memory.maxEntries

// Brain entries enter the system prompt, so they are a persistent
// prompt-injection surface (hermes-agent scans memory content for the same
// reason). Entries that look like attempts to override instructions are
// rejected; the user can always hand-edit the note if they genuinely want
// such content.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /忽略(?:之前|以上|先前|所有|一切)[^\n。]{0,12}(?:指令|指示|提示|规则|设定)/,
  /<\s*\/?\s*system\s*>/i,
  /\byou\s+are\s+now\b/i,
  /(?:现在起|从现在起|即日起)[^\n。]{0,10}你是/,
]

export function looksLikeInjection(content: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(content))
}

const BULLET_RE = /^\s*[-*]\s+(.+)$/

/** Parse a brain note into entries. Tolerant of hand edits: only bullet
 *  lines count; headings and prose are ignored. */
export function parseMemoryEntries(text: string): string[] {
  const entries: string[] = []
  for (const raw of text.split('\n')) {
    const m = raw.match(BULLET_RE)
    if (!m) continue
    const entry = m[1].trim()
    if (entry) entries.push(entry)
  }
  return entries
}

/** The non-entry part of the file: everything BEFORE the first bullet line.
 *  Preserved across rewrites so user-written explanations survive. */
export function parsePreamble(text: string): string {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => BULLET_RE.test(l))
  return idx === -1 ? text : lines.slice(0, idx).join('\n')
}

/** Render a brain file: preserved preamble (or the target heading for a
 *  fresh file) followed by the bullet entries. */
export function renderBrainFile(
  target: MemoryTarget,
  preamble: string,
  entries: string[],
): string {
  const head =
    preamble.trim() !== ''
      ? preamble.replace(/\s+$/, '')
      : TARGETS[target].heading
  if (entries.length === 0) return `${head}\n`
  return `${head}\n\n${entries.map((e) => `- ${e}`).join('\n')}\n`
}

/** Legacy renderer — target heading + entries, no preamble. */
export function renderMemoryFile(entries: string[]): string {
  return renderBrainFile('memory', '', entries)
}

/** Collapse an entry to one line and strip bullet prefixes the model echoed. */
export function normalizeEntry(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^\s*[-*]\s+/, '').trim()
}

async function readBrain(
  app: App,
  aiFolder: string | undefined,
  target: MemoryTarget,
): Promise<{ preamble: string; entries: string[] }> {
  const text = await readText(app, memoryPath(aiFolder, target))
  if (text === null) return { preamble: '', entries: [] }
  return { preamble: parsePreamble(text), entries: parseMemoryEntries(text) }
}

export interface MemoryChange {
  ok: boolean
  /** Full entry list after the operation (live state for the LLM). */
  entries: string[]
  /** Machine-readable failure reason. */
  error?: string
  /** The entry that was added / already present / removed. */
  changed?: string
  /** True when add was a no-op because the entry already existed. */
  duplicate?: boolean
}

/** Frozen snapshot for the system prompt. null = nothing worth injecting. */
export async function loadMemorySnapshot(
  app: App,
  aiFolder?: string,
  target: MemoryTarget = 'memory',
): Promise<string[] | null> {
  const { entries } = await readBrain(app, aiFolder, target)
  return entries.length > 0 ? entries : null
}

export async function addMemoryEntry(
  app: App,
  raw: string,
  aiFolder?: string,
  target: MemoryTarget = 'memory',
): Promise<MemoryChange> {
  const cfg = TARGETS[target]
  const content = normalizeEntry(raw)
  if (!content) return { ok: false, entries: [], error: '内容为空' }
  if (content.length > cfg.maxEntryChars) {
    return {
      ok: false,
      entries: [],
      error: `单条记忆超过 ${cfg.maxEntryChars} 字符，请精简`,
    }
  }
  if (looksLikeInjection(content)) {
    return {
      ok: false,
      entries: [],
      error: '内容疑似提示注入（改写指令类话术），已拒绝；确需记录请用户手动编辑记忆笔记',
    }
  }
  const { preamble, entries } = await readBrain(app, aiFolder, target)
  if (entries.includes(content)) {
    return { ok: true, entries, changed: content, duplicate: true } // no rewrite
  }
  if (
    entries.length >= cfg.maxEntries ||
    entries.reduce((n, e) => n + e.length, 0) + content.length >
      cfg.maxTotalChars
  ) {
    return {
      ok: false,
      entries,
      error: `记忆已满（上限 ${cfg.maxEntries} 条 / ${cfg.maxTotalChars} 字符），请先 remove 旧条目`,
    }
  }
  const next = [...entries, content]
  await writeText(
    app,
    memoryPath(aiFolder, target),
    renderBrainFile(target, preamble, next),
  )
  return { ok: true, entries: next, changed: content }
}

export async function removeMemoryEntry(
  app: App,
  rawQuery: string,
  aiFolder?: string,
  target: MemoryTarget = 'memory',
): Promise<MemoryChange> {
  const query = normalizeEntry(rawQuery).toLowerCase()
  if (!query) return { ok: false, entries: [], error: '关键词为空' }
  const { preamble, entries } = await readBrain(app, aiFolder, target)
  const hits = entries.filter((e) => e.toLowerCase().includes(query))
  if (hits.length === 0) {
    return { ok: false, entries, error: '没有匹配的记忆条目' }
  }
  if (hits.length > 1) {
    return {
      ok: false,
      entries,
      error: `关键词匹配到 ${hits.length} 条，请用更长更唯一的关键词`,
    }
  }
  const changed = hits[0]
  const next = entries.filter((e) => e !== changed)
  await writeText(
    app,
    memoryPath(aiFolder, target),
    renderBrainFile(target, preamble, next),
  )
  return { ok: true, entries: next, changed }
}
