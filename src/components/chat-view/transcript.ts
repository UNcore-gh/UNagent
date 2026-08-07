// Compact serialization of assistant blocks for the LLM history (Task #7).
// `textOfBlocks` (types.ts) only carries text + the todo snapshot; this
// module is its enhanced version: it additionally preserves a BUDGETED
// tool-call trace so the model remembers what it already did across turns,
// without paying for full tool outputs.
//
// Trace budget degradation strategy (newest entries are most valuable):
//   1. Full one-liner per tool block: `[工具] name(args摘要) → ok/失败: summary`
//   2. Over budget → OLDEST entries degrade first to bare name lines `[工具] name`
//   3. Still over budget → hard-truncate the assembled section to the cap.
// `thinking` / `output` never enter history (UI-only, too large).

import type { UiBlock } from './types'

/** Character budget for the whole 【工具轨迹】 section. */
export const TRACE_BUDGET = 1200
/** args JSON.stringify gets cut to this many chars. */
const ARGS_MAX = 80
/** summary gets cut to this many chars. */
const SUMMARY_MAX = 120

type ToolBlock = Extract<UiBlock, { kind: 'tool' }>
type TodoBlock = Extract<UiBlock, { kind: 'todo' }>

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function fullLine(b: ToolBlock): string {
  const argsRaw = b.args ? truncate(JSON.stringify(b.args), ARGS_MAX) : ''
  const status = b.state === 'error' ? '失败' : 'ok'
  const head = argsRaw ? `[工具] ${b.name}(${argsRaw})` : `[工具] ${b.name}()`
  const summary = b.summary ? truncate(b.summary, SUMMARY_MAX) : ''
  return summary ? `${head} → ${status}: ${summary}` : `${head} → ${status}`
}

function nameLine(b: ToolBlock): string {
  return `[工具] ${b.name}`
}

/** Assemble the tool trace section under TRACE_BUDGET, degrading oldest
 *  entries first (see the file-level strategy note). */
function buildTrace(tools: ToolBlock[]): string {
  let lines = tools.map(fullLine)
  const measure = (ls: string[]) => ls.join('\n').length
  if (measure(lines) > TRACE_BUDGET) {
    // Degrade from the OLDEST entry until it fits (or all are bare names).
    lines = lines.slice()
    for (let i = 0; i < tools.length && measure(lines) > TRACE_BUDGET; i++) {
      lines[i] = nameLine(tools[i])
    }
  }
  let joined = lines.join('\n')
  // Last resort: hard-truncate the whole section, keeping the NEWEST tail
  // (matches the degradation philosophy). Reserve one char for the ellipsis
  // so the total stays ≤ budget.
  if (joined.length > TRACE_BUDGET) {
    joined = `…${joined.slice(-(TRACE_BUDGET - 1))}`
  }
  return joined
}

/** Todo snapshot in exactly the same format as textOfBlocks (types.ts). */
function buildTodoSnapshot(todo: TodoBlock): string {
  const MARK: Record<string, string> = {
    completed: '[x]',
    in_progress: '[→]',
    pending: '[ ]',
  }
  return todo.items
    .map((i) => `- ${MARK[i.status] ?? '[ ]'} ${i.content}`)
    .join('\n')
}

/**
 * Enhanced history text for an assistant message: text blocks, then a
 * budgeted 【工具轨迹】 section (only when tool blocks exist), then the
 * latest 【任务清单】 snapshot (only when a todo block exists).
 */
export function historyTextOfBlocks(blocks: UiBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return ''
  const text = blocks
    .filter((b): b is Extract<UiBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('')
  const tools = blocks.filter(
    (b): b is ToolBlock => b.kind === 'tool',
  )
  const todo = [...blocks]
    .reverse()
    .find((b): b is TodoBlock => b.kind === 'todo')

  const sections: string[] = []
  if (text) sections.push(text)
  if (tools.length > 0) sections.push(`【工具轨迹】\n${buildTrace(tools)}`)
  if (todo) sections.push(`【任务清单】\n${buildTodoSnapshot(todo)}`)
  return sections.join('\n\n')
}
