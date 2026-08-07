// Hermes session/update → UiBlock 映射（补刀·五十六）：文本增量追加、思考
// 挂下一个工具、工具卡 start/complete 配对、plan → todo upsert、usage/标题
// 旁路、未知类型忽略。

import type { UiBlock } from '../../../components/chat-view/types'
import {
  HERMES_PLAN_CALL_ID,
  HERMES_THOUGHT_CALL_ID,
  applyHermesUpdate,
  extractHermesContentText,
  flushHermesThinking,
  type HermesMapResult,
  type HermesTurnState,
} from '../blockMapper'
import type { HermesSessionUpdate } from '../types'

const st = (): HermesTurnState => ({ thinking: '' })

describe('applyHermesUpdate: text streaming', () => {
  it('creates then appends to the tail text block', () => {
    const state = st()
    let r = applyHermesUpdate([], state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '你好' },
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '，世界' },
    })
    expect(r.blocks).toEqual([{ kind: 'text', text: '你好，世界' }])
  })

  it('starts a NEW text block after a tool block (multi-segment turns)', () => {
    const state = st()
    const withTool: UiBlock[] = [
      { kind: 'text', text: '先看看' },
      { kind: 'tool', callId: 'tc1', name: 'ls', state: 'done' },
    ]
    const r = applyHermesUpdate(withTool, state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '结果如下' },
    })
    expect(r.blocks).toHaveLength(3)
    expect(r.blocks[2]).toEqual({ kind: 'text', text: '结果如下' })
  })

  it('ignores empty chunks', () => {
    const r = applyHermesUpdate([], st(), {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
    })
    expect(r.blocks).toEqual([])
  })
})

describe('applyHermesUpdate: thought + tool calls', () => {
  it('accumulates thought and attaches it to the NEXT tool call', () => {
    const state = st()
    applyHermesUpdate([], state, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '让我想想' },
    })
    expect(state.thinking).toBe('让我想想')
    const r = applyHermesUpdate([], state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'terminal: ls',
      kind: 'execute',
      rawInput: { command: 'ls' },
    })
    expect(state.thinking).toBe('') // consumed
    expect(r.blocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'tc-1',
      name: 'terminal: ls',
      state: 'running',
      args: { command: 'ls' },
      thinking: '让我想想',
    })
  })

  it('completes a tool block by callId with status and output', () => {
    const state = st()
    let r = applyHermesUpdate([], state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-9',
      title: 'read: note.md',
      kind: 'read',
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-9',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '文件内容…' } }],
    })
    expect(r.blocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'tc-9',
      state: 'done',
      output: '文件内容…',
    })
  })

  it('maps status=failed to the error state', () => {
    const state = st()
    let r = applyHermesUpdate([], state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'terminal: rm',
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      status: 'failed',
      content: { text: 'permission denied' },
    })
    expect(r.blocks[0]).toMatchObject({ state: 'error', output: 'permission denied' })
  })

  it('creates a terminal block for unmatched tool_call_update', () => {
    const r = applyHermesUpdate([], st(), {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'orphan',
      status: 'completed',
      title: 'orphan tool',
    })
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ callId: 'orphan', state: 'done' })
  })
})

describe('applyHermesUpdate: plan → todo', () => {
  const plan = (statuses: Array<'pending' | 'in_progress' | 'completed'>) => ({
    sessionUpdate: 'plan' as const,
    entries: statuses.map((s, i) => ({ content: `步骤${i + 1}`, status: s })),
  })

  it('upserts ONE todo block across plan updates', () => {
    const state = st()
    let r = applyHermesUpdate([], state, plan(['pending', 'pending']))
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({
      kind: 'todo',
      callId: HERMES_PLAN_CALL_ID,
      state: 'running',
    })
    r = applyHermesUpdate(r.blocks, state, plan(['completed', 'completed']))
    expect(r.blocks).toHaveLength(1) // upsert, not append
    expect(r.blocks[0]).toMatchObject({ state: 'done' })
    const items = (r.blocks[0] as Extract<UiBlock, { kind: 'todo' }>).items
    expect(items.map((i) => i.status)).toEqual(['completed', 'completed'])
  })

  it('ignores empty plan payloads', () => {
    const r = applyHermesUpdate([], st(), { sessionUpdate: 'plan', entries: [] })
    expect(r.blocks).toEqual([])
  })
})

