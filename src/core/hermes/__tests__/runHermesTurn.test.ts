// 任务二：runHermesTurn 独立单测（scripted fake hub，绝不真起 hermes 进程）。
//
// 覆盖：会话解析（load 成功/失败降级 new/reject 降级 new）、每轮幂等
// set_mode/set_model（含任务一 §1.1 set_mode 失败 Notice 语义）、墙钟超时
// cancel→8s dispose、abort→session/cancel、新建会话首轮人设+记忆+实录包裹
// （续会话与 `/` 命令跳过）、轮末思考 flush、T3 凭据指引路径，以及 rAF
// 合并交付（多帧合并为一次 onBlocks）。

import * as obsidian from 'obsidian'

import {
  getOrCreateProjectSession,
  runHermesTurn,
  type HermesTurnHub,
  type RunHermesTurnInput,
} from '../runHermesTurn'
import { HERMES_THOUGHT_CALL_ID } from '../blockMapper'
import type {
  HermesSessionUpdate,
  PromptResult,
} from '../types'
import type { UiBlock, UiMessage } from '../../../components/chat-view/types'

/* ── scripted fake hub ──────────────────────────────────────────────── */

interface FakeHub extends HermesTurnHub {
  newSession: jest.Mock
  loadSession: jest.Mock
  forkSession: jest.Mock
  setMode: jest.Mock
  setModel: jest.Mock
  prompt: jest.Mock
  cancel: jest.Mock
  dispose: jest.Mock
  takeReadyFork: jest.Mock
  shouldSkipLoad: jest.Mock
  noCredentials: boolean
}

function makeFakeHub(): FakeHub {
  return {
    newSession: jest.fn(async () => ({ sessionId: 'sess-new' })),
    loadSession: jest.fn(async () => false),
    forkSession: jest.fn(async () => ({ sessionId: 'sess-forked' })),
    takeReadyFork: jest.fn(() => null),
    shouldSkipLoad: jest.fn(() => false),
    setMode: jest.fn(async () => undefined),
    setModel: jest.fn(async () => undefined),
    prompt: jest.fn(
      async (
        _cfg: unknown,
        _sid: string,
        _text: string,
        onUpdate: (u: HermesSessionUpdate) => void,
      ) => {
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        })
        return { stopReason: 'end_turn' } as PromptResult
      },
    ),
    cancel: jest.fn(),
    dispose: jest.fn(),
    noCredentials: false,
  }
}

/* ── 手动帧调度器（rAF 合并的测试接缝） ────────────────────────────── */

function makeScheduler() {
  let pending: (() => void) | null = null
  return {
    schedule: (fn: () => void): (() => void) => {
      pending = fn
      return () => {
        if (pending === fn) pending = null
      }
    },
    fire: (): void => {
      const fn = pending
      pending = null
      if (fn) fn()
    },
    hasPending: (): boolean => pending !== null,
  }
}

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 与 chat-view/commands.ts HERMES_MODE_LABEL 同款文案（Notice 断言用）。 */
const MODE_LABELS: Record<string, string> = {
  default: '默认（逐次询问）',
  accept_edits: '自动（编辑放行）',
  dont_ask: '免询（全部放行）',
}

const textChunk = (text: string): HermesSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})

function makeInput(
  hub: FakeHub,
  overrides: Partial<RunHermesTurnInput> = {},
): RunHermesTurnInput {
  const sched = makeScheduler()
  return {
    hub,
    hubConfig: { command: 'hermes', cwd: '/vault' },
    cfg: { approvalMode: 'default', model: '', timeoutMs: 600000 },
    sessionId: null,
    projectSessionId: null,
    getOverrides: () => ({}),
    userContent: '干活',
    historyWindow: [],
    memory: null,
    abortSignal: new AbortController().signal,
    onBlocks: jest.fn(),
    onSessionBound: jest.fn(),
    onProjectSessionBound: jest.fn(),
    modeLabel: (id) => MODE_LABELS[id] ?? id,
    scheduleFrame: sched.schedule,
    ...overrides,
  }
}

const lastBlocks = (input: RunHermesTurnInput): UiBlock[] => {
  const calls = (input.onBlocks as jest.Mock).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as UiBlock[]
}

