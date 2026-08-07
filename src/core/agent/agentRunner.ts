// The agent loop (toolManager). Streams the LLM, collects any tool calls it
// makes, runs them (with confirmation for destructive ones), feeds the results
// back as `tool` messages, and repeats until the model produces a final answer
// or the turn budget is exhausted.
//
// Turn accounting:
// - `budget` (initial = maxTurns) counts SUBSTANTIVE tool turns. A turn whose
//   tool calls are ALL `todo_write` (pure in-memory progress reporting, zero
//   side effects) is budget-free for the first FREE_TODO_TURN_LIMIT such
//   turns; after that it consumes budget like any other turn.
// - An absolute hard cap of `maxTurns * 3` LLM calls guards against runaway
//   loops even with many free turns.
// - When the budget (or hard cap) is exhausted we do a SOFT wrap-up instead
//   of a hard stop: a system instruction is appended and one final call runs
//   with `tools: []` so the model can summarize what it already achieved. If
//   the wrap-up turn STILL requests tools, we fall back to the error event.
//
// Yields a stream of `AgentEvent`s the React layer renders live.

import {
  ChatCompletionTool,
  ChatMessage,
  FinishReason,
  LLMProvider,
  StreamChatOptions,
  TokenUsage,
  ToolCall,
} from '../llm/base'
import { friendlyMessage } from '../llm/errors'
import { dlog } from '../../utils/diagnosticLog'
import type { ToolRegistry } from './ToolRegistry'
import type { Tool, ToolContext } from './types'

const MAX_TURNS = 8
/** How many pure-`todo_write` turns may run without consuming budget. */
const FREE_TODO_TURN_LIMIT = 3
/** The tool whose turns are eligible for the budget exemption. */
const TODO_TOOL_NAME = 'todo_write'

/**
 * M2-T8 主 agent 审批还原：破坏性工具是否弹审批面板，按审批模式决定
 * （与 hermes 同套语义，见 core/agent/approval.ts）：
 * - 'dont_ask'：全放行；
 * - 'accept_edits'：编辑类（category 'write'，即 edit_note）自动放行，
 *   删除/移动等仍弹；
 * - 缺省或 'default'：回落 confirmDestructive 旧逻辑（默认确认）。
 * forceConfirm（delete_note）不经过这里——调用方恒确认。
 */
export function destructiveNeedsConfirm(
  ctx: Pick<ToolContext, 'confirmDestructive' | 'approvalMode'>,
  category: string | undefined,
): boolean {
  if (ctx.approvalMode === 'dont_ask') return false
  if (ctx.approvalMode === 'accept_edits') return category !== 'write'
  return ctx.confirmDestructive !== false
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; callId: string; name: string; args: Record<string, unknown>; thinking?: string }
  | {
      type: 'tool-result'
      callId: string
      name: string
      ok: boolean
      summary: string
      output?: unknown
    }
  | { type: 'done'; usage?: TokenUsage; finish?: FinishReason }
  | { type: 'error'; message: string }

interface PendingToolCall {
  id?: string
  name?: string
  argsStr: string
}

