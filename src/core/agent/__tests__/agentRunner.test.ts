// The agent loop (toolManager): stream → collect tool calls → execute →
// feed results back → repeat. Tested with a scripted fake provider and fake
// tools — no obsidian runtime needed (ToolRegistry + agentRunner are pure).

import { runAgent, AgentEvent } from '../agentRunner'
import { ToolRegistry } from '../ToolRegistry'
import type { Tool, ToolContext } from '../types'
import type { ChatMessage, LLMProvider, StreamChunk } from '../../llm/base'
import { SkillRegistry } from '../../skills/SkillRegistry'

interface FakeTool extends Tool {
  calls: Record<string, unknown>[]
}

function fakeTool(
  name: string,
  opts: {
    destructive?: boolean
    forceConfirm?: boolean
    category?: Tool['metadata']['category']
  } = {},
): FakeTool {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    metadata: {
      name,
      description: `fake ${name}`,
      category: opts.category ?? 'write',
      destructive: opts.destructive ?? false,
      forceConfirm: opts.forceConfirm,
      requiresVault: true,
      parameters: { type: 'object', properties: {} },
    },
    async run(args) {
      calls.push(args)
      return { ok: true, summary: `${name} done`, output: { echoed: args } }
    },
  }
}

/** Plays back a script of StreamChunks per streamChat call (last one repeats). */
class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted'
  receivedMessages: ChatMessage[][] = []
  receivedTools: unknown[][] = []
  private turn = 0

  constructor(private readonly scripts: StreamChunk[][]) {}

  async *streamChat(
    messages: ChatMessage[],
    tools: unknown[] = [],
  ): AsyncGenerator<StreamChunk> {
    this.receivedMessages.push(messages.map((m) => ({ ...m })))
    this.receivedTools.push([...tools])
    const script = this.scripts[Math.min(this.turn, this.scripts.length - 1)]
    this.turn++
    for (const chunk of script) yield chunk
  }
}

const baseCtx: ToolContext = {
  app: {} as ToolContext['app'],
  confirm: async () => true,
  pushUndo: () => {},
  imageProvider: { id: 'fake', generate: async () => [] },
  skills: new SkillRegistry(),
  disabledSkills: [],
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const registry = ToolRegistry.getInstance()
  registry.clear()
  registry.registerAll(tools)
  return registry
}