describe('applyHermesUpdate: side info + tolerance', () => {
  it('surfaces usage and session title without touching blocks', () => {
    const r1 = applyHermesUpdate([], st(), {
      sessionUpdate: 'usage_update',
      size: 128000,
      used: 4200,
    })
    expect(r1.blocks).toEqual([])
    expect(r1.usage).toEqual({ size: 128000, used: 4200 })

    const r2 = applyHermesUpdate([], st(), {
      sessionUpdate: 'session_info_update',
      title: '新标题',
    })
    expect(r2.sessionTitle).toBe('新标题')
  })

  it('ignores unknown update kinds (forward compatibility)', () => {
    const r = applyHermesUpdate([], st(), {
      sessionUpdate: 'config_option_update',
      anything: true,
    })
    expect(r.blocks).toEqual([])
  })
})

describe('extractHermesContentText', () => {
  it('handles strings, {text}, nested content and arrays', () => {
    expect(extractHermesContentText('plain')).toBe('plain')
    expect(extractHermesContentText({ text: 'obj' })).toBe('obj')
    expect(
      extractHermesContentText([{ type: 'content', content: { type: 'text', text: 'a' } }, { text: 'b' }]),
    ).toBe('a\nb')
    expect(extractHermesContentText(null)).toBeUndefined()
    expect(extractHermesContentText({})).toBeUndefined()
  })

  it('caps very long output', () => {
    const long = 'x'.repeat(3000)
    const out = extractHermesContentText(long)
    expect(out?.length).toBeLessThanOrEqual(1201)
    expect(out?.endsWith('…')).toBe(true)
  })
})

/* ── M2-T8：长任务帧流健壮性 ─────────────────────────────────────── */

describe('applyHermesUpdate: 工具卡配对健壮性（M2-T8）', () => {
  const start = (
    toolCallId: string,
    extra: Record<string, unknown> = {},
  ): HermesSessionUpdate => ({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'terminal: ls',
    kind: 'execute',
    ...extra,
  })
  const complete = (
    toolCallId: string,
    extra: Record<string, unknown> = {},
  ): HermesSessionUpdate => ({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: { text: '输出' },
    ...extra,
  })

  it('乱序：complete 先于 start——孤儿成卡，迟到 start 不新建卡、不改终态', () => {
    const state = st()
    let r = applyHermesUpdate([], state, complete('tc-x'))
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ callId: 'tc-x', state: 'done', output: '输出' })
    // 迟到的 start 带 args：只补信息，不新建第二张卡，不退回 running。
    r = applyHermesUpdate(r.blocks, state, start('tc-x', { rawInput: { command: 'ls -la' } }))
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({
      callId: 'tc-x',
      state: 'done',
      args: { command: 'ls -la' },
      output: '输出',
    })
  })

  it('缺失帧：只有 start 无 complete——保持进行中态', () => {
    const r = applyHermesUpdate([], st(), start('tc-open'))
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ callId: 'tc-open', state: 'running' })
  })

  it('重复 start 帧：不产生重复卡片，只补齐缺失字段', () => {
    const state = st()
    let r = applyHermesUpdate([], state, start('tc-d', { rawInput: { command: 'ls' } }))
    r = applyHermesUpdate(r.blocks, state, start('tc-d'))
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({
      callId: 'tc-d',
      state: 'running',
      args: { command: 'ls' }, // 第二次无 rawInput，不覆盖
    })
  })

  it('重复 complete 帧：幂等覆盖，不新增卡片、不清空已有 output', () => {
    const state = st()
    let r = applyHermesUpdate([], state, start('tc-r'))
    r = applyHermesUpdate(r.blocks, state, complete('tc-r'))
    // 第二帧不带 content——旧 output 必须保留。
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-r',
      status: 'completed',
    })
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ callId: 'tc-r', state: 'done', output: '输出' })
  })

  it('无 status 的中间进度帧：刷新 title/output 但不误判为完成', () => {
    const state = st()
    let r = applyHermesUpdate([], state, start('tc-p'))
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-p',
      title: 'terminal: 正在运行…',
      content: { text: '部分输出' },
    })
    expect(r.blocks[0]).toMatchObject({
      state: 'running',
      name: 'terminal: 正在运行…',
      output: '部分输出',
    })
    // 终态帧随后到达，正常收尾。
    r = applyHermesUpdate(r.blocks, state, complete('tc-p'))
    expect(r.blocks[0]).toMatchObject({ state: 'done' })
  })

  it('畸形帧：缺 toolCallId 的 start/complete 均被丢弃，不产生无键卡片', () => {
    const state = st()
    let r = applyHermesUpdate([], state, {
      sessionUpdate: 'tool_call',
      toolCallId: '',
      title: 'ghost',
    } as unknown as HermesSessionUpdate)
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: undefined,
      status: 'completed',
    } as unknown as HermesSessionUpdate)
    expect(r.blocks).toEqual([])
  })

  it('failed 后再收 completed 的重复帧序列：状态跟随最新终态', () => {
    const state = st()
    let r = applyHermesUpdate([], state, start('tc-f'))
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-f',
      status: 'failed',
      content: { text: 'boom' },
    })
    expect(r.blocks[0]).toMatchObject({ state: 'error', summary: '失败' })
    r = applyHermesUpdate(r.blocks, state, complete('tc-f'))
    expect(r.blocks[0]).toMatchObject({ state: 'done', output: '输出' })
    expect((r.blocks[0] as Extract<UiBlock, { kind: 'tool' }>).summary).toBeUndefined()
  })
})

