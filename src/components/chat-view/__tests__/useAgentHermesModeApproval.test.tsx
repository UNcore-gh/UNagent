/**
 * @jest-environment jsdom
 *
 * 任务一 §1.1 + §1.2：hermes 审批链路韧性 + /mode 命令路由。
 *
 * §1.1 三候选诊断结论（真机症状：hermes 模式下 default 审批不弹、任务直接
 * 完成）钉死在这里：
 *  - 候选 a（双路径 set_mode 差异）：无差异——/hermes 分派路径与 hermes
 *    模式会话走同一 runCore 分支，每轮同款幂等 set_mode（本套件两条用例
 *    各钉一条路径，断言 setMode 先于 prompt 且带 settings 的 approvalMode）。
 *  - 候选 b（set_mode 静默失败 + state.db 持久旧模式）：真薄弱点——旧实现
 *    catch 静默吞错，失败即沿用 hermes 侧旧模式跑而用户毫不知情。修复后
 *    失败显式 Notice，轮次不阻断（用例钉死：Notice 出现 + prompt 仍被调用）。
 *  - 候选 c（权限 handler 生命周期/面板门控）：无遗漏——handler 全局单槽
 *    挂载正常，scripted fake 帧用例钉死：帧到达 → pendingHermesPermission
 *    置位 → 点选回包 answerPermission。
 *
 * §1.2 /mode 路由：三中文别名、无参弹选择窗（pickerRequest='mode'）、
 * 非法参数用法提示；M2-T8 core 引擎同款命令直接写 SafetySettings.approvalMode。
 *
 * hub 全程用 fake（jest.mock hermesHub），绝不真起 hermes 进程。
 */

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { FileSystemAdapter } from 'obsidian'
import * as obsidian from 'obsidian'
import type { App } from 'obsidian'

import { PluginProvider } from '../../../contexts/plugin-context'
import {
  DEFAULT_SETTINGS,
  cloneSettings,
} from '../../../settings/settings'
import type { ObsidianAISettings } from '../../../settings/settings'
import type { AgentDef } from '../../../core/agents/agentDef'
// 类型引用（jest.mock 只替换运行时，type-only import 编译后擦除）。
import type { PermissionRequestEvent } from '../../../core/hermes/hermesHub'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

/* ── fake hub：捕获 setMode/prompt，绝不真起 hermes ───────────────────── */

const mockHub = {
  setPermissionHandler: jest.fn(
    (_h: ((ev: PermissionRequestEvent) => void) | null) => undefined,
  ),
  subscribe: jest.fn((_cb: () => void) => () => undefined),
  answerPermission: jest.fn(),
  denyPendingPermissions: jest.fn(),
  getSessionStates: jest.fn(() => null),
  getAdvertisedCommands: jest.fn(() => []),
  newSession: jest.fn(async () => ({ sessionId: 'sess-mode-1' })),
  loadSession: jest.fn(async () => false),
  forkSession: jest.fn(async () => ({ sessionId: 'sess-mode-forked' })),
  takeReadyFork: jest.fn(() => null),
  shouldSkipLoad: jest.fn(() => false),
  setMode: jest.fn(
    async (_cfg: unknown, _sessionId: string, _mode: string) => undefined,
  ),
  setModel: jest.fn(async () => undefined),
  prompt: jest.fn(
    async (
      _cfg: unknown,
      _sessionId: string,
      _text: string,
      onUpdate: (u: unknown) => void,
    ) => {
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      })
      return { stopReason: 'end_turn' }
    },
  ),
  cancel: jest.fn(),
  dispose: jest.fn(),
}

jest.mock('../../../core/hermes/hermesHub', () => ({
  getHermesHub: () => mockHub,
  disposeHermesHub: () => undefined,
  HermesHub: class {},
}))

/* ── harness（与 useAgentCompactRoute 同款） ─────────────────────────── */

function mkAppHarness(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  const isDir = (p: string): boolean =>
    Object.keys(store).some((k) => k.startsWith(`${p}/`))
  const adapter = Object.assign(Object.create(FileSystemAdapter.prototype), {
    exists: async (p: string) => p in store || isDir(p),
    read: async (p: string) => {
      if (!(p in store)) throw new Error(`missing: ${p}`)
      return store[p]
    },
    write: async (p: string, data: string) => {
      store[p] = data
    },
    writeBinary: async (p: string, data: ArrayBuffer) => {
      store[p] = `<binary ${data.byteLength}b>`
    },
    mkdir: async (_p: string) => undefined,
    remove: async (p: string) => {
      delete store[p]
    },
    list: async (p: string) => {
      const files: string[] = []
      const folders = new Set<string>()
      for (const k of Object.keys(store)) {
        if (!k.startsWith(`${p}/`)) continue
        const rest = k.slice(p.length + 1)
        const slash = rest.indexOf('/')
        if (slash === -1) files.push(k)
        else folders.add(`${p}/${rest.slice(0, slash)}`)
      }
      return { files, folders: [...folders] }
    },
  })
  const app = {
    vault: { adapter },
  } as unknown as App
  return { app, store }
}

