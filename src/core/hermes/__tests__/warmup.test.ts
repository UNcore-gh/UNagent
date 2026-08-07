// Hermes 连接预热（2026-08-07 性能优化）：幂等、门控、失败静默可重试。
// 全部经 fake hub 验证，绝不真起 hermes 进程。

import { FileSystemAdapter, Platform } from 'obsidian'

import {
  buildHermesWarmupOptions,
  resetHermesWarmup,
  warmupHermesOnce,
  type HermesWarmupOptions,
  type HermesWarmupHub,
} from '../warmup'
import type { HermesSessionUpdate, PromptResult } from '../types'

interface FakeHub extends HermesWarmupHub {
  ensureConnected: jest.Mock
  loadSession: jest.Mock
  newSession: jest.Mock
  forkSession: jest.Mock
  setReadyFork: jest.Mock
}

function makeFakeHub(): FakeHub {
  return {
    ensureConnected: jest.fn(async () => ({ alive: true })),
    loadSession: jest.fn(async () => false),
    newSession: jest.fn(async () => ({ sessionId: 'sess-warm' })),
    forkSession: jest.fn(async () => ({ sessionId: 'sess-ready-fork' })),
    setReadyFork: jest.fn(),
    setMode: jest.fn(),
    setModel: jest.fn(),
    prompt: jest.fn(
      async (
        _cfg: unknown,
        _sid: string,
        _text: string,
        onUpdate: (u: HermesSessionUpdate) => void,
      ) => {
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
        })
        return { stopReason: 'end_turn' } as PromptResult
      },
    ),
    cancel: jest.fn(),
    dispose: jest.fn(),
    takeReadyFork: jest.fn(() => null),
    shouldSkipLoad: jest.fn(() => false),
    noCredentials: false,
  }
}

function makeOpts(hub: FakeHub, overrides: Partial<HermesWarmupOptions> = {}): HermesWarmupOptions {
  return {
    enabled: true,
    isMobile: false,
    cwd: '/vault',
    command: 'hermes',
    hub,
    projectSessionId: null,
    onProjectSessionBound: jest.fn(),
    ...overrides,
  }
}