describe('flushHermesThinking: 思考归属兜底（M2-T8）', () => {
  it('有后续工具：thinking 正常挂到下一个工具卡（既有语义不变）', () => {
    const state = st()
    applyHermesUpdate([], state, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '盘算一下' },
    })
    const r = applyHermesUpdate([], state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-t',
      title: 'read: a.md',
    })
    expect(r.blocks[0]).toMatchObject({ thinking: '盘算一下' })
    expect(state.thinking).toBe('')
  })

  it('无后续工具：轮末 flush 把残留 thinking 固化成思考卡', () => {
    const state = st()
    let r = applyHermesUpdate([], state, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '想完就没了' },
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '最终答复' },
    })
    expect(state.thinking).toBe('想完就没了') // 未被任何工具消费
    const flushed = flushHermesThinking(r.blocks, state)
    expect(state.thinking).toBe('')
    expect(flushed).toHaveLength(2)
    expect(flushed[0]).toEqual({ kind: 'text', text: '最终答复' })
    expect(flushed[1]).toMatchObject({
      kind: 'tool',
      callId: HERMES_THOUGHT_CALL_ID,
      state: 'done',
      thinking: '想完就没了',
    })
  })

  it('无 pending thinking：flush 原样返回，不产生空卡', () => {
    const state = st()
    const blocks: UiBlock[] = [{ kind: 'text', text: 'hi' }]
    expect(flushHermesThinking(blocks, state)).toBe(blocks)
  })

  it('重复 flush / 空白 thinking：幂等，不重复建卡', () => {
    const state = st()
    state.thinking = '第一段'
    let blocks = flushHermesThinking([], state)
    state.thinking = '   ' // 纯空白不算 pending
    blocks = flushHermesThinking(blocks, state)
    state.thinking = '第二段'
    blocks = flushHermesThinking(blocks, state)
    const thoughtCards = blocks.filter(
      (b) => b.kind === 'tool' && b.callId === HERMES_THOUGHT_CALL_ID,
    )
    expect(thoughtCards).toHaveLength(1)
    expect(thoughtCards[0]).toMatchObject({ thinking: '第一段\n第二段' })
  })
})

describe('applyHermesUpdate: plan 幂等 upsert 健壮性（M2-T8）', () => {
  it('同一 plan 重复到达：始终只有一张清单块，状态以最新为准', () => {
    const state = st()
    const plan: HermesSessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: '步骤1', status: 'in_progress' },
        { content: '步骤2', status: 'pending' },
      ],
    }
    let r: HermesMapResult = applyHermesUpdate([], state, plan)
    r = applyHermesUpdate(r.blocks, state, plan) // 完全相同的帧重放
    r = applyHermesUpdate(r.blocks, state, plan)
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ kind: 'todo', state: 'running' })
    // 状态推进后覆盖式更新，块数不变。
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'plan',
      entries: [
        { content: '步骤1', status: 'completed' },
        { content: '步骤2', status: 'completed' },
      ],
    })
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ kind: 'todo', state: 'done' })
  })

  it('plan 混在工具卡之间：upsert 原位更新，不改变相对顺序', () => {
    const state = st()
    let r = applyHermesUpdate([], state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'read',
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'plan',
      entries: [{ content: 'a', status: 'pending' }],
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'write',
    })
    r = applyHermesUpdate(r.blocks, state, {
      sessionUpdate: 'plan',
      entries: [{ content: 'a', status: 'completed' }],
    })
    expect(r.blocks.map((b) => b.kind)).toEqual(['tool', 'todo', 'tool'])
    expect(r.blocks[1]).toMatchObject({ kind: 'todo', state: 'done' })
  })

  it('畸形条目（null/字符串/缺 status）逐项降级，不抛错', () => {
    const state = st()
    const r = applyHermesUpdate([], state, {
      sessionUpdate: 'plan',
      entries: [
        null,
        '裸字符串',
        { content: '正常条目' }, // 缺 status → pending
        { content: '另一条', status: 'completed' },
      ] as unknown as Array<{ content: string; status: 'pending' }>,
    })
    expect(r.blocks).toHaveLength(1)
    const items = (r.blocks[0] as Extract<UiBlock, { kind: 'todo' }>).items
    expect(items).toEqual([
      { content: '正常条目', status: 'pending' },
      { content: '另一条', status: 'completed' },
    ])
  })

  it('条目全部畸形：不建空清单块', () => {
    const r = applyHermesUpdate([], st(), {
      sessionUpdate: 'plan',
      entries: [null, 42] as unknown as Array<{ content: string; status: 'pending' }>,
    })
    expect(r.blocks).toEqual([])
  })

  it('entries 非数组：按空处理', () => {
    const r = applyHermesUpdate([], st(), {
      sessionUpdate: 'plan',
      entries: 'oops',
    } as unknown as HermesSessionUpdate)
    expect(r.blocks).toEqual([])
  })
})

