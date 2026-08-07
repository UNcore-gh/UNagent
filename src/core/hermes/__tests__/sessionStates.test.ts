// M2-T1/T2 模型清单与审批模式清单：
// - 纯函数层：session/new、session/load 响应（models/modes）的宽容解析、
//   选择窗行构造（current 徽章、未就绪禁用占位）。
// - HermesHub 层：scripted fake 帧序列喂 session/new / session/load 响应，
//   断言按 sessionId 缓存正确、set_model/set_mode 后 current 同步、
//   崩溃后缓存作废。
// 红线守门：清单未就绪时行构造只产出禁用占位行——绝不回落插件档案列表
// （档案 model_id ≠ hermes encoded choice id）。

import { EventEmitter } from 'events'
import { HermesHub } from '../hermesHub'
import {
  buildHermesModeRows,
  buildHermesModelRows,
  HERMES_PICKER_LOADING_ID,
  HERMES_PICKER_LOADING_LABEL,
  isKnownHermesMode,
  parseSessionStates,
} from '../sessionStates'
import type { SpawnLike, LocalAgentChild } from '../../desktop/localAgent'

/* ── 线缆样例（字段结构只读核对自 hermes-agent-main/acp_adapter/server.py） ── */

/** session/new 响应样例：sessionId + models + modes（全 camelCase）。 */
const NEW_SESSION_RES = {
  sessionId: 's-1',
  models: {
    availableModels: [
      { modelId: 'anthropic:claude-sonnet', name: 'Claude Sonnet', description: 'balanced' },
      { modelId: 'openai:gpt-5', name: 'GPT-5', description: 'fast' },
    ],
    currentModelId: 'anthropic:claude-sonnet',
  },
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: '默认', description: '每步询问' },
      { id: 'accept_edits', name: '接受编辑', description: '编辑免询问' },
      { id: 'dont_ask', name: '不询问', description: '全自动' },
    ],
  },
}

/** session/load 响应样例：同款 models/modes，但无 sessionId。 */
const LOAD_SESSION_RES = {
  models: {
    availableModels: [
      { modelId: 'anthropic:claude-opus', name: 'Claude Opus' },
    ],
    currentModelId: 'anthropic:claude-opus',
  },
  modes: {
    currentModeId: 'accept_edits',
    availableModes: [
      { id: 'default', name: '默认' },
      { id: 'accept_edits', name: '接受编辑' },
      { id: 'dont_ask', name: '不询问' },
    ],
  },
}

/* ── 纯函数：解析 ────────────────────────────────────────────────────── */

describe('parseSessionStates（解析）', () => {
  it('session/new 响应 → models/modes 完整解析', () => {
    const s = parseSessionStates(NEW_SESSION_RES)
    expect(s.models).not.toBeNull()
    expect(s.models!.availableModels).toHaveLength(2)
    expect(s.models!.availableModels[0]).toEqual({
      modelId: 'anthropic:claude-sonnet',
      name: 'Claude Sonnet',
      description: 'balanced',
    })
    expect(s.models!.currentModelId).toBe('anthropic:claude-sonnet')
    expect(s.modes).not.toBeNull()
    expect(s.modes!.availableModes.map((m) => m.id)).toEqual([
      'default',
      'accept_edits',
      'dont_ask',
    ])
    expect(s.modes!.currentModeId).toBe('default')
  })

  it('session/load 响应（无 sessionId）→ 同款解析', () => {
    const s = parseSessionStates(LOAD_SESSION_RES)
    expect(s.models!.availableModels[0].modelId).toBe('anthropic:claude-opus')
    expect(s.modes!.currentModeId).toBe('accept_edits')
  })

  it('字段缺失/畸形 → 对应清单为 null（宽容解析，不抛错）', () => {
    expect(parseSessionStates(null)).toEqual({ models: null, modes: null })
    expect(parseSessionStates({})).toEqual({ models: null, modes: null })
    // models 有但 modes 畸形 → 只丢 modes。
    const s = parseSessionStates({
      models: NEW_SESSION_RES.models,
      modes: { availableModes: 'nope' },
    })
    expect(s.models).not.toBeNull()
    expect(s.modes).toBeNull()
  })

  it('行内 modelId/id 缺失的行被跳过，其余保留', () => {
    const s = parseSessionStates({
      models: {
        availableModels: [
          { name: '无 id 行' },
          { modelId: 'p:m', name: '有效行' },
        ],
        currentModelId: 'p:m',
      },
    })
    expect(s.models!.availableModels).toHaveLength(1)
    expect(s.models!.availableModels[0].modelId).toBe('p:m')
  })
})

/* ── 纯函数：选择窗行构造（红线：未就绪绝不回落插件档案） ─────────────── */

