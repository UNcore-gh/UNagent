/**
 * @jest-environment jsdom
 *
 * 用户级修订（九命令补齐）：行为绑定表之 /reset —— hermes 会话收到恰好
 * '/reset'（trim 后）时，send 透传层前置 ConfirmModal 确认（plugin.confirm，
 * main.ts onload 经 createConfirm(this.app) 装配）。文案 = HERMES_RESET_CONFIRM
 * （将清空 hermes 侧对话历史，插件侧消息保留，两边会脱节）。确认 → 原样
 * 透传 runCore（hermes 轮 / 开头跳过人设包裹，原样进 ACP）；拒绝 → 不透传、
 * 不发送、不加任何消息。带参 '/reset xxx' 不是恰好 '/reset'，不拦截。
 *
 * hub 全程用 fake（jest.mock hermesHub），绝不真起 hermes 进程。
 * harness 与 useAgentCompactRoute 同款。
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
import type { ConfirmRequest } from '../../../core/agent/types'
import { HERMES_RESET_CONFIRM } from '../../../core/hermes/advertisedCommands'
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
  getAdvertisedCommands: jest.fn(() => []),
  newSession: jest.fn(async () => ({ sessionId: 'sess-reset-1' })),
  loadSession: jest.fn(async () => false),
  forkSession: jest.fn(async () => ({ sessionId: 'sess-reset-forked' })),
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
      // 模拟 hermes 服务端 _handle_slash_command 本地拦截后的回复帧。
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Conversation history cleared.' },
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

// useAgent 的 hermes 技能清单拉取（refreshHermesSkills，currentHermes 变化
// 触发）走 runLocalAgent——mock 掉 child_process 让 getDesktopSpawn() 返回
// null 直接落 spawn_unavailable，与「绝不真起 hermes 进程」承诺一致（真实
// spawn 在本文件的 fake timers 下会挂起测试）。注入 fake 的用例不受影响。
jest.mock('child_process', () => ({ spawn: undefined }))

/* ── harness（与 useAgentCompactRoute 同款；confirm 可配） ───────────── */

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
  opts: { confirm?: (req: ConfirmRequest) => Promise<boolean> } = {},
) {
  const settingsListeners = new Set<(s: ObsidianAISettings) => void>()
  const dataListeners = new Set<() => void>()
  const settings = cloneSettings(DEFAULT_SETTINGS)
  settings.general.reflectSuggestions = false
  const confirmCalls: ConfirmRequest[] = []
  const confirm = jest.fn(async (req: ConfirmRequest) => {
    confirmCalls.push(req)
    return opts.confirm ? opts.confirm(req) : true
  })
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
    confirm,
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
      getAll: () => [HERMES_AGENT],
      getByName: (name: string) =>
        name === HERMES_AGENT.name ? HERMES_AGENT : null,
    },
  } as unknown as ObsidianAI
  return { plugin, confirm, confirmCalls }
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

describe('行为绑定表：hermes 会话 /reset → 确认后才透传', () => {
  let root: Root
  let bridge: AgentBridge
  let ph: PluginHarness

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  const mount = async (
    opts: Parameters<typeof mkPluginHarness>[1] = {},
  ): Promise<void> => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    bridge = new AgentBridge()
    const harness = mkAppHarness()
    ph = mkPluginHarness(harness, opts)
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
  }

  afterEach(() => {
    act(() => root.unmount())
    jest.useRealTimers()
  })

  it('确认 → /reset 原样透传 runCore（hermes 轮收到恰好 /reset）', async () => {
    await mount()
    await act(async () => {
      // M2-T8 起 reset 确认走 React 槽位（ConfirmApprovalPanel）：send 在
      // 面板点选前挂起，answerConfirm 回包放行（模拟点 Yes）。请求内容的
      // 文案由 HERMES_RESET_CONFIRM 常量承载（面板渲染不在本 harness 覆盖）。
      const p = api().send('/reset', ph.plugin.settings.llm)
      api().answerConfirm(true)
      await p
    })
    await flushMicro()

    // 透传：hermes 轮收到恰好 '/reset'（/ 开头跳过人设包裹）。
    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    expect(mockHub.prompt.mock.calls[0][2]).toBe('/reset')

    // 用户气泡与回复照常落消息列表。
    const msgs = api().messages
    expect(msgs[0]).toMatchObject({ role: 'user', content: '/reset' })
    const reply = msgs[msgs.length - 1]
    expect(reply.role).toBe('assistant')
    expect(reply.blocks).toEqual([
      { kind: 'text', text: 'Conversation history cleared.' },
    ])
  })

  it('拒绝 → 不透传、不发送、不加任何消息（runCore 不进）', async () => {
    await mount()
    await act(async () => {
      const p = api().send('/reset', ph.plugin.settings.llm)
      await Promise.resolve()
      api().answerConfirm(false) // 模拟点 No
      await p
    })
    await flushMicro()

    // 关键断言：拒绝后完全不进 runCore / hermes 通道。
    expect(mockHub.prompt).not.toHaveBeenCalled()
    expect(mockHub.newSession).not.toHaveBeenCalled()
    // 不留任何消息（连用户气泡都不加）。
    expect(api().messages).toHaveLength(0)
  })

  it('trim 宽容：前后空白仍是恰好 /reset（弹确认）', async () => {
    await mount()
    await act(async () => {
      const p = api().send('  /reset  ', ph.plugin.settings.llm)
      await Promise.resolve()
      api().answerConfirm(false)
      await p
    })
    await flushMicro()

    expect(mockHub.prompt).not.toHaveBeenCalled()
    expect(api().messages).toHaveLength(0)
  })

  it('带参 /reset xxx 不是恰好 /reset —— 不拦截，原样透传不弹确认', async () => {
    await mount()
    await act(async () => {
      await api().send('/reset now', ph.plugin.settings.llm)
    })
    await flushMicro()

    // 恰好 '/reset' 才走确认前置；带参按 slashPassthrough 原样透传。
    expect(api().pendingConfirm).toBeNull()
    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    expect(mockHub.prompt.mock.calls[0][2]).toBe('/reset now')
  })

  it('hermes 轮其他命令不受 reset 拦截影响（/help 原样透传）', async () => {
    await mount()
    await act(async () => {
      await api().send('/help', ph.plugin.settings.llm)
    })
    await flushMicro()

    expect(ph.confirm).not.toHaveBeenCalled()
    expect(mockHub.prompt).toHaveBeenCalledTimes(1)
    expect(mockHub.prompt.mock.calls[0][2]).toBe('/help')
  })
})
