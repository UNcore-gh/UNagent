// catalog — whole-vault directory index: one line per note (title + summary
// + tags) so the agent can grasp the library at a glance before searching.
//
// v1 摘要 = 启发式（首个正文句），零 API 成本、按需即时生成；「AI 精炼」
// 是设置页手动触发的增强（批量调当前激活模型），不做后台自动任务。
// 缓存 `{aiFolder}/.retrieval/catalog.json`，按 mtime 增量。

import type { App, CachedMetadata, TFile } from 'obsidian'
import { readText, writeText } from '../../utils/vaultIO'
import { isExcludedPath } from '../../utils/exclusions'
import type { LLMProvider } from '../llm/base'

export interface CatalogEntry {
  path: string
  title: string
  /** Heuristic summary — the display value unless aiSummary is present. */
  summary: string
  /** Optional LLM-refined one-liner (manual 「AI 精炼」 in settings). */
  aiSummary?: string
  tags: string[]
  mtime: number
}

interface CatalogFile {
  version: 1
  updatedAt: number
  entries: CatalogEntry[]
}

/** Notes per one LLM request during AI refinement. */
export const REFINE_BATCH_SIZE = 50

function catalogPath(aiFolder: string): string {
  return `${aiFolder}/.retrieval/catalog.json`
}

export async function loadCatalog(
  app: App,
  aiFolder: string,
): Promise<CatalogFile | null> {
  const text = await readText(app, catalogPath(aiFolder))
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as CatalogFile
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed
  } catch {
    // Corrupt cache — rebuild from scratch below.
  }
  return null
}

/** Tags from frontmatter `tags` plus inline #tags (metadataCache format). */
function entryTags(cache: CachedMetadata | null): string[] {
  const out: string[] = []
  const fm = cache?.frontmatter?.tags
  if (typeof fm === 'string') out.push(fm)
  else if (Array.isArray(fm)) {
    for (const t of fm) if (typeof t === 'string') out.push(t)
  }
  for (const t of cache?.tags ?? []) {
    out.push(t.tag.replace(/^#/, ''))
  }
  return [...new Set(out)]
}

/**
 * Heuristic one-liner: first meaningful body line (frontmatter, headings,
 * hr, embeds and code fences skipped; markdown markup stripped), ≤80 chars.
 * Pure — testable without obsidian.
 */
export function heuristicSummary(content: string): string {
  let body = content
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(end + 4)
  }
  let inFence = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^#{1,6}\s/.test(line)) continue
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    if (line.startsWith('![')) continue
    const clean = line
      .replace(/^([-*+]\s+|>\s+|\d+\.\s+)/, '')
      .replace(/!\[\[[^\]]*\]\]/g, '')
      .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .trim()
    if (!clean) continue
    return clean.length > 80 ? clean.slice(0, 80) + '…' : clean
  }
  return ''
}

async function entryFor(
  app: App,
  file: TFile,
  prev?: CatalogEntry,
): Promise<CatalogEntry> {
  const cache: CachedMetadata | null = app.metadataCache.getFileCache(file)
  const mtime = file.stat?.mtime ?? 0
  if (prev && prev.mtime === mtime) return prev
  let content = ''
  try {
    // cachedRead is memory-backed; safe to call for every note here.
    content = await app.vault.cachedRead(file)
  } catch {
    // Unreadable — summary stays ''.
  }
  return {
    path: file.path,
    title: file.basename,
    summary: heuristicSummary(content),
    ...(prev?.aiSummary ? { aiSummary: prev.aiSummary } : {}),
    tags: entryTags(cache),
    mtime,
  }
}

/**
 * Build/refresh the catalog (incremental by mtime). Returns entries sorted
 * by path. Persists the cache before returning.
 */
export async function ensureCatalog(
  app: App,
  aiFolder: string,
  excluded: string[],
): Promise<CatalogEntry[]> {
  const existing = await loadCatalog(app, aiFolder)
  const byPath = new Map((existing?.entries ?? []).map((e) => [e.path, e]))
  const out: CatalogEntry[] = []
  for (const file of app.vault.getMarkdownFiles()) {
    if (aiFolder && (file.path === aiFolder || file.path.startsWith(aiFolder + '/'))) continue
    if (isExcludedPath(file.path, excluded)) continue
    out.push(await entryFor(app, file, byPath.get(file.path)))
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  await writeText(
    app,
    catalogPath(aiFolder),
    JSON.stringify({ version: 1, updatedAt: Date.now(), entries: out }),
  )
  return out
}

/** Collect the full text of a streamChat run (text chunks only). */
async function collectText(
  provider: LLMProvider,
  system: string,
  user: string,
): Promise<string> {
  let text = ''
  for await (const chunk of provider.streamChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    undefined,
    { temperature: 0.3 },
  )) {
    if (chunk.type === 'text') text += chunk.text
  }
  return text
}

/** Strip markdown code fences and parse the JSON array payload. */
function parseRefinePayload(raw: string): Array<{ i: number; s: string }> | null {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1))
    if (!Array.isArray(arr)) return null
    return arr.filter(
      (x): x is { i: number; s: string } =>
        typeof x?.i === 'number' && typeof x?.s === 'string',
    )
  } catch {
    return null
  }
}

/**
 * AI-refine summaries for entries lacking aiSummary, in REFINE_BATCH_SIZE
 * batches through the given provider (the caller resolves the active model).
 * Persists after every successful batch. Returns how many entries got an
 * aiSummary this run.
 */
export async function refineCatalog(
  app: App,
  aiFolder: string,
  excluded: string[],
  provider: LLMProvider,
  onBatch?: (done: number, total: number) => void,
): Promise<number> {
  const entries = await ensureCatalog(app, aiFolder, excluded)
  const pending = entries.filter((e) => !e.aiSummary)
  let refined = 0

  for (let i = 0; i < pending.length; i += REFINE_BATCH_SIZE) {
    const batch = pending.slice(i, i + REFINE_BATCH_SIZE)
    const items = batch.map((e, idx) => ({ i: idx, t: e.title, p: e.summary }))
    const user =
      '以下是笔记列表（i 为序号，t 为标题，p 为正文开头摘录）：\n' +
      JSON.stringify(items)
    const raw = await collectText(
      provider,
      '为每篇笔记写一句话摘要（不超过 30 字，中文）。严格输出 JSON 数组，' +
        '元素与输入一一对应，形如 [{"i":0,"s":"..."}]。只输出 JSON，不要其他文字。',
      user,
    )
    const parsed = parseRefinePayload(raw)
    if (parsed) {
      for (const item of parsed) {
        const entry = batch[item.i]
        if (entry && item.s.trim()) {
          entry.aiSummary = item.s.trim()
          refined += 1
        }
      }
    }
    // Persist progress after each batch so a mid-run abort keeps its work.
    const all = await loadCatalog(app, aiFolder)
    if (all) {
      const byPath = new Map(all.entries.map((e) => [e.path, e]))
      for (const e of batch) {
        const target = byPath.get(e.path)
        if (target && e.aiSummary) target.aiSummary = e.aiSummary
      }
      await writeText(app, catalogPath(aiFolder), JSON.stringify(all))
    }
    onBatch?.(Math.min(i + REFINE_BATCH_SIZE, pending.length), pending.length)
  }
  return refined
}
