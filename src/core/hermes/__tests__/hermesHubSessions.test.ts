// 任务三：hub 会话级权限路由 + forgetSession + listSessions 翻页。
// 全部经 scripted fake 帧序列完成，绝不真起 hermes（写法对齐
// hermesLifecycle.test.ts 的接缝）。

import { EventEmitter } from 'events'
import { HermesHub } from '../hermesHub'
import type { ListSessionsResult } from '../types'
import type { SpawnLike, LocalAgentChild } from '../../desktop/localAgent'

/* ── fake 子进程（与 hermesLifecycle.test.ts 同款接缝） ─────────────── */

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

interface StdinFrame {
  jsonrpc?: string
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

function parseFrames(fake: FakeChild): StdinFrame[] {
  return fake.stdinWrites.map((w) => JSON.parse(w) as StdinFrame)
}

/** 某子进程 stdin 上所有指定 method 的请求帧（按写出顺序）。 */
function framesOf(fake: FakeChild, method: string): StdinFrame[] {
  return parseFrames(fake).filter(
    (f) => f.method === method && typeof f.id === 'number',
  )
}

function lastRequestId(fake: FakeChild, method: string): number {
  const frames = framesOf(fake, method)
  if (frames.length === 0) throw new Error(`no ${method} frame written`)
  return frames[frames.length - 1].id as number
}

/** 某反向请求 id 对应的应答帧（respondToServerRequest 写出，无 method）。 */
function responsesFor(fake: FakeChild, id: number): StdinFrame[] {
  return parseFrames(fake).filter(
    (f) => f.id === id && f.method === undefined && f.result !== undefined,
  )
}

function answerInitialize(fake: FakeChild): void {
  fake.emitStdoutLine({
    jsonrpc: '2.0',
    id: lastRequestId(fake, 'initialize'),
    result: {
      protocolVersion: 1,
      agentInfo: { name: 'hermes-agent', version: '0.20.0' },
    },
  })
}

/** session/request_permission 反向请求帧（带所属 sessionId）。 */
function permissionFrame(id: number, sessionId: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: `perm-${id}` },
      options: [
        { optionId: 'allow_once', kind: 'allow_once' },
        { optionId: 'reject_once', kind: 'reject_once' },
      ],
    },
  }
}

/** 冲刷微任务队列（connect→ensureConnected→请求写出要跳多跳 promise 链）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/* ── 测试主体 ─────────────────────────────────────────────────────────── */