const textOf = (blocks: UiBlock[]): string =>
  blocks
    .filter((b) => b.kind === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')

/* ── 会话解析 ───────────────────────────────────────────────────────── */

describe('runHermesTurn：会话解析（load→失败降级 new）', () => {
  it('无绑定 → 创建项目会话 + fork，onProjectSessionBound 和 onSessionBound 各回传', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub)
    const result = await runHermesTurn(input)

    expect(hub.loadSession).not.toHaveBeenCalled()
    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
    expect(input.onProjectSessionBound).toHaveBeenCalledWith('sess-new')
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-forked')
    expect(result.sessionId).toBe('sess-forked')
    expect(result.error).toBeNull()
  })

  it('有绑定且 load 成功 → 复用会话，不 fork、不回传绑定', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(true)
    const input = makeInput(hub, { sessionId: 'sess-old' })
    const result = await runHermesTurn(input)

    expect(hub.loadSession).toHaveBeenCalledWith(
      input.hubConfig,
      'sess-old',
    )
    expect(hub.newSession).not.toHaveBeenCalled()
    expect(hub.forkSession).not.toHaveBeenCalled()
    expect(input.onSessionBound).not.toHaveBeenCalled()
    expect(result.sessionId).toBe('sess-old')
    // prompt 用绑定会话。
    expect(hub.prompt.mock.calls[0][1]).toBe('sess-old')
  })

  it('已确认会话（shouldSkipLoad=true）→ 跳过每轮 load 直接 prompt（省 ~1s）', async () => {
    const hub = makeFakeHub()
    hub.shouldSkipLoad.mockReturnValue(true)
    const input = makeInput(hub, { sessionId: 'sess-confirmed' })
    const result = await runHermesTurn(input)

    expect(hub.loadSession).not.toHaveBeenCalled()
    expect(hub.newSession).not.toHaveBeenCalled()
    expect(hub.forkSession).not.toHaveBeenCalled()
    expect(result.sessionId).toBe('sess-confirmed')
    expect(hub.prompt.mock.calls[0][1]).toBe('sess-confirmed')
    expect(result.error).toBeNull()
  })

  it('shouldSkipLoad=false 时仍走 load（连接重建后恢复完整语义）', async () => {
    const hub = makeFakeHub()
    hub.shouldSkipLoad.mockReturnValue(false)
    hub.loadSession.mockResolvedValue(true)
    const input = makeInput(hub, { sessionId: 'sess-epoch-old' })
    const result = await runHermesTurn(input)

    expect(hub.loadSession).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toBe('sess-epoch-old')
  })

  it('有绑定但 load 返回 false → 重建项目 + fork，onProjectSessionBound 和 onSessionBound 各回传', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(false)
    const input = makeInput(hub, { sessionId: 'sess-forgotten' })
    const result = await runHermesTurn(input)

    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
    expect(input.onProjectSessionBound).toHaveBeenCalledWith('sess-new')
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-forked')
    expect(result.sessionId).toBe('sess-forked')
  })

  it('load reject（JSON-RPC 错误）→ 同样重建项目 + fork', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockRejectedValue(new Error('session not found'))
    const input = makeInput(hub, { sessionId: 'sess-gone' })
    const result = await runHermesTurn(input)

    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toBe('sess-forked')
    // load 失败不是轮次错误——不落成错误文案。
    expect(result.error).toBeNull()
  })
})

/* ── 项目会话 fork ───────────────────────────────────────────────────── */