type AppHarness = ReturnType<typeof mkAppHarness>

const HERMES_AGENT: AgentDef = {
  name: 'hbot',
  description: 'hermes 引擎代理',
  engine: 'hermes',
  body: '',
  source: 'user',
}

function mkPluginHarness(
  harness: AppHarness,
  opts: { hermesAgent?: boolean } = {},
) {
  const settingsListeners = new Set<(s: ObsidianAISettings) => void>()
  const dataListeners = new Set<() => void>()
  const settings = cloneSettings(DEFAULT_SETTINGS)
  settings.general.reflectSuggestions = false
  const plugin = {
    app: harness.app,
    settings,
    saveSettings: async () => undefined,
    addSettingsChangeListener: (cb: (s: ObsidianAISettings) => void) => {
      settingsListeners.add(cb)
      return () => {
        settingsListeners.delete(cb)
      }
    },
    addDataChangeListener: (cb: () => void) => {
      dataListeners.add(cb)
      return () => {
        dataListeners.delete(cb)
      }
    },
    pokeDataReload: () => undefined,
    confirm: async () => true,
    openSettingsTab: () => undefined,
    undoStack: {
      countFor: () => 0,
      rollbackFrom: async () => 0,
      push: () => undefined,
      onChange: () => () => undefined,
      canUndo: () => false,
      undoLast: async () => undefined,
      lastLabel: () => '',
    },
    registry: { getAll: () => [] },
    skills: { getAll: () => [] },
    agents: {
      getAll: () => (opts.hermesAgent ? [HERMES_AGENT] : []),
      getByName: (name: string) =>
        opts.hermesAgent && name === HERMES_AGENT.name ? HERMES_AGENT : null,
    },
  } as unknown as ObsidianAI
  return {
    plugin,
    notifySettings: (s: ObsidianAISettings) => {
      for (const cb of settingsListeners) cb(s)
    },
    notifyData: () => {
      for (const cb of dataListeners) cb()
    },
  }
}

type PluginHarness = ReturnType<typeof mkPluginHarness>

const Publisher = ({ bridge }: { bridge: AgentBridge }) => {
  const api = useAgent()
  React.useEffect(() => {
    bridge.publish(api)
  })
  return null
}

const flushMicro = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

/** 捕获 useAgent 挂载时注册到 hub 的权限 handler（候选 c 链路）。 */
const lastPermissionHandler = (): ((ev: PermissionRequestEvent) => void) | null => {
  for (let i = mockHub.setPermissionHandler.mock.calls.length - 1; i >= 0; i--) {
    const h = mockHub.setPermissionHandler.mock.calls[i][0]
    if (h) return h
  }
  return null
}

const SCRIPTED_PERMISSION: PermissionRequestEvent = {
  requestId: 42,
  request: {
    sessionId: 'sess-mode-1',
    toolCall: { toolCallId: 'tc-1', title: '编辑 notes/todo.md' },
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: '允许一次' },
      { optionId: 'reject_once', kind: 'reject_once', name: '拒绝' },
    ],
  },
}

/* ── 用例 ─────────────────────────────────────────────────────────────── */

