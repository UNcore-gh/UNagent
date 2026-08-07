// search_notes: v1 "retrieval" = keyword + metadata filters over the
// metadataCache. NO local model inference (mobile performance; 铁律2 修订版
// — semantic recall lives in semantic_search). Note bodies are scanned via
// contentSearch.ts on `content: true` OR automatically when the metadata
// pass finds nothing — still keyword-only, capped and batched for mobile.
//
// 检索增强（混合检索计划）：查询按标点/空格拆 token，任一命中即入候选；
// 字段加权打分 + 中文二元组兜底（keywordScore.ts），结果按分数降序——
// 根治旧版「整串子串匹配」导致的多词查询 0 命中与无排序问题。

import type { TFile } from 'obsidian'
import type { Tool, ToolRunResult } from '../core/agent/types'
import { isExcludedPath } from '../utils/exclusions'
import { scanContent } from './contentSearch'
import { scoreTokens, tokenize } from './keywordScore'
import { collectHeadings, collectTags } from './util'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30
/** Score of a body-only hit (正文权重, 见 keywordScore.FIELD_WEIGHTS). */
const CONTENT_SCORE = 0.5
/** Metadata recall below this count is considered weak → the body scan
 *  runs too (a stray bigram hit must not mask the real body-only match). */
const WEAK_METADATA_HITS = 3

interface SearchHit {
  path: string
  title: string
  tags: string[]
  folder: string
  /** Only present when the `content` param was used. */
  matchedIn?: 'metadata' | 'content'
  /** Only present on body matches. */
  snippet?: string
  /** Relevance score (higher = better); only when a query was given. */
  score?: number
}

export const searchNotesTool: Tool = {
  metadata: {
    name: 'search_notes',
    description:
      'Search notes by keywords and/or filters. Multiple keywords are matched independently and results ranked by relevance (note name > tags/headings > path/frontmatter). Matches note name, path, tags, headings and frontmatter; when the metadata finds nothing the note BODIES are scanned automatically (slower, capped). Use this to find a note before reading or editing it.',
    category: 'search',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords (space-separated, 1-3 short words work best) to match against name/path/tags/headings/frontmatter. Optional if a filter is given.',
        },
        tag: {
          type: 'string',
          description: 'Only include notes that have this tag (without leading #).',
        },
        path: {
          type: 'string',
          description: 'Only include notes under this folder path, e.g. "Projects".',
        },
        limit: {
          type: 'number',
          description: `Max results to return (default ${DEFAULT_LIMIT}).`,
        },
        content: {
          type: 'boolean',
          description: '强制同时搜索笔记正文（默认 false：元数据 0 命中时会自动回退到正文扫描）',
        },
      },
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const app = ctx.app
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const tokens = tokenize(query)
    const tagFilter = typeof args.tag === 'string' ? args.tag.replace(/^#/, '').trim().toLowerCase() : ''
    const pathFilter = typeof args.path === 'string' ? args.path.trim() : ''
    const limit = Math.min(
      typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT,
      MAX_LIMIT,
    )

    const files = app.vault.getMarkdownFiles()
    const results: SearchHit[] = []
    const prefix = pathFilter.replace(/\/+$/, '')
    const excluded = ctx.excludedFolders ?? []
    // Explicit body scan opt-in. Independently of it, a WEAK metadata
    // result (fewer than WEAK_METADATA_HITS hits) automatically falls back
    // to scanning bodies below (exact phrases living only in a note body
    // are the top "search finds nothing" case — recall beats strict
    // opt-in; scanContent keeps the cost capped).
    const explicitContent = args.content === true && tokens.length > 0
    // Files that passed exclusion/folder/tag filters but missed the metadata
    // keyword — candidates for the (explicit or fallback) body scan.
    const candidates: Array<{ file: TFile; tags: string[] }> = []

    for (const file of files) {
      // Honor folder exclusions (Obsidian's list + plugin custom list).
      if (isExcludedPath(file.path, excluded)) continue

      if (prefix) {
        const folder = file.parent?.path ?? ''
        const inFolder =
          folder === prefix ||
          folder.startsWith(prefix + '/') ||
          file.path.startsWith(prefix + '/')
        if (!inFolder) continue
      }

      const cache = app.metadataCache.getFileCache(file)
      const tags = collectTags(cache)
      if (tagFilter && !tags.some((t) => t.toLowerCase() === tagFilter)) continue

      let score = 0
      if (tokens.length > 0) {
        score = scoreTokens(tokens, {
          basename: file.basename.toLowerCase(),
          path: file.path.toLowerCase(),
          tags: tags.join(' ').toLowerCase(),
          headings: collectHeadings(cache).join(' ').toLowerCase(),
          frontmatter: JSON.stringify(cache?.frontmatter ?? {}).toLowerCase(),
        })
        if (score === 0) {
          candidates.push({ file, tags })
          continue
        }
      }

      results.push({
        path: file.path,
        title: file.basename,
        tags,
        folder: file.parent?.path ?? '',
        // matchedIn/score are only added in query modes, so the no-query
        // output shape stays exactly as before.
        ...(explicitContent ? { matchedIn: 'metadata' as const } : {}),
        ...(tokens.length > 0 ? { score } : {}),
      })
    }

    // Rank metadata hits best-first (stable: ties keep vault order).
    if (tokens.length > 0) {
      results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    }
    const ranked = results.slice(0, limit)

    // Body scan fills remaining slots after metadata matches take priority.
    // Triggers on explicit content=true, or automatically whenever the
    // metadata recall is weak (zero or only a few stray hits).
    const contentScan =
      tokens.length > 0 && (explicitContent || ranked.length < WEAK_METADATA_HITS)
    if (contentScan && ranked.length < limit) {
      const contentHits = await scanContent(
        app,
        candidates.map((c) => c.file),
        tokens,
        { limit: limit - ranked.length, signal: ctx.signal },
      )
      const byPath = new Map(candidates.map((c) => [c.file.path, c]))
      for (const hit of contentHits) {
        const cand = byPath.get(hit.path)
        ranked.push({
          path: hit.path,
          title: hit.title,
          tags: cand?.tags ?? [],
          folder: cand?.file.parent?.path ?? '',
          matchedIn: 'content',
          snippet: hit.snippet,
          score: CONTENT_SCORE,
        })
      }
    }

    return {
      ok: true,
      summary:
        ranked.length > 0
          ? `找到 ${ranked.length} 条笔记（最多 ${limit}）`
          : '未找到匹配的笔记',
      output: { count: ranked.length, results: ranked },
    }
  },
}