describe('runHermesTurn：项目会话 fork (#94)', () => {
  it('无 projectSessionId → 创建项目会话 + fork，onProjectSessionBound 和 onSessionBound 各回传', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub)
    const result = await runHermesTurn(input)

    expect(hub.loadSession).not.toHaveBeenCalled()
    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
    expect(input.onProjectSessionBound).toHaveBeenCalledWith('sess-new')
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-forked')
    expect(result.sessionId).toBe('sess-forked')
  })

  it('有 projectSessionId 且 load 成功 → 复用项目，fork 出新子会话', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(true)
    const input = makeInput(hub, { projectSessionId: 'proj-001' })
    const result = await runHermesTurn(input)

    expect(hub.loadSession).toHaveBeenCalledWith(input.hubConfig, 'proj-001')
    expect(hub.newSession).not.toHaveBeenCalled()
    expect(hub.forkSession).toHaveBeenCalledWith(input.hubConfig, 'proj-001')
    expect(input.onProjectSessionBound).toHaveBeenCalledWith('proj-001')
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-forked')
    expect(result.sessionId).toBe('sess-forked')
  })

  it('有 projectSessionId 但 load 失败 → 重建项目 + fork', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(false)
    const input = makeInput(hub, { projectSessionId: 'proj-001' })
    const result = await runHermesTurn(input)

    expect(hub.loadSession).toHaveBeenCalledWith(input.hubConfig, 'proj-001')
    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
    expect(input.onProjectSessionBound).toHaveBeenCalledWith('sess-new')
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-forked')
    expect(result.sessionId).toBe('sess-forked')
  })

  it('getOrCreateProjectSession：同一 cwd 并发调用共享同一 promise（预热与发送竞态）', async () => {
    const hub = makeFakeHub()
    // 模拟 hermes 侧 session/new 慢（数秒）——并发第二个调用必须等待复用。
    let resolveNew!: (v: { sessionId: string }) => void
    hub.newSession.mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveNew = resolve
        }),
    )
    const cfg = { command: 'hermes', cwd: '/vault' }
    const p1 = getOrCreateProjectSession(hub, cfg, null)
    const p2 = getOrCreateProjectSession(hub, cfg, null) // 并发，同一 cwd

    expect(hub.newSession).toHaveBeenCalledTimes(1) // 锁生效——无双创建
    resolveNew({ sessionId: 'proj-1' })
    await expect(p1).resolves.toBe('proj-1')
    await expect(p2).resolves.toBe('proj-1') // 共享同一结果
    expect(hub.newSession).toHaveBeenCalledTimes(1)
  })

  it('getOrCreateProjectSession：不同 cwd 并行各自创建', async () => {
    const hub = makeFakeHub()
    const [a, b] = await Promise.all([
      getOrCreateProjectSession(hub, { command: 'hermes', cwd: '/vault-a' }, null),
      getOrCreateProjectSession(hub, { command: 'hermes', cwd: '/vault-b' }, null),
    ])
    expect(hub.newSession).toHaveBeenCalledTimes(2)
    expect(a).toBe('sess-new')
    expect(b).toBe('sess-new')
  })

  it('getOrCreateProjectSession：锁释放后新调用重新走 load 流程', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(true)
    const cfg = { command: 'hermes', cwd: '/vault' }
    await getOrCreateProjectSession(hub, cfg, null) // 第一次：new
    const id = await getOrCreateProjectSession(hub, cfg, 'proj-9') // 第二次：load 复用
    expect(id).toBe('proj-9')
    expect(hub.loadSession).toHaveBeenCalledWith(cfg, 'proj-9')
    expect(hub.newSession).toHaveBeenCalledTimes(1)
  })

  it('预热预备的 fork 子会话 → 直接消费，跳过项目会话与 fork（省 ~2s）', async () => {
    const hub = makeFakeHub()
    hub.takeReadyFork.mockReturnValue('sess-ready')
    const input = makeInput(hub)
    const result = await runHermesTurn(input)

    expect(hub.takeReadyFork).toHaveBeenCalledTimes(1)
    expect(hub.newSession).not.toHaveBeenCalled()
    expect(hub.forkSession).not.toHaveBeenCalled()
    expect(input.onProjectSessionBound).not.toHaveBeenCalled()
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-ready')
    expect(result.sessionId).toBe('sess-ready')
    expect(hub.setMode).toHaveBeenCalled() // 仍走每轮幂等 set_mode
  })

  it('预备 fork 被消费后（取走即空）→ 下一个对话走正常 fork 路径', async () => {
    const hub = makeFakeHub()
    hub.takeReadyFork.mockReturnValueOnce('sess-ready').mockReturnValue(null)

    const first = await runHermesTurn(makeInput(hub))
    expect(first.sessionId).toBe('sess-ready')
    expect(hub.newSession).not.toHaveBeenCalled()

    const second = await runHermesTurn(makeInput(hub))
    expect(second.sessionId).toBe('sess-forked')
    expect(hub.newSession).toHaveBeenCalledTimes(1) // 正常项目会话 + fork
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
  })
})

/* ── 每轮幂等 set_mode/set_model ────────────────────────────────────── */