describe('applyHermesUpdate: 长任务帧流稳定性（M2-T8 · ROADMAP §5 场景1）', () => {
  it('多步分派 + 中途审批 + 大量帧：映射收敛、无重复卡、无崩溃', () => {
    const state = st()
    let blocks: UiBlock[] = []
    const apply = (update: HermesSessionUpdate): void => {
      blocks = applyHermesUpdate(blocks, state, update).blocks
    }

    // 开场：标题 + 计划。
    apply({ sessionUpdate: 'session_info_update', title: '多步任务' })
    apply({
      sessionUpdate: 'plan',
      entries: [
        { content: '调研', status: 'pending' },
        { content: '实施', status: 'pending' },
        { content: '验证', status: 'pending' },
      ],
    })

    // 12 步工具循环：thought → start → (部分乱序/重复) → complete。
    for (let i = 0; i < 12; i++) {
      const id = `tc-${i}`
      apply({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: `第${i}步思考` },
      })
      if (i % 4 === 2) {
        // 乱序：complete 先于 start。
        apply({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: 'completed',
          content: { text: `结果${i}` },
        })
        apply({ sessionUpdate: 'tool_call', toolCallId: id, title: `step ${i}` })
      } else {
        apply({ sessionUpdate: 'tool_call', toolCallId: id, title: `step ${i}` })
      }
      if (i % 3 === 0) {
        // 重复 complete 帧。
        apply({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: i % 5 === 0 ? 'failed' : 'completed',
          content: { text: `结果${i}` },
        })
      }
      apply({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: i % 5 === 0 ? 'failed' : 'completed',
        content: { text: `结果${i}` },
      })
      // 每 4 步刷新一次 plan（重复 upsert）。
      if (i % 4 === 3) {
        apply({
          sessionUpdate: 'plan',
          entries: [
            { content: '调研', status: 'completed' },
            { content: '实施', status: i >= 7 ? 'completed' : 'in_progress' },
            { content: '验证', status: 'pending' },
          ],
        })
      }
      apply({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `阶段${i}小结。` },
      })
      apply({ sessionUpdate: 'usage_update', size: 128000, used: 1000 * (i + 1) })
    }

    // 收尾：最终 plan 全完成 + 总结文本 + 残留思考 flush。
    apply({
      sessionUpdate: 'plan',
      entries: [
        { content: '调研', status: 'completed' },
        { content: '实施', status: 'completed' },
        { content: '验证', status: 'completed' },
      ],
    })
    apply({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '全部完成。' },
    })
    blocks = flushHermesThinking(blocks, state)

    // 断言收敛形态：每个 callId 只有一张工具卡。
    const toolBlocks = blocks.filter(
      (b): b is Extract<UiBlock, { kind: 'tool' }> => b.kind === 'tool',
    )
    const ids = toolBlocks.map((b) => b.callId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(12) // 乱序/重复都没产生多余卡片
    // 所有工具卡都到达终态（无「进行中」泄漏）。
    for (const b of toolBlocks) {
      expect(['done', 'error']).toContain(b.state)
    }
    // 失败的步（i % 5 === 0：0、5、10）渲染为 error。
    expect(toolBlocks.filter((b) => b.state === 'error')).toHaveLength(3)
    // 清单只有一张且已完成。
    const todos = blocks.filter((b) => b.kind === 'todo')
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ state: 'done' })
    // 文本块按工具边界分段且全部非空。
    const texts = blocks.filter(
      (b): b is Extract<UiBlock, { kind: 'text' }> => b.kind === 'text',
    )
    expect(texts.every((b) => b.text.length > 0)).toBe(true)
    // 思考全部归属（缓冲清空，且每张工具卡都带 thinking）。
    expect(state.thinking).toBe('')
    expect(toolBlocks.every((b) => typeof b.thinking === 'string' && b.thinking !== '')).toBe(true)
  })
})