function safeParse(json: string): Record<string, unknown> {
  if (!json.trim()) return {}
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function fallbackId(index: number): string {
  return `call-${index}-${Math.random().toString(36).slice(2, 10)}`
}

/** Everything one streamed LLM turn produced. */
interface TurnOutcome {
  text: string
  thinkingText: string
  toolCalls: ToolCall[]
  finish: FinishReason
  usage?: TokenUsage
}

/**
 * Runs a single `streamChat` pass, yielding text deltas live and returning
 * the collected turn outcome. Shared by the main loop and the wrap-up turn.
 */
async function* streamTurn(
  provider: LLMProvider,
  messages: ChatMessage[],
  tools: ChatCompletionTool[],
  chatOptions: StreamChatOptions | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, TurnOutcome> {
  const pending = new Map<number, PendingToolCall>()
  let text = ''
  let thinkingText = ''
  let finish: FinishReason = 'stop'
  let usage: TokenUsage | undefined

  for await (const chunk of provider.streamChat(messages, tools, {
    ...chatOptions,
    signal,
  })) {
    if (chunk.type === 'text') {
      text += chunk.text
      yield { type: 'text', text: chunk.text }
    } else if (chunk.type === 'thinking') {
      thinkingText += chunk.text
    } else if (chunk.type === 'web-search') {
      // Server-side built-in search (Responses API): purely visual — surface
      // it as a synthetic tool step so the thought chain shows the search,
      // but never touch `messages` (the server owns its own tool loop).
      const callId = `ws:${chunk.id}`
      if (chunk.status === 'searching') {
        yield {
          type: 'tool-start',
          callId,
          name: 'web_search',
          args: chunk.query ? { query: chunk.query } : {},
        }
      } else {
        const sources = chunk.sources ?? []
        yield {
          type: 'tool-result',
          callId,
          name: 'web_search',
          ok: true,
          summary:
            sources.length > 0
              ? `联网搜索完成，找到 ${sources.length} 个来源`
              : '联网搜索完成',
          output: { sources },
        }
      }
    } else if (chunk.type === 'tool-call') {
      const tc = chunk.toolCall
      const entry = pending.get(tc.index) ?? { argsStr: '' }
      if (tc.id) entry.id = tc.id
      if (tc.name) entry.name = tc.name
      if (tc.arguments) entry.argsStr += tc.arguments
      pending.set(tc.index, entry)
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
      usage = chunk.usage
    }
  }

  const toolCalls: ToolCall[] = Array.from(pending.entries()).map(
    ([index, entry]) => ({
      id: entry.id ?? fallbackId(index),
      name: entry.name ?? '',
      arguments: entry.argsStr,
    }),
  )

  return { text, thinkingText, toolCalls, finish, usage }
}

export async function* runAgent(opts: {
  provider: LLMProvider
  history: ChatMessage[]
  registry: ToolRegistry
  ctx: ToolContext
  maxTurns?: number
  /** Extra provider options (e.g. thinking level) applied to every turn. */
  chatOptions?: StreamChatOptions
  /**
   * The tool set for THIS run (defaults to everything in the registry).
   * Pass [] for a pure-chat turn with no tools offered and nothing
   * executable — used by the ephemeral /btw aside question.
   */
  tools?: Tool[]
}): AsyncGenerator<AgentEvent> {
  const { provider, registry, ctx } = opts
  const maxTurns = opts.maxTurns ?? MAX_TURNS
  const messages: ChatMessage[] = [...opts.history]
  const runTools = opts.tools ?? registry.getAll()
  const tools: ChatCompletionTool[] = runTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.metadata.name,
      description: tool.metadata.description,
      parameters: tool.metadata.parameters,
    },
  }))

  let budget = maxTurns
  let freeTodoTurns = 0
  const hardCap = maxTurns * 3
  let llmCalls = 0

  while (budget > 0 && llmCalls < hardCap) {
    if (ctx.signal?.aborted) return

    const turn = yield* streamTurn(provider, messages, tools, opts.chatOptions, ctx.signal)
    llmCalls++

    // No (valid) tool calls → this turn's text is the final answer.
    if (turn.finish !== 'tool-calls' || turn.toolCalls.length === 0) {
      dlog('info', 'agent', `done finish=${turn.finish} llmCalls=${llmCalls}`)
      yield { type: 'done', usage: turn.usage, finish: turn.finish }
      return
    }

    // Record the assistant turn that requested the tools.
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })

    // Execute each requested tool and feed the result back.
    for (const call of turn.toolCalls) {
      if (ctx.signal?.aborted) return
      const args = safeParse(call.arguments)
      yield { type: 'tool-start', callId: call.id, name: call.name, args, thinking: turn.thinkingText || undefined }

      const outcome = await executeTool(call, args, runTools, ctx)
      // Opt-in diagnostics: tool name + outcome only (never args/content).
      if (outcome.ok) {
        dlog('info', 'tool', `${call.name} ok`)
      } else {
        dlog('warn', 'tool', `${call.name} fail: ${outcome.summary.slice(0, 120)}`)
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(outcome.payload),
      })
      yield {
        type: 'tool-result',
        callId: call.id,
        name: call.name,
        ok: outcome.ok,
        summary: outcome.summary,
        output: outcome.data,
      }
    }

    // Budget accounting: a turn consisting solely of todo_write calls is
    // progress reporting without side effects — exempt it (up to a limit).
    const allTodoWrite = turn.toolCalls.every((c) => c.name === TODO_TOOL_NAME)
    if (allTodoWrite && freeTodoTurns < FREE_TODO_TURN_LIMIT) {
      freeTodoTurns++
    } else {
      budget--
    }
  }

  // Budget (or the absolute hard cap) exhausted → soft wrap-up: instruct the
  // model to summarize with no tools offered, instead of a hard error stop.
  messages.push({
    role: 'system',
    content: '已达工具轮数上限。请不要再调用任何工具，直接基于已有结果给出最终总结。',
  })
  const wrapUp = yield* streamTurn(provider, messages, [], opts.chatOptions, ctx.signal)
  if (wrapUp.finish === 'tool-calls') {
    // The model insists on more tools even when none are offered — fall back
    // to the original hard-stop error as the last-resort guard.
    dlog('warn', 'agent', `tool budget exhausted maxTurns=${maxTurns} llmCalls=${llmCalls}`)
    yield { type: 'error', message: `达到最大工具调用轮数（${maxTurns}），已停止。` }
    return
  }
  yield { type: 'done', usage: wrapUp.usage, finish: wrapUp.finish }
}

async function executeTool(
  call: ToolCall,
  args: Record<string, unknown>,
  tools: Tool[],
  ctx: ToolContext,
): Promise<{ ok: boolean; summary: string; payload: unknown; data?: unknown }> {
  const tool: Tool | undefined = tools.find(
    (t) => t.metadata.name === call.name,
  )
  if (!tool) {
    const summary = `未知工具：${call.name}`
    return { ok: false, summary, payload: { ok: false, error: summary } }
  }

  try {
    const needsConfirm =
      tool.metadata.forceConfirm === true ||
      (tool.metadata.destructive &&
        destructiveNeedsConfirm(ctx, tool.metadata.category))
    if (needsConfirm) {
      const confirmed = await ctx.confirm({
        toolName: call.name,
        title: `确认执行「${call.name}」`,
        message: tool.confirmSummary
          ? tool.confirmSummary(args)
          : `即将执行 ${call.name}：\n${JSON.stringify(args, null, 2)}`,
      })
      if (!confirmed) {
        const summary = '用户取消了该操作'
        return { ok: false, summary, payload: { ok: false, error: 'user_cancelled' } }
      }
    }

    const result = await tool.run(args, ctx)
    return {
      ok: result.ok,
      summary: result.summary,
      payload: { ok: result.ok, summary: result.summary, data: result.output },
      data: result.output,
    }
  } catch (err) {
    const summary = friendlyMessage(err)
    return { ok: false, summary, payload: { ok: false, error: summary } }
  }
}