describe('runHermesTurn：每轮幂等 set_mode/set_model', () => {
  it('默认走设置值：setMode(approvalMode) 先于 prompt；model 为空不 setModel', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub)
    await runHermesTurn(input)

    expect(hub.setMode).toHaveBeenCalledTimes(1)
    expect(hub.setMode.mock.calls[0][2]).toBe('default')
    expect(hub.setModel).not.toHaveBeenCalled()
    expect(hub.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      hub.prompt.mock.invocationCallOrder[0],
    )
  })

  it('会话覆盖优先：overrides 的 mode/model 盖过设置值', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub, {
      cfg: { approvalMode: 'default', model: 'cfg-model', timeoutMs: 600000 },
      getOverrides: () => ({ mode: 'dont_ask', model: 'ov-model' }),
    })
    await runHermesTurn(input)

    expect(hub.setMode.mock.calls[0][2]).toBe('dont_ask')
    expect(hub.setModel).toHaveBeenCalledWith(
      input.hubConfig,
      'sess-forked',
      'ov-model',
    )
  })

  it('设置 model 非空 → 每轮 setModel（trim 后传入）', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub, {
      cfg: { approvalMode: 'default', model: ' provider:model ', timeoutMs: 600000 },
    })
    await runHermesTurn(input)
    expect(hub.setModel.mock.calls[0][2]).toBe('provider:model')
  })

  it('任务一 §1.1：set_mode 失败显式 Notice 且不阻断轮次', async () => {
    const notices: string[] = []
    const spy = jest
      .spyOn(obsidian, 'Notice')
      .mockImplementation(((msg?: string) => {
        notices.push(msg ?? '')
        return {}
      }) as never)
    try {
      const hub = makeFakeHub()
      hub.setMode.mockRejectedValue(new Error('rpc timeout'))
      const input = makeInput(hub)
      const result = await runHermesTurn(input)

      // 轮次不阻断：prompt 照常发出。
      expect(hub.prompt).toHaveBeenCalledTimes(1)
      expect(result.error).toBeNull()
      // 失败显式可见（含模式文案、原因与 /mode 重试指引）。
      const hit = notices.find(
        (n) => n.includes('审批模式') && n.includes('应用失败'),
      )
      expect(hit).toBeDefined()
      expect(hit).toContain('rpc timeout')
      expect(hit).toContain('/mode')
      expect(hit).toContain('默认（逐次询问）')
    } finally {
      spy.mockRestore()
    }
  })

  it('set_model 失败静默（hermes 用自身默认），轮次照常', async () => {
    const hub = makeFakeHub()
    hub.setModel.mockRejectedValue(new Error('boom'))
    const input = makeInput(hub, {
      cfg: { approvalMode: 'default', model: 'x:y', timeoutMs: 600000 },
    })
    const result = await runHermesTurn(input)
    expect(hub.prompt).toHaveBeenCalledTimes(1)
    expect(result.error).toBeNull()
  })
})

/* ── 墙钟超时与 abort ───────────────────────────────────────────────── */

