// M2-T6 生命周期韧性：错误三分类（未安装/启动失败/运行中崩溃）、
// protocolVersion 不匹配告警、崩溃后自愈重连（旧连接失效 + 会话映射清理 +
// 新会话建立）。全部经 scripted fake 帧序列完成，绝不真起 hermes。

import { EventEmitter } from 'events'
import {
  AcpConnection,
  AcpConnectionError,
  ACP_PROTOCOL_VERSION,
  classifyConnectionFailure,
  protocolVersionWarning,
} from '../acpConnection'
import { HermesHub } from '../hermesHub'
import type { SpawnLike, LocalAgentChild } from '../../desktop/localAgent'

/* ── fake 子进程（与 acpConnection.test.ts 同款接缝） ─────────────────── */

interface FakeChild {
  proc: EventEmitter & {
    kill: jest.Mock
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (d: string) => boolean }
  }
  stdinWrites: string[]
  emitStdoutLine(obj: unknown): void
}

function makeFakeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild['proc']
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdinWrites: string[] = []
  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write: (d: string) => {
      stdinWrites.push(d)
      return true
    },
  }
  proc.kill = jest.fn(() => true)
  return {
    proc,
    stdinWrites,
    emitStdoutLine: (obj) =>
      stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')),
  }
}

const baseHandlers = () => ({
  onNotification: jest.fn(),
  onServerRequest: jest.fn(),
  onExit: jest.fn(),
})

/** 解析某子进程 stdin 上最后一个指定 method 的请求帧 id。 */
function lastRequestId(fake: FakeChild, method: string): number {
  for (let i = fake.stdinWrites.length - 1; i >= 0; i--) {
    const frame = JSON.parse(fake.stdinWrites[i]) as {
      id?: number
      method?: string
    }
    if (frame.method === method && typeof frame.id === 'number') return frame.id
  }
  throw new Error(`no ${method} frame written`)
}

/** 回 initialize 成功帧（可指定协议版本与通告的 authMethods，M2-T3）。 */
function answerInitialize(
  fake: FakeChild,
  protocolVersion: number = ACP_PROTOCOL_VERSION,
  authMethods?: unknown,
): void {
  fake.emitStdoutLine({
    jsonrpc: '2.0',
    id: lastRequestId(fake, 'initialize'),
    result: {
      protocolVersion,
      agentInfo: { name: 'hermes-agent', version: '0.20.0' },
      ...(authMethods !== undefined ? { authMethods } : {}),
    },
  })
}

/** 冲刷微任务队列（connect→ensureConnected→请求写出要跳多跳 promise 链）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/* ── 纯函数：三分类映射与协议版本比对 ─────────────────────────────────── */

describe('classifyConnectionFailure（纯映射）', () => {
  it('launch 阶段 → not_installed，含安装/设置排查指引与原始错误', () => {
    const err = classifyConnectionFailure({
      phase: 'launch',
      detail: 'spawn hermes ENOENT',
    })
    expect(err).toBeInstanceOf(AcpConnectionError)
    expect(err.kind).toBe('not_installed')
    expect(err.message).toContain('未找到 Hermes 命令')
    expect(err.message).toContain('设置 → Hermes')
    expect(err.message).toContain('spawn hermes ENOENT')
  })

  it('handshake 阶段 → launch_failed，带退出码与终端自查指引', () => {
    const err = classifyConnectionFailure({ phase: 'handshake', exitCode: 2 })
    expect(err.kind).toBe('launch_failed')
    expect(err.message).toContain('握手完成前就退出')
    expect(err.message).toContain('退出码 2')
    expect(err.message).toContain('hermes acp')
  })

  it('running 阶段 → runtime_crash，提示自动重连与重新发送', () => {
    const err = classifyConnectionFailure({ phase: 'running', exitCode: 137 })
    expect(err.kind).toBe('runtime_crash')
    expect(err.message).toContain('运行中崩溃')
    expect(err.message).toContain('退出码 137')
    expect(err.message).toContain('自动重连')
  })

  it('无退出码（被信号杀死）给「退出码未知」提示', () => {
    const err = classifyConnectionFailure({ phase: 'running', exitCode: null })
    expect(err.message).toContain('退出码未知')
  })
})