describe('任务一 §1.1：hermes 模式会话的 set_mode 链路与权限帧路由', () => {
  let root: Root
  let bridge: AgentBridge
  let ph: PluginHarness
  let notices: string[]

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    // 候选 b 修复断言用：捕获 Notice 文案。
    notices = []
    jest
      .spyOn(obsidian, 'Notice')
      .mockImplementation(((msg?: string) => {
        notices.push(msg ?? '')
        return {}
      }) as never)
    bridge = new AgentBridge()
    const harness = mkAppHarness()
    ph = mkPluginHarness(harness, { hermesAgent: true })
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginProvider plugin={ph.plugin}>
          <Publisher bridge={bridge} />
        </PluginProvider>,
      )
    })
    await flushMicro()
    // 切入 engine:hermes 代理对话（= 真机症状的 hermes 模式界面）。
    await act(async () => {
      api().pickAgent(HERMES_AGENT.name)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('每轮幂等：prompt 前必先 set_mode(settings.approvalMode=default)，先于 prompt 调用', async () => {
    await act(async () => {
      await api().send('帮我整理一下笔记', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(mockHub.setMode).toHaveBeenCalledTimes(1)
    expect(mockHub.setMode.mock.calls[0][2]).toBe('default')
    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    // 顺序钉死：set_mode 在 prompt 之前（模式先行，审批语义才成立）。
    expect(mockHub.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      mockHub.prompt.mock.invocationCallOrder[0],
    )
    // 全程没有失败 Notice。
    expect(notices.some((n) => n.includes('应用失败'))).toBe(false)
  })

  it('候选 b 修复：set_mode 失败显式 Notice 且不阻断轮次（prompt 照常发出）', async () => {
    mockHub.setMode.mockRejectedValueOnce(new Error('rpc timeout'))

    await act(async () => {
      await api().send('帮我整理一下笔记', ph.plugin.settings.llm)
    })
    await flushMicro()

    // 轮次不阻断：prompt 照常发出。
    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    // 失败显式可见（旧实现 silent catch 吞掉 → 用户不知情 = 真机症状温床）。
    const hit = notices.find((n) => n.includes('审批模式') && n.includes('应用失败'))
    expect(hit).toBeDefined()
    expect(hit).toContain('rpc timeout')
    expect(hit).toContain('/mode')
  })

  it('候选 c 钉死：scripted 权限请求帧到达 → pendingHermesPermission 置位 → 点选回包', async () => {
    await act(async () => {
      await api().send('帮我改一下 todo.md', ph.plugin.settings.llm)
    })
    await flushMicro()
    expect(api().pendingHermesPermission).toBeNull()

    // hermes 侧发来 session/request_permission（handler 由 useAgent 挂载）。
    const handler = lastPermissionHandler()
    expect(handler).not.toBeNull()
    await act(async () => {
      handler!(SCRIPTED_PERMISSION)
    })
    expect(api().pendingHermesPermission).toBe(SCRIPTED_PERMISSION)

    // 用户点选批准选项 → hub.answerPermission 回包 + 面板状态清空。
    await act(async () => {
      api().answerHermesPermission('allow_once')
    })
    expect(mockHub.answerPermission).toHaveBeenCalledWith(42, 'allow_once')
    expect(api().pendingHermesPermission).toBeNull()
  })

  it('停止生成 → 在途权限请求立即拒绝（denyPendingPermissions）且面板清除', async () => {
    await act(async () => {
      await api().send('帮我改一下 todo.md', ph.plugin.settings.llm)
    })
    await flushMicro()

    // hermes 侧发来权限请求 → 审批面板挂起（等用户点选）。
    const handler = lastPermissionHandler()
    expect(handler).not.toBeNull()
    await act(async () => {
      handler!(SCRIPTED_PERMISSION)
    })
    expect(api().pendingHermesPermission).toBe(SCRIPTED_PERMISSION)

    // 用户点停止按钮 → abort()：hub 拒绝全部在途权限（不再悬挂等 55s
    // 兜底，hermes 侧立即收到 cancelled）+ 面板同步关闭。
    await act(async () => {
      api().abort()
    })
    expect(mockHub.denyPendingPermissions).toHaveBeenCalledTimes(1)
    expect(api().pendingHermesPermission).toBeNull()
  })
})

describe('任务一 §1.2：hermes 会话 /mode 命令路由', () => {
  let root: Root
  let bridge: AgentBridge
  let ph: PluginHarness

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    bridge = new AgentBridge()
    const harness = mkAppHarness()
    ph = mkPluginHarness(harness, { hermesAgent: true })
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginProvider plugin={ph.plugin}>
          <Publisher bridge={bridge} />
        </PluginProvider>,
      )
    })
    await flushMicro()
    await act(async () => {
      api().pickAgent(HERMES_AGENT.name)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    jest.useRealTimers()
  })

  it('/mode 自动 → setMode(accept_edits) + override 生效 + 状态徽章回复', async () => {
    await act(async () => {
      await api().send('/mode 自动', ph.plugin.settings.llm)
    })
    await flushMicro()

    // 会话未建立 → 先建（项目会话 + fork 子会话，与 runHermesTurn 同款），
    // 再 set_mode（作用于子会话——轮次幂等查询的 activeSessionId 就是它）。
    expect(mockHub.newSession).toHaveBeenCalled()
    expect(mockHub.forkSession).toHaveBeenCalled()
    expect(mockHub.setMode).toHaveBeenCalledTimes(1)
    expect(mockHub.setMode.mock.calls[0][1]).toBe('sess-mode-forked')
    expect(mockHub.setMode.mock.calls[0][2]).toBe('accept_edits')
    // 不透传：hermes 没收到 /mode 字样。
    expect(mockHub.prompt).not.toHaveBeenCalled()

    const msgs = api().messages
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('/mode 自动')
    const reply = msgs[msgs.length - 1]
    expect(reply.command).toBe('mode')
    const text = (reply.blocks ?? [])
      .filter((b) => b.kind === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    expect(text).toContain('自动（编辑放行）')

    // override 生效：下一轮发送时幂等应用 override 而非设置默认值。
    await act(async () => {
      await api().send('干活', ph.plugin.settings.llm)
    })
    await flushMicro()
    expect(mockHub.setMode).toHaveBeenCalledTimes(2)
    expect(mockHub.setMode.mock.calls[1][2]).toBe('accept_edits')
  })

  it('/mode 免询 → setMode(dont_ask)（第三组别名）', async () => {
    await act(async () => {
      await api().send('/mode 不要询问', ph.plugin.settings.llm)
    })
    await flushMicro()
    expect(mockHub.setMode).toHaveBeenCalledWith(
      expect.anything(),
      'sess-mode-forked',
      'dont_ask',
    )
  })

  it('无参 /mode → 弹审批模式选择窗（pickerRequest=mode），命令文本不进会话', async () => {
    await act(async () => {
      await api().send('/mode', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(api().pickerRequest).toBe('mode')
    expect(mockHub.setMode).not.toHaveBeenCalled()
    expect(mockHub.prompt).not.toHaveBeenCalled()
    // 与 /model 无参同款：命令文本不进会话（不占历史、不标记脏）。
    expect(api().messages).toHaveLength(0)

    await act(async () => {
      api().clearPickerRequest()
    })
    expect(api().pickerRequest).toBeNull()
  })

  it('非法参数 → 用法提示（含三组别名清单），不触碰 hermes', async () => {
    await act(async () => {
      await api().send('/mode 放飞自我', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(mockHub.setMode).not.toHaveBeenCalled()
    expect(mockHub.prompt).not.toHaveBeenCalled()
    expect(api().pickerRequest).toBeNull()
    const msgs = api().messages
    const note = msgs[msgs.length - 1]
    const text = (note.blocks ?? [])
      .filter((b) => b.kind === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    expect(text).toContain('用法：/mode')
    expect(text).toContain('默认')
    expect(text).toContain('自动审批')
    expect(text).toContain('不要询问')
  })
})

describe('任务一 §1.2 + M2-T8：core 引擎下 /mode 切换审批模式（写 SafetySettings）与双路径同款 set_mode（候选 a）', () => {
  let root: Root
  let bridge: AgentBridge
  let ph: PluginHarness

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    bridge = new AgentBridge()
    const harness = mkAppHarness()
    ph = mkPluginHarness(harness) // 无 hermes 代理 = 主代理（core）
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginProvider plugin={ph.plugin}>
          <Publisher bridge={bridge} />
        </PluginProvider>,
      )
    })
    await flushMicro()
  })

  afterEach(() => {
    act(() => root.unmount())
    jest.useRealTimers()
  })

  it('core 会话发 /mode 自动 → 写 SafetySettings.approvalMode（不碰 hermes hub），回复挂 mode 徽章', async () => {
    await act(async () => {
      await api().send('/mode 自动', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(mockHub.setMode).not.toHaveBeenCalled()
    expect(mockHub.prompt).not.toHaveBeenCalled()
    expect(ph.plugin.settings.safety.approvalMode).toBe('accept_edits')
    const msgs = api().messages
    const note = msgs[msgs.length - 1]
    expect(note.command).toBe('mode')
    const text = (note.blocks ?? [])
      .filter((b) => b.kind === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    expect(text).toContain('审批模式已切换为「自动（编辑放行）」')
    expect(text).toContain('破坏性操作将按此模式确认')
  })

  it('core 会话发 /mode 免询 → dont_ask；无参 /mode → 弹审批模式选择窗（命令不进会话）', async () => {
    await act(async () => {
      await api().send('/mode 不要询问', ph.plugin.settings.llm)
    })
    await flushMicro()
    expect(ph.plugin.settings.safety.approvalMode).toBe('dont_ask')

    // 无参 → 弹窗；命令文本不进会话（与 hermes 路径同款收口）。
    const before = api().messages.length
    await act(async () => {
      await api().send('/mode', ph.plugin.settings.llm)
    })
    await flushMicro()
    expect(api().pickerRequest).toBe('mode')
    expect(api().messages.length).toBe(before)
  })

  it('候选 a 钉死：/hermes 分派路径与 hermes 会话走同一 set_mode 链路（default）', async () => {
    await act(async () => {
      await api().send('/hermes 干活', ph.plugin.settings.llm)
    })
    await flushMicro()

    // 分派路径同样每轮幂等 set_mode，mode id 与会话路径一致（settings 值）。
    expect(mockHub.setMode).toHaveBeenCalledTimes(1)
    expect(mockHub.setMode.mock.calls[0][2]).toBe('default')
    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    expect(mockHub.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      mockHub.prompt.mock.invocationCallOrder[0],
    )
  })
})