describe('runHermesTurn：墙钟超时与 abort', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** 挂起 prompt 直到用例手动收尾。 */
  function hangPrompt(hub: FakeHub): { finish: (r: PromptResult) => void } {
    let finish!: (r: PromptResult) => void
    hub.prompt.mockImplementation(
      () =>
        new Promise<PromptResult>((resolve) => {
          finish = resolve
        }),
    )
    return { finish: (r) => finish(r) }
  }

  it('超时 → 先 cancel；prompt 已 settle 时 8s 后不 dispose（settle=连接健康，不误杀共享 hub）', async () => {
    const hub = makeFakeHub()
    const { finish } = hangPrompt(hub)
    const input = makeInput(hub, {
      cfg: { approvalMode: 'default', model: '', timeoutMs: 1000 },
    })
    const pending = runHermesTurn(input)
    await flushMicro() // 走到 prompt 挂起

    jest.advanceTimersByTime(1000)
    expect(hub.cancel).toHaveBeenCalledWith('sess-forked')

    finish({ stopReason: 'cancelled' })
    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(textOf(lastBlocks(input))).toContain('Hermes 本轮超时')

    // prompt 已 settle（cancel 被 hermes 正常响应、连接健康）→ 8s 宽限期
    // 过后不得 dispose：共享 hub 上可能还有其他会话的在途轮（评审修复 2）。
    jest.advanceTimersByTime(8000)
    expect(hub.dispose).not.toHaveBeenCalled()
  })

  it('超时且 prompt 未 settle → cancel 后 8s 强制 dispose（hermes 失联兜底）', async () => {
    const hub = makeFakeHub()
    hangPrompt(hub) // prompt 永不收尾，模拟 hermes 对 cancel 无响应
    const input = makeInput(hub, {
      cfg: { approvalMode: 'default', model: '', timeoutMs: 1000 },
    })
    void runHermesTurn(input)
    await flushMicro() // 走到 prompt 挂起

    jest.advanceTimersByTime(1000)
    expect(hub.cancel).toHaveBeenCalledWith('sess-forked')
    expect(hub.dispose).not.toHaveBeenCalled()

    // 宽限期 8s 内 prompt 仍未 settle → 强制断连重建。
    jest.advanceTimersByTime(8000)
    expect(hub.dispose).toHaveBeenCalledTimes(1)
  })

  it('timeoutMs<=0 → 用 10 分钟默认墙钟', async () => {
    const hub = makeFakeHub()
    const { finish } = hangPrompt(hub)
    const input = makeInput(hub, {
      cfg: { approvalMode: 'default', model: '', timeoutMs: 0 },
    })
    const pending = runHermesTurn(input)
    await flushMicro()

    jest.advanceTimersByTime(599_999)
    expect(hub.cancel).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(hub.cancel).toHaveBeenCalled()

    finish({ stopReason: 'cancelled' })
    const result = await pending
    expect(textOf(lastBlocks(input))).toContain('上限 10 分钟')
    expect(result.timedOut).toBe(true)
  })

  it('abort → session/cancel（停止按钮语义）', async () => {
    const hub = makeFakeHub()
    const { finish } = hangPrompt(hub)
    const controller = new AbortController()
    const input = makeInput(hub, { abortSignal: controller.signal })
    const pending = runHermesTurn(input)
    await flushMicro()

    controller.abort()
    expect(hub.cancel).toHaveBeenCalledWith('sess-forked')

    finish({ stopReason: 'cancelled' })
    const result = await pending
    expect(result.stopReason).toBe('cancelled')
  })

  it('abort 落在 newSession 挂起中 → 停止：不发 prompt（解析阶段不再静默吞掉）', async () => {
    const hub = makeFakeHub()
    let finishNew!: (r: { sessionId: string }) => void
    hub.newSession.mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishNew = resolve
        }),
    )
    const controller = new AbortController()
    const input = makeInput(hub, { abortSignal: controller.signal })
    const pending = runHermesTurn(input)
    await flushMicro() // 走到 newSession 挂起

    // 会话还没解析出来，cancel 通知无处发（守卫）——但停止必须生效。
    controller.abort()
    expect(hub.cancel).not.toHaveBeenCalled()
    await flushMicro()
    expect(hub.prompt).not.toHaveBeenCalled()

    finishNew({ sessionId: 'sess-slow' })
    const result = await pending
    expect(result.stopReason).toBe('cancelled')
    expect(result.sessionId).toBe('')
    expect(hub.prompt).not.toHaveBeenCalled()
    expect(textOf(lastBlocks(input))).toContain('已停止')
  })

  it('abort 落在 setMode 挂起中 → 停止：不发 prompt', async () => {
    const hub = makeFakeHub()
    let finishMode!: () => void
    hub.setMode.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishMode = resolve
        }),
    )
    const controller = new AbortController()
    const input = makeInput(hub, { abortSignal: controller.signal })
    const pending = runHermesTurn(input)
    await flushMicro() // 走到 setMode 挂起（会话已解析）

    controller.abort()
    expect(hub.cancel).toHaveBeenCalledWith('sess-forked')

    finishMode()
    const result = await pending
    expect(result.stopReason).toBe('cancelled')
    expect(hub.prompt).not.toHaveBeenCalled()
    expect(textOf(lastBlocks(input))).toContain('已停止')
  })

  it('abort 后 hermes 对 cancel 无响应 → 8s 强制 dispose；强断以「已停止」收尾不报错', async () => {
    const hub = makeFakeHub()
    let rejectPrompt!: (e: Error) => void
    hub.prompt.mockImplementation(
      () =>
        new Promise<PromptResult>((_resolve, reject) => {
          rejectPrompt = reject
        }),
    )
    const controller = new AbortController()
    const input = makeInput(hub, { abortSignal: controller.signal })
    const pending = runHermesTurn(input)
    await flushMicro()

    controller.abort()
    expect(hub.cancel).toHaveBeenCalledWith('sess-forked')
    expect(hub.dispose).not.toHaveBeenCalled()

    // 8s 兜底：prompt 未 settle → 强制断连（不等 10 分钟墙钟）。
    jest.advanceTimersByTime(8000)
    expect(hub.dispose).toHaveBeenCalledTimes(1)

    // 强断导致在途请求 reject（真实连接关闭语义）→ catch 的 aborted 分支：
    // 用户主动停止不是故障，以「已停止」收尾、不弹错误文案。
    rejectPrompt(new Error('connection closed'))
    const result = await pending
    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toBeNull()
    expect(textOf(lastBlocks(input))).toContain('已停止')
  })
})

