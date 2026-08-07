// semantic_search: vector-channel recall — embeds the query remotely, then
// brute-force cosine over the local index (铁律2 修订版：本地只存储与点积，
// embedding 计算永远在远程）。结果锚定 笔记路径 + heading，可直接作为
// 引用来源回溯。索引过期时先跑一次增量同步。

import type { Tool, ToolRunResult } from '../core/agent/types'
import { getRetrievalIndexer } from '../core/retrieval/indexer'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

export const semanticSearchTool: Tool = {
  metadata: {
    name: 'semantic_search',
    description:
      'Semantic search over the vault by MEANING rather than exact keywords — finds notes whose wording differs from the query (e.g. query "我过去对副业的想法" finds a note titled "第二收入可行性分析"). Use for vague/paraphrased questions; for exact names or keywords prefer search_notes. Returns note path + section heading + excerpt; read_note to get full context.',
    category: 'search',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of what you are looking for.',
        },
        limit: {
          type: 'number',
          description: `Max notes to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: ['query'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) {
      return { ok: false, summary: '请提供查询内容', output: null }
    }
    const limit = Math.min(
      typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT,
      MAX_LIMIT,
    )

    const indexer = getRetrievalIndexer()
    if (!indexer || !indexer.channelReady()) {
      return {
        ok: false,
        summary:
          '语义检索未启用——请在设置页「检索」选项卡打开语义检索开关，并在「模型」页配置带「向量化（检索）」能力的 embedding 模型（可改用 search_notes 关键词检索）',
        output: null,
      }
    }

    try {
      const hits = await indexer.search(query, limit, ctx.signal)
      if (hits.length === 0) {
        const { count } = indexer.status()
        return {
          ok: true,
          summary:
            count === 0
              ? '向量索引为空——请先在设置页「检索」里更新索引'
              : '未找到语义相近的笔记',
          output: { count: 0, results: [] },
        }
      }
      return {
        ok: true,
        summary: `找到 ${hits.length} 篇语义相近的笔记`,
        output: { count: hits.length, results: hits },
      }
    } catch (err) {
      return {
        ok: false,
        summary: `语义检索失败：${err instanceof Error ? err.message : String(err)}`,
        output: null,
      }
    }
  },
}