describe('buildHermesModelRows / buildHermesModeRows（选择窗行）', () => {
  it('就绪 → 行内 current 打「当前」标记', () => {
    const state = parseSessionStates(NEW_SESSION_RES)
    const ml = buildHermesModelRows(state)
    expect(ml.ready).toBe(true)
    expect(ml.rows.map((r) => r.id)).toEqual([
      'anthropic:claude-sonnet',
      'openai:gpt-5',
    ])
    expect(ml.rows[0].current).toBe(true)
    expect(ml.rows[1].current).toBe(false)

    const mo = buildHermesModeRows(state)
    expect(mo.ready).toBe(true)
    expect(mo.rows.find((r) => r.id === 'default')!.current).toBe(true)
    expect(mo.rows.find((r) => r.id === 'dont_ask')!.current).toBe(false)
  })

  it('未就绪（null/空清单）→ 单行禁用占位「hermes 清单加载中」', () => {
    for (const state of [null, { models: null, modes: null }]) {
      const ml = buildHermesModelRows(state)
      expect(ml.ready).toBe(false)
      expect(ml.rows).toHaveLength(1)
      expect(ml.rows[0].id).toBe(HERMES_PICKER_LOADING_ID)
      expect(ml.rows[0].label).toBe(HERMES_PICKER_LOADING_LABEL)
      expect(ml.rows[0].loading).toBe(true)

      const mo = buildHermesModeRows(state)
      expect(mo.ready).toBe(false)
      expect(mo.rows[0].loading).toBe(true)
    }
  })

  it('红线：未就绪行绝不包含任何插件档案式 model_id（只出禁用占位）', () => {
    // 构造者无法传入「插件档案列表」——签名只吃 hermes 缓存状态；
    // 未就绪时唯一产出是禁用占位行，任何档案 id 都不可能出现在行里。
    const ml = buildHermesModelRows(null)
    expect(ml.rows.every((r) => r.loading)).toBe(true)
    expect(ml.rows.map((r) => r.id)).toEqual([HERMES_PICKER_LOADING_ID])
  })

  it('isKnownHermesMode：清单内选择 vs 设置兜底的判据', () => {
    const state = parseSessionStates(NEW_SESSION_RES)
    expect(isKnownHermesMode(state, 'accept_edits')).toBe(true)
    expect(isKnownHermesMode(state, 'bogus_mode')).toBe(false)
    expect(isKnownHermesMode(null, 'default')).toBe(false)
  })
})

/* ── HermesHub：scripted fake 帧序列 → 缓存生命周期 ───────────────────── */

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

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('HermesHub 会话状态缓存（scripted fake）', () => {
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

  it('session/new 响应 → 按 sessionId 缓存 models/modes + current', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)
    const notify = jest.fn()
    hub.subscribe(notify)

    expect(hub.getSessionStates('s-1')).toBeNull() // 未就绪

    const p = hub.newSession(cfg)
    const c = fakes[0]
    answerInitialize(c)
    await flush()
    c.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c, 'session/new'),
      result: NEW_SESSION_RES,
    })
    await expect(p).resolves.toMatchObject({ sessionId: 's-1' })

    const state = hub.getSessionStates('s-1')
    expect(state).not.toBeNull()
    expect(state!.models!.currentModelId).toBe('anthropic:claude-sonnet')
    expect(state!.models!.availableModels).toHaveLength(2)
    expect(state!.modes!.currentModeId).toBe('default')
    expect(state!.modes!.availableModes).toHaveLength(3)
    expect(notify).toHaveBeenCalled() // UI 可感知清单就绪

    hub.dispose()
  })

  it('session/load 响应 → 缓存随会话恢复重建（响应无 sessionId，按入参缓存）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.loadSession(cfg, 'old-session')
    const c = fakes[0]
    answerInitialize(c)
    await flush()
    c.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c, 'session/load'),
      result: LOAD_SESSION_RES,
    })
    await expect(p).resolves.toBe(true)

    const state = hub.getSessionStates('old-session')
    expect(state).not.toBeNull()
    expect(state!.models!.currentModelId).toBe('anthropic:claude-opus')
    expect(state!.modes!.currentModeId).toBe('accept_edits')
    // 选择窗行即刻可用且 current 标记正确。
    const ml = buildHermesModelRows(state)
    expect(ml.ready).toBe(true)
    expect(ml.rows[0].current).toBe(true)

    hub.dispose()
  })

  it('set_model/set_mode 成功后缓存 currentId 同步（「当前」徽章即时更新）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.newSession(cfg)
    const c = fakes[0]
    answerInitialize(c)
    await flush()
    c.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c, 'session/new'),
      result: NEW_SESSION_RES,
    })
    await p

    // set_model → hermes 回空成功帧。
    const pm = hub.setModel(cfg, 's-1', 'openai:gpt-5')
    await flush()
    c.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c, 'session/set_model'),
      result: {},
    })
    await pm
    expect(hub.getSessionStates('s-1')!.models!.currentModelId).toBe('openai:gpt-5')

    // set_mode 同款。
    const pmo = hub.setMode(cfg, 's-1', 'dont_ask')
    await flush()
    c.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c, 'session/set_mode'),
      result: {},
    })
    await pmo
    expect(hub.getSessionStates('s-1')!.modes!.currentModeId).toBe('dont_ask')

    hub.dispose()
  })

  it('进程崩溃 → 缓存作废（getSessionStates 回 null，清单回到未就绪）', async () => {
    const { spawn, fakes } = makeManualSpawn()
    const hub = new HermesHub()
    const cfg = config(spawn)

    const p = hub.newSession(cfg)
    const c = fakes[0]
    answerInitialize(c)
    await flush()
    c.emitStdoutLine({
      jsonrpc: '2.0',
      id: lastRequestId(c, 'session/new'),
      result: NEW_SESSION_RES,
    })
    await p
    expect(hub.getSessionStates('s-1')).not.toBeNull()

    c.proc.emit('close', 1) // 运行中崩溃 → handleConnectionLost
    await flush()
    expect(hub.getSessionStates('s-1')).toBeNull()
    // 未就绪守卫生效：行构造只出禁用占位。
    expect(buildHermesModelRows(hub.getSessionStates('s-1')).ready).toBe(false)

    hub.dispose()
  })
})