/* ── 新建会话首轮包裹 ───────────────────────────────────────────────── */

describe('runHermesTurn：新建会话首轮人设+记忆+实录包裹', () => {
  const HISTORY: UiMessage[] = [
    { id: 'u1', role: 'user', content: '上一轮问题' },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: '上一轮回答' }],
    },
  ]

  it('新会话 → prompt 带人设、记忆快照与窗口实录', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub, {
      userContent: '本轮任务',
      historyWindow: HISTORY,
      persona: '我是人格 A',
      memory: { user: ['用户喜欢简洁'], memory: ['记忆条目一'] },
    })
    await runHermesTurn(input)

    const promptText = hub.prompt.mock.calls[0][2] as string
    expect(promptText).toContain('我是人格 A')
    expect(promptText).toContain('【用户画像】')
    expect(promptText).toContain('用户喜欢简洁')
    expect(promptText).toContain('【长期记忆】')
    expect(promptText).toContain('记忆条目一')
    expect(promptText).toContain('用户：上一轮问题')
    expect(promptText).toContain('助手：上一轮回答')
    expect(promptText).toContain('本轮任务')
  })

  it('续会话（load 成功）→ prompt 原样直发，不包裹', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(true)
    const input = makeInput(hub, {
      sessionId: 'sess-old',
      userContent: '本轮任务',
      historyWindow: HISTORY,
      persona: '我是人格 A',
      memory: { user: ['x'], memory: ['y'] },
    })
    await runHermesTurn(input)
    expect(hub.prompt.mock.calls[0][2]).toBe('本轮任务')
  })

  it('新会话但以 `/` 开头（hermes 原生命令）→ 跳过包裹原样发送', async () => {
    const hub = makeFakeHub()
    const input = makeInput(hub, {
      userContent: '/compact',
      historyWindow: HISTORY,
      persona: '我是人格 A',
    })
    await runHermesTurn(input)
    expect(hub.prompt.mock.calls[0][2]).toBe('/compact')
  })
})

/* ── 分支对话：首轮从主干会话 fork（补刀·六十） ────────────────── */

