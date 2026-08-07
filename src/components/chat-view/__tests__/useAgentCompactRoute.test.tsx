/**
 * @jest-environment jsdom
 *
 * M2-T5：/compact 路由。
 *
 * hermes 引擎（engine: hermes 代理）下 /compact 不走插件侧 compactContext
 * （不搞双压缩机制），而是改写成 hermes 原生 /compress 透传给 ACP 会话
 * （服务端 _handle_slash_command 本地拦截，不走 LLM）。实测 hermes
 * acp_adapter/server.py 的 _cmd_compress 签名虽收 args 但函数体从不读取
 * （无条件 force=True 压整个 history），故无论带不带策略参数，一律降级为
 * 裸 /compress（策略丢弃）。回复按普通消息渲染 + compact 命令徽章。
 *
 * core 引擎（主代理）零变化：/compact 仍走 compactContext 原路径。
 *
 * hub 全程用 fake（jest.mock hermesHub），绝不真起 hermes 进程。
 */

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { FileSystemAdapter } from 'obsidian'
import type { App } from 'obsidian'

import { PluginProvider } from '../../../contexts/plugin-context'
import {
  DEFAULT_SETTINGS,
  cloneSettings,
} from '../../../settings/settings'
import type { ObsidianAISettings } from '../../../settings/settings'
import type { AgentDef } from '../../../core/agents/agentDef'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

/* ── fake hub：捕获 prompt 文本，绝不真起 hermes ─────────────────────── */

const mockHub = {
  setPermissionHandler: jest.fn(),
  subscribe: jest.fn((_cb: () => void) => () => undefined),
  answerPermission: jest.fn(),
  denyPendingPermissions: jest.fn(),
  getSessionStates: jest.fn(() => null),
  // M2-T4: 通告命令缓存读口（本套件无通告帧 → 空数组）。
  getAdvertisedCommands: jest.fn(() => []),
  newSession: jest.fn(async () => ({ sessionId: 'sess-compact-1' })),
  loadSession: jest.fn(async () => false),
  forkSession: jest.fn(async () => ({ sessionId: 'sess-compact-forked' })),
  takeReadyFork: jest.fn(() => null),
  shouldSkipLoad: jest.fn(() => false),
  setMode: jest.fn(async () => undefined),
  setModel: jest.fn(async () => undefined),
  prompt: jest.fn(
    async (
      _cfg: unknown,
      _sessionId: string,
      _text: string,
      onUpdate: (u: unknown) => void,
    ) => {
      // 模拟 hermes 服务端本地拦截 /compress 后的回复帧（普通文本）。
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Context compressed: 8 -> 3 messages' },
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

/* ── harness（与 useAgentBranchImmediate 同款，adapter 换成
     FileSystemAdapter 实例以通过 hermes 轮的 instanceof 门） ─────────── */

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
  // B 案复盘与路由无关，关掉避免测试里触发一次性模型调用。
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

/* ── 用例 ─────────────────────────────────────────────────────────────── */

describe('M2-T5：hermes 引擎 /compact → /compress 路由改写', () => {
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
    // 切入 engine:hermes 代理对话。
    await act(async () => {
      api().pickAgent(HERMES_AGENT.name)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    jest.useRealTimers()
  })

  it('带策略：/compact <策略> → 裸 /compress 透传（策略丢弃，实测 _cmd_compress 不消费 args）', async () => {
    await act(async () => {
      await api().send('/compact 只保留决策与结论', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    const promptText = mockHub.prompt.mock.calls[0][2]
    // 关键断言：改写为裸 /compress——不带策略尾巴。
    expect(promptText).toBe('/compress')

    const msgs = api().messages
    // 用户气泡保留原文（用户打的是 /compact）。
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('/compact 只保留决策与结论')
    // hermes 回复按普通消息渲染 + compact 命令徽章。
    const reply = msgs[msgs.length - 1]
    expect(reply.role).toBe('assistant')
    expect(reply.command).toBe('compact')
    expect(reply.blocks).toEqual([
      { kind: 'text', text: 'Context compressed: 8 -> 3 messages' },
    ])
    // 没碰插件侧 compactContext——既无「对话太短」提示也不替换消息列表。
    expect(
      msgs.some((m) =>
        (m.blocks ?? []).some(
          (b) => b.kind === 'text' && b.text.includes('没必要压缩'),
        ),
      ),
    ).toBe(false)
  })

  it('无参：裸 /compact 同样改写为裸 /compress', async () => {
    await act(async () => {
      await api().send('/compact', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    expect(mockHub.prompt.mock.calls[0][2]).toBe('/compress')
    const msgs = api().messages
    expect(msgs[msgs.length - 1].command).toBe('compact')
  })

  it('普通文本不受路由影响（改写严格门控在 compact 命令）', async () => {
    await act(async () => {
      await api().send('帮我压缩一下这段会议纪要', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    const promptText = mockHub.prompt.mock.calls[0][2]
    // 含「压缩」字样的普通文本不会被路由劫持成 /compress（新会话下会被
    // buildHermesChatPrompt 包进人设窗口，属既有行为；关键是不被改写）。
    expect(promptText).not.toBe('/compress')
    expect(promptText).toContain('帮我压缩一下这段会议纪要')
    const msgs = api().messages
    expect(msgs[msgs.length - 1].command).toBeUndefined()
  })
})

describe('M2-T5：core 引擎 /compact 仍走 compactContext 原路径（零改动回归）', () => {
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

  it('主代理下 /compact 走 compactContext（短对话提示），不触碰 hermes hub', async () => {
    await act(async () => {
      await api().send('/compact 只保留决策与结论', ph.plugin.settings.llm)
    })
    await flushMicro()

    // hermes 通道完全没被调用。
    expect(mockHub.prompt).not.toHaveBeenCalled()
    expect(mockHub.newSession).not.toHaveBeenCalled()

    // compactContext 原行为：对话 < MIN_COMPACT_MESSAGES 条 → 友好提示。
    const msgs = api().messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('/compact 只保留决策与结论')
    const note = msgs[1]
    expect(note.blocks?.[0]).toMatchObject({ kind: 'text' })
    expect((note.blocks?.[0] as { text: string }).text).toContain(
      '没必要压缩',
    )
  })
})
