/**
 * @jest-environment jsdom
 *
 * M2-T8 接线：hermes 轮末思考兜底（flushHermesThinking）。
 *
 * 帧流结束时仍有未归属任何工具的 thinking，不再无声丢弃——固化成一张
 * 「思考」卡（固定 callId，幂等 upsert）。thinking 已被后续工具消费的常规
 * 轮不产生兜底卡。hub 全程用 fake（jest.mock hermesHub），绝不真起进程。
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
import { HERMES_THOUGHT_CALL_ID } from '../../../core/hermes/blockMapper'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

/* ── fake hub：按用例切换帧脚本，绝不真起 hermes ───────────────────── */

let promptScript: Array<Record<string, unknown>> = []

const mockHub = {
  setPermissionHandler: jest.fn(),
  subscribe: jest.fn((_cb: () => void) => () => undefined),
  answerPermission: jest.fn(),
  denyPendingPermissions: jest.fn(),
  getSessionStates: jest.fn(() => null),
  // M2-T4: 通告命令缓存读口（本套件无通告帧 → 空数组）。
  getAdvertisedCommands: jest.fn(() => []),
  newSession: jest.fn(async () => ({ sessionId: 'sess-flush-1' })),
  loadSession: jest.fn(async () => false),
  forkSession: jest.fn(async () => ({ sessionId: 'sess-flush-forked' })),
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
      for (const frame of promptScript) onUpdate(frame)
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

function mkPluginHarness(harness: AppHarness) {
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
      getAll: () => [HERMES_AGENT],
      getByName: (name: string) =>
        name === HERMES_AGENT.name ? HERMES_AGENT : null,
    },
  } as unknown as ObsidianAI
  return { plugin }
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

describe('M2-T8 接线：hermes 轮末思考兜底', () => {
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
    promptScript = []
    bridge = new AgentBridge()
    const harness = mkAppHarness()
    ph = mkPluginHarness(harness)
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

  it('思考后无工具：轮末兜底把残留 thinking 固化成「思考」卡', async () => {
    promptScript = [
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '这题得换个角度想' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '答案是 42。' },
      },
    ]
    await act(async () => {
      await api().send('想想这个问题', ph.plugin.settings.llm)
    })
    await flushMicro()

    const msgs = api().messages
    const reply = msgs[msgs.length - 1]
    expect(reply.role).toBe('assistant')
    expect(reply.blocks).toEqual([
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

  it('思考被后续工具消费：不产生兜底卡（既有归属语义不变）', async () => {
    promptScript = [
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '先查一下文件' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read: a.md',
        kind: 'read',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: { text: '内容' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '查完了。' },
      },
    ]
    await act(async () => {
      await api().send('看看文件', ph.plugin.settings.llm)
    })
    await flushMicro()

    const reply = api().messages[api().messages.length - 1]
    const blocks = reply.blocks ?? []
    expect(
      blocks.some(
        (b) => b.kind === 'tool' && b.callId === HERMES_THOUGHT_CALL_ID,
      ),
    ).toBe(false)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      callId: 'tc-1',
      thinking: '先查一下文件',
    })
  })

  it('重复轮次：每轮各自兜底一次，同轮内不产生重复思考卡', async () => {
    promptScript = [
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '再想一轮' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '好。' },
      },
    ]
    await act(async () => {
      await api().send('第一轮', ph.plugin.settings.llm)
    })
    await flushMicro()
    await act(async () => {
      await api().send('第二轮', ph.plugin.settings.llm)
    })
    await flushMicro()

    const msgs = api().messages
    const replies = msgs.filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(2)
    for (const reply of replies) {
      const thoughtCards = (reply.blocks ?? []).filter(
        (b) => b.kind === 'tool' && b.callId === HERMES_THOUGHT_CALL_ID,
      )
      expect(thoughtCards).toHaveLength(1)
      expect(thoughtCards[0]).toMatchObject({
        state: 'done',
        thinking: '再想一轮',
      })
    }
  })
})