describe('runHermesTurn：分支对话首轮 fork 主干会话（补刀·六十）', () => {
  const HISTORY: UiMessage[] = [
    { id: 'u1', role: 'user', content: '主干上一轮问题' },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: '主干上一轮回答' }],
    },
  ]

  it('分支首轮 → 从主干会话 fork（不走项目 fork），首轮不包裹，标记一次性消费', async () => {
    const hub = makeFakeHub()
    hub.forkSession.mockResolvedValue({ sessionId: 'sess-branch' })
    const consumed = jest.fn()
    const input = makeInput(hub, {
      forkSourceSessionId: 'sess-main',
      onForkSourceConsumed: consumed,
      userContent: '分支后继续',
      historyWindow: HISTORY,
      persona: '我是人格 A',
      memory: { user: ['x'], memory: ['y'] },
    })
    const result = await runHermesTurn(input)

    // fork 源 = 主干会话（非项目会话）；项目 fork 路径未触及。
    expect(hub.forkSession).toHaveBeenCalledTimes(1)
    expect(hub.forkSession).toHaveBeenCalledWith(
      expect.anything(),
      'sess-main',
    )
    expect(hub.newSession).not.toHaveBeenCalled()
    expect(hub.takeReadyFork).not.toHaveBeenCalled()
    expect(input.onProjectSessionBound).not.toHaveBeenCalled()

    // 分支会话绑定 + 标记消费（后续轮次不重复 fork）。
    expect(input.onSessionBound).toHaveBeenCalledWith('sess-branch')
    expect(consumed).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toBe('sess-branch')

    // 上下文已由 hermes 侧 fork 携带 → 首轮原样直发，不重复注入窗口实录。
    expect(hub.prompt.mock.calls[0][1]).toBe('sess-branch')
    expect(hub.prompt.mock.calls[0][2]).toBe('分支后继续')
  })

  it('fork 源失效（reject）→ 静默降级项目 fork 路径，首轮包裹重建连续性', async () => {
    const hub = makeFakeHub()
    hub.forkSession.mockRejectedValueOnce(new Error('session not found'))
    const consumed = jest.fn()
    const input = makeInput(hub, {
      forkSourceSessionId: 'sess-gone',
      onForkSourceConsumed: consumed,
      userContent: '分支后继续',
      historyWindow: HISTORY,
      persona: '我是人格 A',
    })
    const result = await runHermesTurn(input)

    // 第一次 fork（源）失败后走项目路径：newSession + 第二次 fork。
    expect(hub.forkSession).toHaveBeenCalledTimes(2)
    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(consumed).toHaveBeenCalledTimes(1) // 失败也消费，不残留重试
    expect(result.sessionId).toBe('sess-forked') // 项目 fork 出的新会话

    // 降级路径 = 新会话语义：首轮带窗口实录重建连续性。
    const promptText = hub.prompt.mock.calls[0][2] as string
    expect(promptText).toContain('我是人格 A')
    expect(promptText).toContain('主干上一轮问题')
    expect(promptText).toContain('分支后继续')
  })
})

/* ── 帧消费：rAF 合并交付 ───────────────────────────────────────────── */

describe('runHermesTurn：帧消费 rAF 合并交付', () => {
  /** 挂起 prompt 并暴露 onUpdate 帧注入口。 */
  function scriptedPrompt(hub: FakeHub): {
    emit: (u: HermesSessionUpdate) => void
    finish: (r: PromptResult) => void
  } {
    let emit!: (u: HermesSessionUpdate) => void
    let finish!: (r: PromptResult) => void
    hub.prompt.mockImplementation(
      (
        _cfg: unknown,
        _sid: string,
        _text: string,
        onUpdate: (u: HermesSessionUpdate) => void,
      ) => {
        emit = onUpdate
        return new Promise<PromptResult>((resolve) => {
          finish = resolve
        })
      },
    )
    return {
      emit: (u) => emit(u),
      finish: (r) => finish(r),
    }
  }

  it('多帧合并为一次 onBlocks：同帧内连到 3 帧只交付一次', async () => {
    const hub = makeFakeHub()
    const script = scriptedPrompt(hub)
    const sched = makeScheduler()
    const input = makeInput(hub, { scheduleFrame: sched.schedule })
    const pending = runHermesTurn(input)
    await flushMicro()

    // 占位文案立即交付（1 次）。
    const onBlocks = input.onBlocks as jest.Mock
    expect(onBlocks).toHaveBeenCalledTimes(1)
    expect(textOf(onBlocks.mock.calls[0][0])).toContain('正在连接本机 Hermes')

    // 连续 3 帧：只排队，不逐帧交付。
    script.emit(textChunk('甲'))
    script.emit(textChunk('乙'))
    script.emit(textChunk('丙'))
    expect(onBlocks).toHaveBeenCalledTimes(1)
    expect(sched.hasPending()).toBe(true)

    // 一次 rAF → 一次交付（3 帧合并）。
    sched.fire()
    expect(onBlocks).toHaveBeenCalledTimes(2)
    expect(textOf(onBlocks.mock.calls[1][0])).toBe('甲乙丙')

    script.finish({ stopReason: 'end_turn' })
    const result = await pending
    // 轮末同步冲刷终态（不依赖 rAF）。
    expect(onBlocks).toHaveBeenCalledTimes(3)
    expect(textOf(lastBlocks(input))).toBe('甲乙丙')
    expect(result.gotContent).toBe(true)
    expect(sched.hasPending()).toBe(false)
  })

  it('轮末思考兜底：残留 thinking 固化成「思考」卡随终态交付', async () => {
    const hub = makeFakeHub()
    const script = scriptedPrompt(hub)
    const input = makeInput(hub)
    const pending = runHermesTurn(input)
    await flushMicro()

    script.emit({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '这题得换个角度想' },
    })
    script.emit(textChunk('答案是 42。'))
    script.finish({ stopReason: 'end_turn' })
    await pending

    expect(lastBlocks(input)).toEqual([
      { kind: 'text', text: '答案是 42。' },
      {
        kind: 'tool',
        callId: HERMES_THOUGHT_CALL_ID,
        name: '思考',
        state: 'done',
        thinking: '这题得换个角度想',
      },
    ])
  })

  it('cancelled 且有内容 → 终态保留已得块；无内容 → （已停止）', async () => {
    const hub = makeFakeHub()
    const script = scriptedPrompt(hub)
    const input = makeInput(hub)
    const pending = runHermesTurn(input)
    await flushMicro()
    script.emit(textChunk('干了一半'))
    script.finish({ stopReason: 'cancelled' })
    await pending
    expect(textOf(lastBlocks(input))).toBe('干了一半')

    const hub2 = makeFakeHub()
    const script2 = scriptedPrompt(hub2)
    const input2 = makeInput(hub2)
    const pending2 = runHermesTurn(input2)
    await flushMicro()
    script2.finish({ stopReason: 'cancelled' })
    const result2 = await pending2
    expect(result2.gotContent).toBe(false)
    expect(textOf(lastBlocks(input2))).toBe('（已停止）')
  })

  it('正常结束但零帧 → （Hermes 未返回内容）', async () => {
    const hub = makeFakeHub()
    hub.prompt.mockResolvedValue({ stopReason: 'end_turn' })
    const input = makeInput(hub)
    const result = await runHermesTurn(input)
    expect(result.gotContent).toBe(false)
    expect(textOf(lastBlocks(input))).toBe('（Hermes 未返回内容）')
  })
})