describe('HermesHub 任务三（scripted fake）', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

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

  /** 建连并建一个会话，返回新起的 fake 子进程（spawn 同步发生在
   *  newSession 调用内，取 fakes 末尾即本次连接的进程）。 */
  async function bootSession(
    hub: HermesHub,
    cfg: ReturnType<typeof config>,
    fakes: FakeChild[],
    sessionId: string,
  ): Promise<FakeChild> {
    const p = hub.newSession(cfg)
    const fake = fakes[fakes.length - 1]
    answerInitialize(fake)
    await flush()
    fake.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(fake, 'session/new'),
      result: {
        sessionId,
        models: {
          availableModels: [{ modelId: 'm-1' }],
          currentModelId: 'm-1',
        },
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default' }],
        },
      },
    })
    await p
    return fake
  }

  /* ── 会话级权限路由 ─────────────────────────────────────────────────── */

  it('setReadyFork/takeReadyFork：原子存取，消费一次即空', () => {
    const hub = new HermesHub()
    expect(hub.takeReadyFork()).toBeNull() // 未预热
    hub.setReadyFork('sess-r1')
    expect(hub.takeReadyFork()).toBe('sess-r1') // 取走
    expect(hub.takeReadyFork()).toBeNull() // 第二次为空（原子消费）
    hub.setReadyFork('sess-r2')
    hub.setReadyFork('sess-r3') // 幂等覆盖
    expect(hub.takeReadyFork()).toBe('sess-r3')
  })

  it('shouldSkipLoad：new/load 成功确认；load null 不确认；prompt 失败摘除', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    // newSession 成功 → 确认
    const c1 = await bootSession(hub, cfg, fakes, 's-1')
    expect(hub.shouldSkipLoad('s-1')).toBe(true)

    // loadSession 成功 → 确认
    const pLoad = hub.loadSession(cfg, 's-2')
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/load'),
      result: {
        models: { availableModels: [{ modelId: 'm-1' }], currentModelId: 'm-1' },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] },
      },
    })
    await pLoad
    expect(hub.shouldSkipLoad('s-2')).toBe(true)

    // load 返回 null（hermes 忘了会话）→ 不确认
    const pLoad2 = hub.loadSession(cfg, 's-3')
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/load'),
      result: null,
    })
    await pLoad2
    expect(hub.shouldSkipLoad('s-3')).toBe(false)

    // prompt 失败 → 摘除确认标记（下一轮恢复 load 语义自愈）
    const pPrompt = hub.prompt(cfg, 's-1', 'hi', jest.fn())
    await flush()
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c1, 'session/prompt'),
      error: { code: -32000, message: 'model unavailable' },
    })
    await expect(pPrompt).rejects.toThrow()
    expect(hub.shouldSkipLoad('s-1')).toBe(false)
    hub.dispose()
  })

  it('shouldSkipLoad：连接重建（新进程）后旧会话确认全部清空', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const c1 = await bootSession(hub, cfg, fakes, 's-old')
    expect(hub.shouldSkipLoad('s-old')).toBe(true)

    // 进程死亡（dispose 杀进程）→ 连接代际变化 → 确认集清空
    hub.dispose()
    await bootSession(hub, cfg, fakes, 's-new')
    expect(hub.shouldSkipLoad('s-new')).toBe(true)
    expect(hub.shouldSkipLoad('s-old')).toBe(false) // 旧进程会话不再确认
    hub.dispose()
  })

  it('两会话并发权限请求各归其会话级 handler，互不顶替', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    const handlerA = jest.fn()
    const handlerB = jest.fn()
    hub.setPermissionHandler(handlerA, 's-a')
    hub.setPermissionHandler(handlerB, 's-b')

    // 两个会话的权限请求几乎同时到达（同一帧序列连发）。
    c1.emitStdoutLine(permissionFrame(71, 's-a'))
    c1.emitStdoutLine(permissionFrame(72, 's-b'))

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerA.mock.calls[0][0].requestId).toBe(71)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(handlerB.mock.calls[0][0].requestId).toBe(72)
    // 未答复前不应有应答帧写出。
    expect(responsesFor(c1, 71)).toHaveLength(0)
    expect(responsesFor(c1, 72)).toHaveLength(0)
    hub.setPermissionHandler(null, 's-a')
    hub.setPermissionHandler(null, 's-b')
    hub.dispose()
  })

  it('会话级 handler 缺失回落全局槽（主视图不传 sessionId 的既有语义）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    const globalHandler = jest.fn()
    const handlerA = jest.fn()
    hub.setPermissionHandler(globalHandler) // 全局槽（主视图调用形态）
    hub.setPermissionHandler(handlerA, 's-a')

    // s-a 有会话级 → 归会话级；s-b 没有 → 回落全局。
    c1.emitStdoutLine(permissionFrame(81, 's-a'))
    c1.emitStdoutLine(permissionFrame(82, 's-b'))
    // 请求 params 不带 sessionId 的老帧 → 也走全局（向后兼容）。
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      id: 83,
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 'perm-83' }, options: [] },
    })

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerA.mock.calls[0][0].requestId).toBe(81)
    expect(globalHandler).toHaveBeenCalledTimes(2)
    expect(globalHandler.mock.calls.map((c) => c[0].requestId)).toEqual([
      82, 83,
    ])
    hub.setPermissionHandler(null, 's-a')
    hub.setPermissionHandler(null)
    hub.dispose()
  })

  it('全部 handler 缺失 → fail-closed deny（立即回 cancelled，抢在 hermes 60s 前）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    c1.emitStdoutLine(permissionFrame(91, 's-a'))
    // 无 handler：立即 deny，不挂 55s 定时器（与既有行为一致）。
    const answers = responsesFor(c1, 91)
    expect(answers).toHaveLength(1)
    expect(answers[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    // 时间推进也不产生重复应答（无残留定时器）。
    jest.advanceTimersByTime(120_000)
    expect(responsesFor(c1, 91)).toHaveLength(1)
    hub.dispose()
  })

  it('会话级路径的 55s 自动取消兜底不变（无答复 = deny）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    const handlerA = jest.fn()
    hub.setPermissionHandler(handlerA, 's-a')
    c1.emitStdoutLine(permissionFrame(101, 's-a'))
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(responsesFor(c1, 101)).toHaveLength(0)

    jest.advanceTimersByTime(54_999)
    expect(responsesFor(c1, 101)).toHaveLength(0)
    jest.advanceTimersByTime(1)
    const answers = responsesFor(c1, 101)
    expect(answers).toHaveLength(1)
    expect(answers[0].result).toEqual({ outcome: { outcome: 'cancelled' } })

    // UI 在 55s 内答复则抢占兜底（answerPermission 语义不受路由改动影响）。
    c1.emitStdoutLine(permissionFrame(102, 's-a'))
    hub.answerPermission(102, 'allow_once')
    const allow = responsesFor(c1, 102)
    expect(allow).toHaveLength(1)
    expect(allow[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    })
    jest.advanceTimersByTime(60_000)
    expect(responsesFor(c1, 102)).toHaveLength(1) // 兜底定时器已被 answer 清掉
    hub.setPermissionHandler(null, 's-a')
    hub.dispose()
  })

  it('denyPendingPermissions：停止生成时在途权限请求立即全部拒绝（不等 55s 兜底）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    const expiry = jest.fn()
    // 注册 handler 让请求进 permissionTimers（不注册 = fail-closed 立即 deny，
    // 不经过在途队列——那是另一条路径）。
    hub.setPermissionHandler(jest.fn())
    hub.setPermissionExpiryHandler(expiry)
    c1.emitStdoutLine(permissionFrame(111, 's-a'))
    c1.emitStdoutLine(permissionFrame(112, 's-a'))
    await flush()
    expect(responsesFor(c1, 111)).toHaveLength(0)

    hub.denyPendingPermissions()

    // 每个在途请求都收到 cancelled 应答（一问一答各一帧）。
    const r1 = responsesFor(c1, 111)
    const r2 = responsesFor(c1, 112)
    expect(r1).toHaveLength(1)
    expect(r1[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(r2).toHaveLength(1)
    expect(r2[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    // UI 清 pending 展示的通知逐条触发。
    expect(expiry.mock.calls.map((c) => c[0])).toEqual([111, 112])
    // 定时器已清：55s 后绝不重复应答（重复应答破坏 JSON-RPC 一问一答契约）。
    jest.advanceTimersByTime(60_000)
    expect(responsesFor(c1, 111)).toHaveLength(1)
    expect(responsesFor(c1, 112)).toHaveLength(1)
    hub.dispose()
  })

  it('注销：会话级 null 只摘自己的槽；全局 null 清全局槽', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    const globalHandler = jest.fn()
    const handlerA = jest.fn()
    const handlerB = jest.fn()
    hub.setPermissionHandler(globalHandler)
    hub.setPermissionHandler(handlerA, 's-a')
    hub.setPermissionHandler(handlerB, 's-b')

    hub.setPermissionHandler(null, 's-a') // 只注销 s-a
    c1.emitStdoutLine(permissionFrame(111, 's-a'))
    c1.emitStdoutLine(permissionFrame(112, 's-b'))
    expect(handlerA).not.toHaveBeenCalled()
    expect(globalHandler).toHaveBeenCalledTimes(1) // s-a 回落全局
    expect(handlerB).toHaveBeenCalledTimes(1) // s-b 不受影响

    hub.setPermissionHandler(null) // 注销全局
    c1.emitStdoutLine(permissionFrame(113, 's-x'))
    expect(globalHandler).toHaveBeenCalledTimes(1) // 不再收到
    expect(responsesFor(c1, 113)).toHaveLength(1) // 直接 fail-closed deny
    hub.setPermissionHandler(null, 's-b')
    hub.dispose()
  })

  it('断连清理：进程崩溃后会话级 Map 作废，重连后回落全局槽', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-a')

    const globalHandler = jest.fn()
    const handlerA = jest.fn()
    hub.setPermissionHandler(globalHandler)
    hub.setPermissionHandler(handlerA, 's-a')

    c1.proc.emit('close', 1) // 运行中崩溃 → handleConnectionLost
    expect(hub.connected).toBe(false)

    // 重连（自愈路径）后，旧会话级 handler 已被清——s-a 的请求回落全局。
    const c2 = await bootSession(hub, cfg, fakes, 's-a')
    c2.emitStdoutLine(permissionFrame(121, 's-a'))
    expect(handlerA).not.toHaveBeenCalled()
    expect(globalHandler).toHaveBeenCalledTimes(1)
    expect(globalHandler.mock.calls[0][0].requestId).toBe(121)

    // dispose 同款清 Map：重新注册后 dispose 再重连，会话级不残留。
    hub.setPermissionHandler(handlerA, 's-a')
    hub.dispose()
    const c3 = await bootSession(hub, cfg, fakes, 's-a')
    c3.emitStdoutLine(permissionFrame(122, 's-a'))
    expect(handlerA).not.toHaveBeenCalled()
    expect(globalHandler).toHaveBeenCalledTimes(2)
    hub.setPermissionHandler(null)
    hub.dispose()
  })

  /* ── forgetSession ──────────────────────────────────────────────────── */

  it('forgetSession 清该会话全部内存缓存 + notify（未知会话不 notify）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const c1 = await bootSession(hub, cfg, fakes, 's-1')

    // 三份缓存都喂上：sessionStates（bootSession 的 models/modes 响应）、
    // advertisedCommands（通告帧）、会话级权限 handler。
    c1.emitStdoutLine({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'tools' }],
        },
      },
    })
    const handler = jest.fn()
    hub.setPermissionHandler(handler, 's-1')
    expect(hub.getSessionStates('s-1')).not.toBeNull()
    expect(hub.getAdvertisedCommands('s-1')).toHaveLength(1)

    let notified = 0
    const unsub = hub.subscribe(() => {
      notified += 1
    })
    hub.forgetSession('s-1')
    expect(hub.getSessionStates('s-1')).toBeNull()
    expect(hub.getAdvertisedCommands('s-1')).toEqual([])
    expect(notified).toBe(1)

    // 会话级 handler 一并被摘：该会话的权限请求回落全局（无全局 = deny）。
    c1.emitStdoutLine(permissionFrame(131, 's-1'))
    expect(handler).not.toHaveBeenCalled()
    expect(responsesFor(c1, 131)).toHaveLength(1)

    // 未知会话 = 无缓存可清 → 不 notify。
    hub.forgetSession('nope')
    expect(notified).toBe(1)
    unsub()
    hub.dispose()
  })

  /* ── listSessions 翻页 ─────────────────────────────────────────────── */

  const mkSessions = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      sessionId: `s-${start + i}`,
      title: `title-${start + i}`,
    }))

  /** 回一页 session/list（可带 nextCursor）。 */
  function answerListPage(
    fake: FakeChild,
    sessions: Array<{ sessionId: string; title?: string }>,
    nextCursor?: string,
  ): void {
    fake.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(fake, 'session/list'),
      result: {
        sessions,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      },
    })
  }

  it('多页 cursor 循环合并：第二页请求带上一页 cursor，结果按序拼接', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.listSessions(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()

    // 第一页：满 50 条 + nextCursor（服务端还有余量）。
    expect(framesOf(c1, 'session/list')).toHaveLength(1)
    expect(framesOf(c1, 'session/list')[0].params?.cursor).toBeUndefined()
    answerListPage(c1, mkSessions(1, 50), 's-50')
    await flush()

    // 第二页：请求必须带上 cursor='s-50'（服务端的续页锚点）。
    const listFrames = framesOf(c1, 'session/list')
    expect(listFrames).toHaveLength(2)
    expect(listFrames[1].params?.cursor).toBe('s-50')
    expect(listFrames[1].params?.cwd).toBe('/vault')
    answerListPage(c1, mkSessions(51, 30)) // 无 nextCursor = 到底
    await expect(p).resolves.toEqual({
      sessions: [...mkSessions(1, 50), ...mkSessions(51, 30)],
    })
    hub.dispose()
  })

  it('硬上限截断：200 条即停（4 页），带回当时的 nextCursor', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.listSessions(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()

    // 服务端一直有 nextCursor（会话远超 200 条的场景）。
    for (let page = 0; page < 4; page++) {
      await flush()
      answerListPage(
        c1,
        mkSessions(page * 50 + 1, 50),
        `s-${page * 50 + 50}`,
      )
    }
    const res = (await p) as ListSessionsResult
    expect(res.sessions).toHaveLength(200)
    expect(res.sessions[0].sessionId).toBe('s-1')
    expect(res.sessions[199].sessionId).toBe('s-200')
    expect(res.nextCursor).toBe('s-200') // 调用方可感知未取完
    expect(framesOf(c1, 'session/list')).toHaveLength(4) // 没有继续失控翻页
    hub.dispose()
  })

  it('无 cursor 单页：默认调用行为兼容（只发一次请求，不带 cursor）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.listSessions(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()

    answerListPage(c1, mkSessions(1, 3))
    await expect(p).resolves.toEqual({ sessions: mkSessions(1, 3) })
    const listFrames = framesOf(c1, 'session/list')
    expect(listFrames).toHaveLength(1)
    expect(listFrames[0].params).toEqual({ cwd: '/vault' })
    hub.dispose()
  })

  it('未知 cursor 服务端回空页 → 停止循环不误拼', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.listSessions(cfg)
    const c1 = fakes[0]
    answerInitialize(c1)
    await flush()

    // 服务端给 cursor 但下一页为空（server.py：未知 cursor → 空页）。
    answerListPage(c1, mkSessions(1, 50), 's-50')
    await flush()
    answerListPage(c1, [], 's-50') // 异常：空页仍带 cursor —— 客户端必须停
    await expect(p).resolves.toEqual({ sessions: mkSessions(1, 50) })
    expect(framesOf(c1, 'session/list')).toHaveLength(2)
    hub.dispose()
  })
})
