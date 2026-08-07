// Context compression ('/compact [策略]', 追加⑯): distill the live
// conversation into a lossless summary (one-shot LLM call, no tools), then
// replace the live context with [command echo, summary]. Durable takeaways
// ride along into memory.md through the SAME store save_memory uses — the
// memory system linkage. Pure helpers here; orchestration lives in
// useAgent's /compact branch.

import type { UiMessage } from '../components/chat-view/types'
import { historyTextOfBlocks } from '../components/chat-view/transcript'

/** Section marker the model emits between summary and memory entries —
 *  parseCompactResult splits the output on it. */
export const MEMORY_MARKER = '【记忆】'

/** Upper bound on memory entries written per compaction. */
export const MAX_COMPACT_MEMORIES = 5

/** Minimum real (non-ephemeral) messages before compacting pays off. */
export const MIN_COMPACT_MESSAGES = 4

/**
 * System prompt for the one-shot compaction call. Without `strategy` the
 * default lossless method applies; with one, the user's instruction is
 * appended and told to take priority (the user asked for a way to describe
 * their own compression strategy — empty falls back to the default).
 */
export function buildCompactPrompt(strategy?: string): string {
  const s = (strategy ?? '').trim()
  const lines = [
    '你是对话上下文压缩助手。把用户给出的对话实录压缩成一份「无损摘要」，让一段新对话仅凭摘要就能无缝接续。',
    '',
    '必须保留：所有决策与结论；用户的偏好、约束与纠正；关键事实与数据；未完成的待办任务；提到过的文件路径 / 笔记名；用户强调的重要原话。',
    '可以丢弃：寒暄与情绪话；已被后续结论推翻或取代的尝试；中间推理、试错与重复内容。',
    '',
    '严格按此格式输出（不要任何开场白和结尾语）：',
    '1. 先直接输出压缩摘要本身：用连贯易读的中文散文（可按主题分段），覆盖上述「必须保留」的全部内容。',
    `2. 然后另起一行输出「${MEMORY_MARKER}」，其下逐行列出值得写入长期记忆库的条目（每条以 - 开头，${MAX_COMPACT_MEMORIES} 条以内），只收用户偏好 / 长期约束 / 关键事实；没有就写「- 无」。`,
    '',
    '不得编造实录里没有的内容。',
  ]
  if (s) {
    lines.push('', `用户的压缩策略要求（优先遵循）：${s}`)
  }
  return lines.join('\n')
}

/**
 * Render the live conversation as a plain transcript for the compressor.
 * Ephemeral /btw asides are display-only — never part of the context handed
 * to the LLM — so they are skipped here too. Assistant turns go through
 * historyTextOfBlocks (Task #8): besides text, the budgeted 【工具轨迹】
 * trace and the latest 【任务清单】 snapshot reach the compressor, so the
 * summary keeps what the AI already did.
 */
export function buildCompactTranscript(messages: UiMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.ephemeral) continue
    const text = (
      m.role === 'user' ? (m.content ?? '') : historyTextOfBlocks(m.blocks)
    ).trim()
    if (!text) continue
    parts.push(`${m.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return parts.join('\n\n')
}

export interface CompactResult {
  summary: string
  memories: string[]
}

/**
 * Split the model's output on 【记忆】: the part before is the summary, the
 * "-" bullets under it are the memory candidates (placeholder "无" / empty
 * bullets filtered). A missing marker yields a summary-only result.
 */
export function parseCompactResult(raw: string): CompactResult {
  const text = (raw ?? '').trim()
  const idx = text.indexOf(MEMORY_MARKER)
  if (idx === -1) return { summary: text, memories: [] }
  const summary = text.slice(0, idx).trim()
  const memories = text
    .slice(idx + MEMORY_MARKER.length)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]?\s*/, '').trim())
    .filter((l) => l !== '' && l !== '无' && l.toLowerCase() !== 'none')
  return { summary: summary || text, memories }
}

/** The assistant bubble shown after a successful compaction. */
export function compactionMessageText(
  summary: string,
  savedMemories: number,
  strategy?: string,
): string {
  const memNote =
    savedMemories > 0
      ? `已把 ${savedMemories} 条长期记忆写入 memory.md（下次新对话起生效）。`
      : '未写入新的长期记忆。'
  const s = (strategy ?? '').trim()
  const stratNote = s ? `（按你的压缩策略：${s}）` : ''
  return [
    `✅ 上下文已压缩，后续对话将基于下方摘要继续${stratNote}`,
    '原实录不再发送给模型；旧消息仍保存在已保存的历史对话 / 分支里，可从 /chats 找回。',
    memNote,
    '',
    '---',
    '',
    summary.trim(),
  ].join('\n')
}