/* ── 失败路径与 T3 凭据指引 ─────────────────────────────────────────── */

describe('runHermesTurn：失败路径与凭据指引（T3）', () => {
  it('newSession 失败 → 整段错误文案，永不 reject', async () => {
    const hub = makeFakeHub()
    hub.newSession.mockRejectedValue(new Error('未找到 Hermes 命令'))
    const input = makeInput(hub)
    const result = await runHermesTurn(input)

    expect(result.error).toBe('未找到 Hermes 命令')
    expect(input.onSessionBound).not.toHaveBeenCalled()
    const text = textOf(lastBlocks(input))
    expect(text).toContain('Hermes 会话出错：未找到 Hermes 命令')
    expect(text).toContain('设置 → Hermes → 检测')
  })

  it('报错像缺凭据 → 附配置指引（含 guidedEndpoint 设置项）', async () => {
    const hub = makeFakeHub()
    hub.prompt.mockRejectedValue(new Error('No provider API key configured'))
    const input = makeInput(hub, {
      cfg: {
        approvalMode: 'default',
        model: '',
        timeoutMs: 600000,
        guidedEndpoint: 'https://guide.example/setup',
      },
    })
    const result = await runHermesTurn(input)

    expect(result.error).toBeDefined()
    const text = textOf(lastBlocks(input))
    expect(text).toContain('【配置指引】')
    expect(text).toContain('https://guide.example/setup')
  })

  it('noCredentials 明确无凭据 → 即使报错无关凭据也附指引', async () => {
    const hub = makeFakeHub()
    hub.noCredentials = true
    hub.prompt.mockRejectedValue(new Error('weird crash'))
    const input = makeInput(hub)
    await runHermesTurn(input)
    expect(textOf(lastBlocks(input))).toContain('【配置指引】')
  })

  it('普通错误且有凭据 → 不附指引', async () => {
    const hub = makeFakeHub()
    hub.prompt.mockRejectedValue(new Error('connection reset'))
    const input = makeInput(hub)
    await runHermesTurn(input)
    expect(textOf(lastBlocks(input))).not.toContain('【配置指引】')
  })
})