describe('protocolVersionWarning（纯映射）', () => {
  it('版本匹配返回空串', () => {
    expect(protocolVersionWarning(ACP_PROTOCOL_VERSION)).toBe('')
  })

  it('版本不匹配给显式告警（hermes 升级是最常见原因）', () => {
    const warn = protocolVersionWarning(ACP_PROTOCOL_VERSION + 1)
    expect(warn).toContain('协议版本不匹配')
    expect(warn).toContain('hermes 升级')
  })

  it('未返回版本号也告警', () => {
    expect(protocolVersionWarning(undefined)).toContain('未知版本')
  })
})

/* ── 连接层：三分类各自的触发路径 ─────────────────────────────────────── */

describe('AcpConnection 错误三分类（scripted fake）', () => {
  it('PATH 回退链全部 ENOENT → not_installed', async () => {
    const fakes: FakeChild[] = []
    const spawn = ((cmd: string) => {
      const fake = makeFakeChild()
      fakes.push(fake)
      setTimeout(
        () => fake.proc.emit('error', new Error(`spawn ${cmd} ENOENT`)),
        1,
      )
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike

    let caught: unknown
    try {
      await AcpConnection.connect({
        command: 'hermes',
        cwd: '/vault',
        handlers: baseHandlers(),
        spawnImpl: spawn,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AcpConnectionError)
    expect((caught as AcpConnectionError).kind).toBe('not_installed')
    expect((caught as Error).message).toContain('未找到 Hermes 命令')
    // 回退链确实逐一试过（裸命令 + 4 个常见安装路径）。
    expect(fakes.length).toBe(5)
  })

  it('initialize 握手前进程退出 → launch_failed（不触发 PATH 回退）', async () => {
    const fakes: FakeChild[] = []
    const spawn = (() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      // 握手前非零退出——不是 ENOENT，不许进回退链。
      setTimeout(() => fake.proc.emit('close', 2), 1)
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike

    let caught: unknown
    try {
      await AcpConnection.connect({
        command: 'hermes',
        cwd: '/vault',
        handlers: baseHandlers(),
        spawnImpl: spawn,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AcpConnectionError)
    expect((caught as AcpConnectionError).kind).toBe('launch_failed')
    expect((caught as Error).message).toContain('退出码 2')
    expect(fakes.length).toBe(1) // 只试了一次，未回退
  })

  it('prompt 期间 stdio close/非零退出 → runtime_crash 且连接失效', async () => {
    const fakes: FakeChild[] = []
    const spawn = (() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      fake.proc.stdin.write = (d: string): boolean => {
        fake.stdinWrites.push(d)
        try {
          const frame = JSON.parse(d.trim()) as { id?: number; method?: string }
          if (frame.method === 'initialize' && typeof frame.id === 'number') {
            setTimeout(() => answerInitialize(fake), 1)
          }
        } catch {
          /* not a frame */
        }
        return true
      }
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike
    const handlers = baseHandlers()

    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers,
      spawnImpl: spawn,
    })
    const pending = conn.request('session/prompt', {}, 0) // 无超时 = 真 prompt 轮
    fakes[0].proc.emit('close', 137)
    let caught: unknown
    try {
      await pending
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AcpConnectionError)
    expect((caught as AcpConnectionError).kind).toBe('runtime_crash')
    expect((caught as Error).message).toContain('退出码 137')
    expect(conn.alive).toBe(false)
    expect(handlers.onExit).toHaveBeenCalledWith(137)
  })

  it('protocolVersion 不匹配 → 告警但连接保留', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const fakes: FakeChild[] = []
    const spawn = (() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      fake.proc.stdin.write = (d: string): boolean => {
        fake.stdinWrites.push(d)
        try {
          const frame = JSON.parse(d.trim()) as { id?: number; method?: string }
          if (frame.method === 'initialize' && typeof frame.id === 'number') {
            // hermes 返回它自己的协议版本（升级后的新版本）。
            setTimeout(
              () => answerInitialize(fake, ACP_PROTOCOL_VERSION + 1),
              1,
            )
          }
        } catch {
          /* not a frame */
        }
        return true
      }
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike

    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: spawn,
    })
    expect(conn.alive).toBe(true) // 只告警，不断连
    expect(conn.protocolWarning).toContain('协议版本不匹配')
    expect(conn.protocolWarning).toContain('hermes 升级')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    conn.dispose()
  })

  it('protocolVersion 匹配 → 无告警', async () => {
    const fakes: FakeChild[] = []
    const spawn = (() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      fake.proc.stdin.write = (d: string): boolean => {
        fake.stdinWrites.push(d)
        try {
          const frame = JSON.parse(d.trim()) as { id?: number; method?: string }
          if (frame.method === 'initialize' && typeof frame.id === 'number') {
            setTimeout(() => answerInitialize(fake), 1)
          }
        } catch {
          /* not a frame */
        }
        return true
      }
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike

    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: spawn,
    })
    expect(conn.protocolWarning).toBe('')
    conn.dispose()
  })
})

/* ── HermesHub：崩溃自愈重连 ──────────────────────────────────────────── */

describe('HermesHub 崩溃自愈（scripted fake）', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** 手动驱动的 spawn：不自动回帧，用例自己喂 initialize/响应。 */
  function makeManualSpawn(): { spawn: SpawnLike; fakes: FakeChild[] } {
    const fakes: FakeChild[] = []
    const spawn = (() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike
    return { spawn, fakes }
  }

  const config = (spawn: SpawnLike) => ({
    command: 'hermes',
    cwd: '/vault',
    spawnImpl: spawn,
  })

  it('崩溃后旧连接失效、会话映射清理、下一次发送自动重连并建立新会话', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    // ── 第一段：新会话建立成功 ──
    const p1 = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush() // 让 connect 收尾，随后发 session/new
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p1).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.connected).toBe(true)

    // ── 第二段：prompt 在途时进程崩溃（含一个未决审批请求）──
    const updates: unknown[] = []
    const promptP = hub.prompt(cfg, 's-1', 'hi', (u) => updates.push(u))
    await flush() // 让 session/prompt 帧真正写出（进入 pending）
    const permissionHandler = jest.fn()
    hub.setPermissionHandler(permissionHandler)
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 'perm-1' }, options: [] },
    })
    expect(permissionHandler).toHaveBeenCalledTimes(1) // 55s 兜底定时器已挂上
    c1.proc.emit('close', 1) // 运行中崩溃

    let caught: unknown
    try {
      await promptP
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AcpConnectionError)
    expect((caught as AcpConnectionError).kind).toBe('runtime_crash')
    expect(hub.connected).toBe(false)

    // 会话映射已清：崩溃后 stray update 不再路由到旧 onUpdate。
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      },
    })
    expect(updates).toHaveLength(0)

    // 审批兜底定时器已清：即使时间推进超过 55s，也不会向（新）连接回旧 requestId。
    jest.advanceTimersByTime(60_000)

    // ── 第三段：下一次发送经 ensureConnected 自动重连，新会话建立成功 ──
    const p2 = hub.newSession(cfg)
    expect(fakes.length).toBe(2) // 起了第二个进程 = 自动重连
    const c2 = fakes[1]
    answerInitialize(c2)
    await flush()
    c2.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c2, 'session/new'),
      result: { sessionId: 's-2' },
    })
    await expect(p2).resolves.toEqual({ sessionId: 's-2' })
    expect(hub.connected).toBe(true)
    // 旧审批定时器确实被清掉：新连接的 stdin 只有 initialize + session/new。
    expect(c2.stdinWrites).toHaveLength(2)

    hub.setPermissionHandler(null)
    hub.dispose()
  })

  it('重连后 session/load 失败按既有降级路径返回失败（调用方转 session/new）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p1 = hub.loadSession(cfg, 'old-session')
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()
    // hermes 不认识这个会话（崩溃重启后 state.db 场景同理）→ JSON-RPC 错误。
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/load'),
      error: { code: -32000, message: 'session not found' },
    })
    // useAgent 侧 .catch(() => false) → session/new，既有降级路径不动。
    await expect(p1).rejects.toThrow('session not found')
    hub.dispose()
  })

  it('协议版本不匹配告警经 hub 透出', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1, ACP_PROTOCOL_VERSION + 2) // hermes 升级了新协议
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.protocolWarning).toContain('协议版本不匹配')
    expect(hub.connected).toBe(true) // 只告警不断连
    warnSpy.mockRestore()
    hub.dispose()
  })

  it('initialize 通告 authMethods 经连接与 hub 透出：只剩 hermes-setup = 无凭据（M2-T3）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.newSession(cfg)
    const c1 = fakes[0]
    // hermes 未配置任何 provider key 时 build_auth_methods() 的真实输出。
    answerInitialize(c1, ACP_PROTOCOL_VERSION, [
      {
        id: 'hermes-setup',
        name: 'Configure Hermes provider',
        type: 'terminal',
        args: ['--setup'],
      },
    ])
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.connected).toBe(true)
    expect(hub.noCredentials).toBe(true)
    expect(hub.authMethods).toHaveLength(1)
    expect(hub.authMethods[0].id).toBe('hermes-setup')
    hub.dispose()
    expect(hub.noCredentials).toBe(false) // 断连后回到未知态
  })

  it('authMethods 含 provider 运行时方法 → 有凭据；未通告字段 → 未知不误报（M2-T3）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1, ACP_PROTOCOL_VERSION, [
      { id: 'openrouter', name: 'openrouter runtime credentials' },
      { id: 'hermes-setup', type: 'terminal', args: ['--setup'] },
    ])
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.noCredentials).toBe(false)
    expect(hub.authMethods).toHaveLength(2)
    hub.dispose()

    // 老版 hermes：initialize 不带 authMethods 字段 → 未知 ≠ 无凭据。
    const p2 = hub.newSession(cfg)
    const c2 = fakes[1]
    answerInitialize(c2) // 无 authMethods
    await flush()
    c2.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c2, 'session/new'),
      result: { sessionId: 's-2' },
    })
    await expect(p2).resolves.toEqual({ sessionId: 's-2' })
    expect(hub.noCredentials).toBe(false)
    expect(hub.authMethods).toEqual([])
    hub.dispose()
  })

  /* ── M2-T4: available_commands_update 缓存（scripted fake 帧） ──────── */

  /** hermes 真实通告帧（session/new 响应后、首轮 prompt 前到达）。 */
  const commandsFrame = (sessionId: string, names: string[]) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: names.map((name) => ({
          name,
          description: `desc of ${name}`,
          ...(name === 'queue'
            ? { input: { kind: 'unstructured', hint: 'prompt to run next' } }
            : {}),
        })),
      },
    },
  })

  it('available_commands_update 无在途轮也落缓存：按 sessionId 缓存 + 订阅通知', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p1 = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p1).resolves.toEqual({ sessionId: 's-1' })

    // 未收到通告帧前 = 空数组（尚未同步，UI 用静态兜底清单垫底）。
    expect(hub.getAdvertisedCommands('s-1')).toEqual([])

    // 通告帧在首轮 prompt 之前到达（此刻没有 activeRouter）——hub 级缓存
    // 独立于在途轮路由，照样接得住并通知订阅者。
    let notified = 0
    const unsub = hub.subscribe(() => {
      notified += 1
    })
    c1.emitStdoutLine(commandsFrame('s-1', ['tools', 'queue', 'version']))
    const cached = hub.getAdvertisedCommands('s-1')
    expect(cached.map((c) => c.name)).toEqual(['tools', 'queue', 'version'])
    expect(cached.find((c) => c.name === 'queue')?.inputHint).toBe(
      'prompt to run next',
    )
    expect(cached.find((c) => c.name === 'tools')?.description).toBe(
      'desc of tools',
    )
    expect(notified).toBeGreaterThan(0)

    // 另一会话的通告只落自己的桶，不串。
    c1.emitStdoutLine(commandsFrame('s-2', ['context']))
    expect(hub.getAdvertisedCommands('s-2').map((c) => c.name)).toEqual([
      'context',
    ])
    expect(hub.getAdvertisedCommands('s-1').map((c) => c.name)).toEqual([
      'tools',
      'queue',
      'version',
    ])

    // 重复通告 = 覆盖（hermes 重发时以最新一帧为准）。
    c1.emitStdoutLine(commandsFrame('s-1', ['tools']))
    expect(hub.getAdvertisedCommands('s-1').map((c) => c.name)).toEqual(['tools'])
    unsub()
    hub.dispose()
  })

  it('断连作废：进程退出后通告命令缓存清空（与 sessionStates 同款生命周期）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p1 = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p1).resolves.toEqual({ sessionId: 's-1' })
    c1.emitStdoutLine(commandsFrame('s-1', ['tools', 'queue']))
    expect(hub.getAdvertisedCommands('s-1')).toHaveLength(2)

    // 进程崩溃（stdio close）→ handleConnectionLost 清场。
    c1.proc.emit('close', 0)
    expect(hub.connected).toBe(false)
    expect(hub.getAdvertisedCommands('s-1')).toEqual([])

    // 重连后新通告帧重建缓存（自愈语义：旧帧不残留）。
    const p2 = hub.newSession(cfg)
    const c2 = fakes[1]
    answerInitialize(c2)
    await flush()
    c2.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c2, 'session/new'),
      result: { sessionId: 's-3' },
    })
    await expect(p2).resolves.toEqual({ sessionId: 's-3' })
    expect(hub.getAdvertisedCommands('s-3')).toEqual([])
    c2.emitStdoutLine(commandsFrame('s-3', ['steer']))
    expect(hub.getAdvertisedCommands('s-3').map((c) => c.name)).toEqual(['steer'])
    hub.dispose()
  })
})