/** 等待微任务队列排空（warmup 是 fire-and-forget）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('warmupHermesOnce', () => {
  beforeEach(() => {
    resetHermesWarmup()
  })

  it('幂等：连续多次触发只预热一次', async () => {
    const hub = makeFakeHub()
    const opts = makeOpts(hub)

    warmupHermesOnce(opts)
    warmupHermesOnce(opts)
    warmupHermesOnce(opts)
    await flush()

    expect(hub.ensureConnected).toHaveBeenCalledTimes(1)
    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(opts.onProjectSessionBound).toHaveBeenCalledWith('sess-warm')
    // 档 3：fork 预备子会话并存入 hub，首次发送直接消费。
    expect(hub.forkSession).toHaveBeenCalledWith(
      { command: 'hermes', cwd: '/vault' },
      'sess-warm',
    )
    expect(hub.setReadyFork).toHaveBeenCalledWith('sess-ready-fork')
  })

  it('门控：移动端 / 未启用 / 无本地路径均跳过', () => {
    const hub = makeFakeHub()
    warmupHermesOnce(makeOpts(hub, { isMobile: true }))
    warmupHermesOnce(makeOpts(hub, { enabled: false }))
    warmupHermesOnce(makeOpts(hub, { cwd: null }))
    expect(hub.ensureConnected).not.toHaveBeenCalled()
  })

  it('已有 projectSessionId → 走 load 复用而非 newSession', async () => {
    const hub = makeFakeHub()
    hub.loadSession.mockResolvedValue(true)
    const opts = makeOpts(hub, { projectSessionId: 'proj-warm' })

    warmupHermesOnce(opts)
    await flush()

    expect(hub.loadSession).toHaveBeenCalledWith(
      { command: 'hermes', cwd: '/vault' },
      'proj-warm',
    )
    expect(hub.newSession).not.toHaveBeenCalled()
    expect(opts.onProjectSessionBound).toHaveBeenCalledWith('proj-warm')
  })

  it('失败静默且可重试：ensureConnected 失败后再次触发重新预热', async () => {
    const hub = makeFakeHub()
    hub.ensureConnected.mockRejectedValueOnce(new Error('spawn ENOENT'))
    const opts = makeOpts(hub)

    warmupHermesOnce(opts) // 第一次：失败
    await flush()
    expect(hub.ensureConnected).toHaveBeenCalledTimes(1)
    expect(hub.newSession).not.toHaveBeenCalled()

    warmupHermesOnce(opts) // 第二次：重试成功
    await flush()
    expect(hub.ensureConnected).toHaveBeenCalledTimes(2)
    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(opts.onProjectSessionBound).toHaveBeenCalledWith('sess-warm')
  })

  it('并发调用与正式发送共享同一项目会话（锁内复用，无双创建）', async () => {
    const hub = makeFakeHub()
    let resolveNew!: (v: { sessionId: string }) => void
    hub.newSession.mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveNew = resolve
        }),
    )
    const opts = makeOpts(hub)

    warmupHermesOnce(opts)
    // 预热进行中模拟正式路径并发调用同一 cwd——等待并复用。
    const { getOrCreateProjectSession } = await import('../runHermesTurn')
    const sendPromise = getOrCreateProjectSession(
      hub,
      { command: 'hermes', cwd: '/vault' },
      null,
    )
    resolveNew({ sessionId: 'sess-shared' })
    await flush()
    await sendPromise

    expect(hub.newSession).toHaveBeenCalledTimes(1)
    expect(opts.onProjectSessionBound).toHaveBeenCalledWith('sess-shared')
  })
})

interface FakeHost {
  settings: {
    localAgent: {
      enabled: boolean
      command: string
      projectSessionId: string | null
    }
  }
  app: { vault: { adapter: unknown } }
  saveSettings: jest.Mock
}

function makeHost(overrides: {
  enabled?: boolean
  command?: string
  projectSessionId?: string | null
  adapter?: unknown
} = {}): FakeHost {
  const {
    enabled = true,
    command = '',
    projectSessionId = null,
    adapter = new FileSystemAdapter(),
  } = overrides
  return {
    settings: { localAgent: { enabled, command, projectSessionId } },
    app: { vault: { adapter } },
    saveSettings: jest.fn(),
  }
}

describe('buildHermesWarmupOptions', () => {
  afterEach(() => {
    Platform.isMobile = false
  })

  it('门控：未启用 / 移动端 / 非文件系统 vault 均返回 null', () => {
    expect(buildHermesWarmupOptions(makeHost({ enabled: false }))).toBeNull()
    Platform.isMobile = true
    expect(buildHermesWarmupOptions(makeHost())).toBeNull()
    expect(
      buildHermesWarmupOptions(makeHost({ adapter: {} })),
    ).toBeNull()
  })

  it('组装：默认命令 / cwd 取 getBasePath / projectSessionId 传递', () => {
    const host = makeHost({
      command: '  ', // 空白 → 回落默认 hermes
      projectSessionId: 'proj-boot',
    })
    const opts = buildHermesWarmupOptions(host)
    expect(opts).not.toBeNull()
    expect(opts?.enabled).toBe(true)
    expect(opts?.command).toBe('hermes')
    expect(opts?.cwd).toBe('/tmp/fake-vault')
    expect(opts?.projectSessionId).toBe('proj-boot')
    expect(opts?.isMobile).toBe(false)
  })

  it('组装：自定义命令保留 trim 结果', () => {
    const opts = buildHermesWarmupOptions(
      makeHost({ command: ' ~/.hermes/hermes-agent/venv/bin/hermes ' }),
    )
    expect(opts?.command).toBe('~/.hermes/hermes-agent/venv/bin/hermes')
  })

  it('onProjectSessionBound：新 id 写回 settings 并保存；相同 id 不重复写', () => {
    const host = makeHost()
    const opts = buildHermesWarmupOptions(host)
    expect(opts).not.toBeNull()
    opts?.onProjectSessionBound('proj-1')
    expect(host.settings.localAgent.projectSessionId).toBe('proj-1')
    expect(host.saveSettings).toHaveBeenCalledTimes(1)

    opts?.onProjectSessionBound('proj-1') // 相同 id：跳过写回
    expect(host.saveSettings).toHaveBeenCalledTimes(1)

    opts?.onProjectSessionBound('proj-2')
    expect(host.settings.localAgent.projectSessionId).toBe('proj-2')
    expect(host.saveSettings).toHaveBeenCalledTimes(2)
  })
})
