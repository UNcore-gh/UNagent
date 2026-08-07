// library_index: whole-vault directory — one line per note (title + summary
// + tags) so the agent can grasp the library at a glance before searching.
// 摘要为启发式生成（零 API 成本），缓存按 mtime 增量；「AI 精炼」摘要由
// 设置页手动触发，存在时优先展示。

import type { Tool, ToolRunResult } from '../core/agent/types'
import { ensureCatalog } from '../core/retrieval/catalog'
import { DEFAULT_AI_FOLDER } from '../utils/memoryStore'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const libraryIndexTool: Tool = {
  metadata: {
    name: 'library_index',
    description:
      'List the whole vault as a directory (path + title + one-line summary + tags). Use FIRST when you have no idea what the vault contains, or when the user asks broad questions like "我库里都有些什么". Supports paging (limit/offset). Cheaper than scanning with search_notes.',
    category: 'search',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `Max entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
        offset: {
          type: 'number',
          description: 'Skip this many entries for paging (default 0).',
        },
      },
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const limit = Math.min(
      typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT,
      MAX_LIMIT,
    )
    const offset =
      typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0

    try {
      const entries = await ensureCatalog(
        ctx.app,
        ctx.aiFolder?.trim() || DEFAULT_AI_FOLDER,
        ctx.excludedFolders ?? [],
      )
      const page = entries.slice(offset, offset + limit)
      return {
        ok: true,
        summary: `知识库共 ${entries.length} 篇笔记（本页 ${page.length} 篇）`,
        output: {
          total: entries.length,
          offset,
          entries: page.map((e) => ({
            path: e.path,
            title: e.title,
            summary: e.aiSummary || e.summary,
            tags: e.tags,
          })),
        },
      }
    } catch (err) {
      return {
        ok: false,
        summary: `生成库目录失败：${err instanceof Error ? err.message : String(err)}`,
        output: null,
      }
    }
  },
}