async function collect(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

describe('runAgent', () => {
  it('streams text and finishes when no tools are requested', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'hi' }],
        registry: makeRegistry([]),
        ctx: baseCtx,
      }),
    )
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'done'])
    expect(provider.receivedMessages).toHaveLength(1)
  })

  it('surfaces server-side web search as synthetic tool steps without touching history', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'web-search', status: 'searching', id: 'ws_1', query: '杭州天气' },
        {
          type: 'web-search',
          status: 'done',
          id: 'ws_1',
          query: '杭州天气',
          sources: [{ url: 'https://a.com/x', title: '天气网' }],
        },
        { type: 'text', text: '今天多云。' },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: '杭州天气' }],
        registry: makeRegistry([]),
        ctx: baseCtx,
      }),
    )
    expect(events.map((e) => e.type)).toEqual([
      'tool-start',
      'tool-result',
      'text',
      'done',
    ])
    expect(events[0]).toMatchObject({
      type: 'tool-start',
      callId: 'ws:ws_1',
      name: 'web_search',
      args: { query: '杭州天气' },
    })
    expect(events[1]).toMatchObject({
      type: 'tool-result',
      callId: 'ws:ws_1',
      ok: true,
      summary: '联网搜索完成，找到 1 个来源',
      output: { sources: [{ url: 'https://a.com/x', title: '天气网' }] },
    })
    // Purely visual: exactly one LLM call, and the search never enters the
    // message history as a tool round.
    expect(provider.receivedMessages).toHaveLength(1)
    expect(provider.receivedMessages[0]).toEqual([
      { role: 'user', content: '杭州天气' },
    ])
  })

  it('surfaces the model finish reason + usage on the done event', async () => {
    const usage = { promptTokens: 5, completionTokens: 3, totalTokens: 8 }
    const provider = new ScriptedProvider([
      [
        { type: 'text', text: 'truncated…' },
        { type: 'finish', reason: 'length', usage },
      ],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'hi' }],
        registry: makeRegistry([]),
        ctx: baseCtx,
      }),
    )
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      finish: 'length',
      usage,
    })
  })

  it('tools: [] offers no schemas and executes nothing (ephemeral /btw aside)', async () => {
    // Even with tools registered, a run with `tools: []` must neither offer
    // schemas to the model nor execute anything — a hallucinated call dies
    // as "未知工具" instead of touching the vault.
    const tool = fakeTool('echo')
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'echo', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [
        { type: 'text', text: 'ok' },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'by the way…' }],
        registry: makeRegistry([tool]),
        ctx: baseCtx,
        tools: [],
      }),
    )
    expect(provider.receivedTools[0]).toEqual([])
    const result = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result',
    )
    expect(result).toBeDefined()
    expect(result?.ok).toBe(false)
    expect(result?.summary).toContain('未知工具')
    expect(tool.calls).toHaveLength(0)
  })

  it('executes requested tools and feeds results back to the model', async () => {
    const tool = fakeTool('echo')
    const provider = new ScriptedProvider([
      [
        // Tool-call arguments arrive as streamed deltas — split mid-JSON.
        { type: 'tool-call', toolCall: { index: 0, id: 'call1', name: 'echo', arguments: '{"msg":' } },
        { type: 'tool-call', toolCall: { index: 0, arguments: '"hi"}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [
        { type: 'text', text: 'all done' },
        { type: 'finish', reason: 'stop' },
      ],
    ])

    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'echo hi' }],
        registry: makeRegistry([tool]),
        ctx: baseCtx,
      }),
    )

    expect(tool.calls).toEqual([{ msg: 'hi' }])
    expect(events.map((e) => e.type)).toEqual([
      'tool-start',
      'tool-result',
      'text',
      'done',
    ])
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ ok: true, output: { echoed: { msg: 'hi' } } })

    // The second model call must include the assistant tool-call turn and the
    // tool-role result turn.
    const second = provider.receivedMessages[1]
    expect(second[second.length - 2]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call1', name: 'echo', arguments: '{"msg":"hi"}' }],
    })
    expect(second[second.length - 1]).toMatchObject({
      role: 'tool',
      toolCallId: 'call1',
    })
    expect(
      (second[second.length - 1] as { content: string }).content,
    ).toContain('"ok":true')
  })

  it('skips execution and reports cancellation when the user declines', async () => {
    const tool = fakeTool('del', { destructive: true })
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'del', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([tool]),
        ctx: { ...baseCtx, confirm: async () => false },
      }),
    )
    const result = events.find((e) => e.type === 'tool-result')
    expect(result).toMatchObject({ ok: false })
    expect((result as { summary: string }).summary).toContain('取消')
    expect(tool.calls).toHaveLength(0)
  })

  it('forceConfirm tools still confirm when confirmDestructive is off; plain destructive tools do not', async () => {
    const forced = fakeTool('nuke', { destructive: true, forceConfirm: true })
    const plain = fakeTool('edit', { destructive: true })
    const confirmed: string[] = []
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'nuke', arguments: '{}' } },
        { type: 'tool-call', toolCall: { index: 1, id: 'c2', name: 'edit', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'k' }, { type: 'finish', reason: 'stop' }],
    ])
    await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([forced, plain]),
        ctx: {
          ...baseCtx,
          confirmDestructive: false,
          confirm: async (req) => {
            confirmed.push(req.toolName)
            return true
          },
        },
      }),
    )
    expect(confirmed).toEqual(['nuke'])
    expect(forced.calls).toHaveLength(1)
    expect(plain.calls).toHaveLength(1) // ran without confirmation
  })

  it('M2-T8 approvalMode=dont_ask：破坏性工具全部免确认（forceConfirm 仍强制）', async () => {
    const plain = fakeTool('edit', { destructive: true })
    const forced = fakeTool('nuke', { destructive: true, forceConfirm: true })
    const confirmed: string[] = []
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'edit', arguments: '{}' } },
        { type: 'tool-call', toolCall: { index: 1, id: 'c2', name: 'nuke', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'k' }, { type: 'finish', reason: 'stop' }],
    ])
    await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([plain, forced]),
        ctx: {
          ...baseCtx,
          approvalMode: 'dont_ask',
          confirm: async (req) => {
            confirmed.push(req.toolName)
            return true
          },
        },
      }),
    )
    expect(confirmed).toEqual(['nuke'])
    expect(plain.calls).toHaveLength(1) // ran without confirmation
    expect(forced.calls).toHaveLength(1)
  })

  it('M2-T8 approvalMode=accept_edits：write 类（编辑）自动放行，manage 类（删除/移动）仍确认', async () => {
    const edit = fakeTool('edit', { destructive: true, category: 'write' })
    const move = fakeTool('move', { destructive: true, category: 'manage' })
    const confirmed: string[] = []
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'edit', arguments: '{}' } },
        { type: 'tool-call', toolCall: { index: 1, id: 'c2', name: 'move', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'k' }, { type: 'finish', reason: 'stop' }],
    ])
    await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([edit, move]),
        ctx: {
          ...baseCtx,
          approvalMode: 'accept_edits',
          confirm: async (req) => {
            confirmed.push(req.toolName)
            return true
          },
        },
      }),
    )
    expect(confirmed).toEqual(['move'])
    expect(edit.calls).toHaveLength(1) // ran without confirmation
    expect(move.calls).toHaveLength(1)
  })

  it('M2-T8 approvalMode 缺省回落 confirmDestructive（默认 true → 破坏性工具仍确认）', async () => {
    const plain = fakeTool('edit', { destructive: true })
    const confirmed: string[] = []
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'edit', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'k' }, { type: 'finish', reason: 'stop' }],
    ])
    await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([plain]),
        ctx: {
          ...baseCtx,
          confirm: async (req) => {
            confirmed.push(req.toolName)
            return true
          },
        },
      }),
    )
    expect(confirmed).toEqual(['edit'])
    expect(plain.calls).toHaveLength(1)
  })

  it('reports an unknown tool without crashing', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'ghost', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'ok' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([]),
        ctx: baseCtx,
      }),
    )
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({
      ok: false,
    })
  })

  it('budget exhausted → one wrap-up call with empty tools, ends with done', async () => {
    const tool = fakeTool('loop')
    const toolTurn: StreamChunk[] = [
      { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'loop', arguments: '{}' } },
      { type: 'finish', reason: 'tool-calls' },
    ]
    const provider = new ScriptedProvider([
      toolTurn,
      toolTurn,
      [{ type: 'text', text: 'final summary' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([tool]),
        ctx: baseCtx,
        maxTurns: 2,
      }),
    )
    // Paid turns capped by maxTurns; wrap-up call is extra.
    expect(tool.calls).toHaveLength(2)
    expect(provider.receivedTools).toHaveLength(3)
    // The wrap-up call offers no tools…
    expect(provider.receivedTools[2]).toEqual([])
    // …and is primed with the system wrap-up instruction.
    const wrapMessages = provider.receivedMessages[2]
    expect(wrapMessages[wrapMessages.length - 1]).toMatchObject({ role: 'system' })
    // Its text is streamed and the run ends with done — no error event.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events[events.length - 2]).toMatchObject({ type: 'text', text: 'final summary' })
    expect(events[events.length - 1]).toMatchObject({ type: 'done', finish: 'stop' })
  })

  it('wrap-up turn still requesting tools → falls back to the hard-stop error', async () => {
    const tool = fakeTool('loop')
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'loop', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
    ]) // single script repeats every turn, including the wrap-up call
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([tool]),
        ctx: baseCtx,
        maxTurns: 2,
      }),
    )
    // Wrap-up call happened (with no tools offered)…
    expect(provider.receivedTools[2]).toEqual([])
    // …but its tool request is ignored, never executed.
    expect(tool.calls).toHaveLength(2)
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      message: expect.stringContaining('最大工具调用轮数'),
    })
  })

  it('pure todo_write turns are budget-free for the first 3 turns', async () => {
    const todo = fakeTool('todo_write')
    const todoTurn: StreamChunk[] = [
      { type: 'tool-call', toolCall: { index: 0, id: 't1', name: 'todo_write', arguments: '{}' } },
      { type: 'finish', reason: 'tool-calls' },
    ]
    const provider = new ScriptedProvider([
      todoTurn,
      todoTurn,
      todoTurn,
      todoTurn,
      todoTurn,
      [{ type: 'text', text: 'wrap' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([todo]),
        ctx: baseCtx,
        maxTurns: 2,
      }),
    )
    // With budget 2: turns 1–3 free, turns 4–5 consume budget, then wrap-up.
    // If todo turns were NOT exempt, only 2 turns would have run.
    expect(todo.calls).toHaveLength(5)
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })
  })

  it('turns mixing todo_write with other tools still consume budget', async () => {
    const todo = fakeTool('todo_write')
    const loop = fakeTool('loop')
    const mixedTurn: StreamChunk[] = [
      { type: 'tool-call', toolCall: { index: 0, id: 't1', name: 'todo_write', arguments: '{}' } },
      { type: 'tool-call', toolCall: { index: 1, id: 'c1', name: 'loop', arguments: '{}' } },
      { type: 'finish', reason: 'tool-calls' },
    ]
    const provider = new ScriptedProvider([
      mixedTurn,
      mixedTurn,
      [{ type: 'text', text: 'wrap' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([todo, loop]),
        ctx: baseCtx,
        maxTurns: 2,
      }),
    )
    // Mixed turns are NOT exempt: exactly maxTurns of them, then wrap-up.
    expect(todo.calls).toHaveLength(2)
    expect(loop.calls).toHaveLength(2)
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })
  })

  it('maxTurns parameter caps paid turns (custom small value)', async () => {
    const tool = fakeTool('loop')
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'loop', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'loop', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [
        { type: 'tool-call', toolCall: { index: 0, id: 'c1', name: 'loop', arguments: '{}' } },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'text', text: 'wrap' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(
      runAgent({
        provider,
        history: [{ role: 'user', content: 'x' }],
        registry: makeRegistry([tool]),
        ctx: baseCtx,
        maxTurns: 3,
      }),
    )
    expect(tool.calls).toHaveLength(3)
    expect(provider.receivedTools).toHaveLength(4) // 3 paid + 1 wrap-up
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })
  })
})
