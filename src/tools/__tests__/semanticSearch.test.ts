// semantic_search: unconfigured/disabled guidance branches (no network).
// The happy path needs a live embedding service — covered by the pure pieces
// (embedClient/cosine/indexer store) tested separately.

import type { ToolContext } from '../../core/agent/types'
import {
  initRetrievalIndexer,
  resetRetrievalIndexer,
} from '../../core/retrieval/indexer'
import { semanticSearchTool } from '../semanticSearch'

const ctx = { signal: undefined } as unknown as ToolContext

function mkIndexer(enabled: boolean, apiKey: string): void {
  initRetrievalIndexer({
    app: {} as unknown as ToolContext['app'],
    getEmbedConfig: () => ({
      enabled,
      baseUrl: 'https://x',
      apiKey,
      model: 'm',
    }),
    getAiFolder: () => 'AI 助手',
    getExcludedFolders: () => [],
  })
}

describe('semanticSearchTool', () => {
  afterEach(() => {
    resetRetrievalIndexer()
  })

  it('rejects empty queries', async () => {
    const res = await semanticSearchTool.run({ query: '  ' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('查询内容')
  })

  it('guides to the settings page when no indexer is wired', async () => {
    const res = await semanticSearchTool.run({ query: '任意查询' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('语义检索未启用')
    expect(res.summary).toContain('search_notes')
  })

  it('guides when the channel is switched off', async () => {
    mkIndexer(false, 'sk-key')
    const res = await semanticSearchTool.run({ query: '任意查询' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('语义检索未启用')
  })

  it('guides when enabled but the API key is missing', async () => {
    mkIndexer(true, '')
    const res = await semanticSearchTool.run({ query: '任意查询' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('语义检索未启用')
  })
})