/* ── HermesHub 连接状态灯（补刀·五十九） ──────────────────────────────── */

describe('HermesHub 连接状态灯（补刀·五十九）', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** 手动驱动的 spawn：不自动回帧，用例自己喂 initialize/响应。 */
  function makeManualSpawn(): { spawn: SpawnLike; fakes: FakeChild[] } {
    const fakes: FakeChild[] = []
    const spawn = (() => {
      const fake = makeFakeChild()
      fakes.push(fake)
      return fake.proc as unknown as LocalAgentChild
    }) as SpawnLike
    return { spawn, fakes }
  }

  const config = (spawn: SpawnLike) => ({
    command: 'hermes',
    cwd: '/vault',
    spawnImpl: spawn,
  })

  it('成功路径：idle → connecting → ready，订阅者逐态收到广播', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const seen: string[] = []
    hub.subscribe(() => seen.push(hub.connState))
    expect(hub.connState).toBe('idle') // 初始未连接

    const p = hub.newSession(cfg)
    expect(hub.connState).toBe('connecting') // spawn 同步开始
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.connState).toBe('ready')
    // setConnState 相同值不广播（guard），但其他状态变更通知（会话清单缓存
    // 等）会让订阅者读到同一个 ready——UI 读到相同值不会重渲染，灯色序列
    // 只要求 灰→绿，全程无红无熄。
    expect(seen[0]).toBe('connecting')
    expect(seen[seen.length - 1]).toBe('ready')
    expect(seen).not.toContain('failed')
    expect(seen).not.toContain('idle')
    hub.dispose()
  })

  it('launch 失败（PATH 回退链全部 ENOENT）→ failed，不阻塞下一次重试', async () => {
    const spawn = ((cmd: string) => {
      throw new Error(`spawn ${cmd} ENOENT`)
    }) as SpawnLike
    const hub = new HermesHub()
    const cfg = config(spawn)

    await expect(hub.newSession(cfg)).rejects.toThrow('未找到 Hermes 命令')
    expect(hub.connState).toBe('failed') // 状态灯红
    expect(hub.connected).toBe(false)
    hub.dispose()
  })

  it('运行中进程退出 → failed（连接死亡），下一次发送自动重连回 ready', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p1 = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p1).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.connState).toBe('ready')

    c1.proc.emit('close', 0) // 进程退出（onExit 同步 → handleConnectionLost）
    expect(hub.connState).toBe('failed')
    expect(hub.connected).toBe(false)

    // 下一次发送自动重连：connecting → ready（自愈语义与状态灯联动）。
    const p2 = hub.newSession(cfg)
    expect(fakes.length).toBe(2)
    expect(hub.connState).toBe('connecting')
    const c2 = fakes[1]
    answerInitialize(c2)
    await flush()
    c2.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c2, 'session/new'),
      result: { sessionId: 's-2' },
    })
    await expect(p2).resolves.toEqual({ sessionId: 's-2' })
    expect(hub.connState).toBe('ready')
    hub.dispose()
  })

  it('dispose：就绪后主动断开 → idle；悬挂 connecting 时卸载 → 接管链终局仍 idle', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    // ── 就绪后断开：conn?.dispose() 同步触发 onExit→failed，随后被
    //    disposeConnection 尾部的 idle 覆盖，最终熄灭不留在红。
    const p1 = hub.newSession(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/new'),
      result: { sessionId: 's-1' },
    })
    await expect(p1).resolves.toEqual({ sessionId: 's-1' })
    expect(hub.connState).toBe('ready')
    hub.dispose()
    expect(hub.connState).toBe('idle')

    // ── 悬挂中卸载：disposeConnection 接管 connecting，settle 后 dispose
    //    新连接（onExit→failed），接管链终局强制回 idle。
    const p2 = hub.ensureConnected(cfg)
    expect(fakes.length).toBe(2)
    expect(hub.connState).toBe('connecting')
    hub.dispose()
    expect(hub.connState).toBe('idle')
    answerInitialize(fakes[1]) // 让 connect settle，接管链跑完
    await flush()
    expect(hub.connState).toBe('idle') // 终局仍 idle（不闪红）
    await expect(p2).resolves.toBeDefined()
  })
})
