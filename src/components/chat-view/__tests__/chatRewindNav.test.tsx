/**
 * @jest-environment jsdom
 *
 * 双根回归（追加77 排查收尾）：隐藏 host（AgentHost）持有 useAgent，
 * Chat 面板经 AgentBridge 订阅——两棵独立的 React 树。本地命令造三轮
 * 对话后回溯，断言 Chat 渲染出的浮动导航节点（.UNagent-nav-node）
 * 与消息气泡同步收缩。这层要是红的，就是「删除/回溯后导航栏没变化」
 * 的用户报告根因；绿则整条渲染链（host → bridge → Chat → nav）无罪。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { App } from 'obsidian'

import { PluginProvider } from '../../../contexts/plugin-context'
import { SettingsProvider } from '../../../contexts/settings-context'
import { DEFAULT_SETTINGS, cloneSettings } from '../../../settings/settings'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'
import { Chat } from '../Chat'
import { ErrorBoundary } from '../ErrorBoundary'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

function mkApp(): App {
  const store: Record<string, string> = {}
  const isDir = (p: string): boolean =>
    Object.keys(store).some((k) => k.startsWith(`${p}/`))
  return {
    vault: {
      adapter: {
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
      },
    },
  } as unknown as App
}

function mkPlugin(bridge: AgentBridge): ObsidianAI {
  return {
    app: mkApp(),
    agentBridge: bridge,
    settings: cloneSettings(DEFAULT_SETTINGS),
    saveSettings: async () => undefined,
    addSettingsChangeListener: () => () => undefined,
    addDataChangeListener: () => () => undefined,
    pokeDataReload: () => undefined,
    confirm: async () => true,
    openSettingsTab: () => undefined,
    setComposerFocusHandler: () => undefined,
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
    agents: { getAll: () => [], getByName: () => null },
  } as unknown as ObsidianAI
}

// 与 AgentHost.tsx 的 Publisher 同款：每次 commit 后发布最新 API。
const Publisher = ({ bridge }: { bridge: AgentBridge }) => {
  const api = useAgent()
  React.useEffect(() => {
    bridge.publish(api)
  })
  return null
}

describe('双根渲染：回溯后 Chat 的浮动导航节点同步收缩', () => {
  let hostRoot: Root
  let chatRoot: Root
  let chatEl: HTMLDivElement
  let bridge: AgentBridge
  let plugin: ObsidianAI

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    bridge = new AgentBridge()
    plugin = mkPlugin(bridge)
    hostRoot = createRoot(document.createElement('div'))
    chatEl = document.createElement('div')
    document.body.appendChild(chatEl)
    chatRoot = createRoot(chatEl)
    await act(async () => {
      hostRoot.render(
        <PluginProvider plugin={plugin}>
          <ErrorBoundary kind="agent-host">
            <Publisher bridge={bridge} />
          </ErrorBoundary>
        </PluginProvider>,
      )
    })
    await act(async () => {
      chatRoot.render(
        <ErrorBoundary kind="chat-root">
          <PluginProvider plugin={plugin}>
            <SettingsProvider plugin={plugin}>
              <Chat />
            </SettingsProvider>
          </PluginProvider>
        </ErrorBoundary>,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
  })

  afterEach(() => {
    act(() => {
      hostRoot.unmount()
      chatRoot.unmount()
    })
    chatEl.remove()
  })

  const navNodes = () => chatEl.querySelectorAll('.UNagent-nav-node')
  const bubbles = () => chatEl.querySelectorAll('[data-ai-msg-id]')

  it('三轮 → 回溯到第 2 轮：气泡与导航节点一起减少', async () => {
    for (const cmd of ['/think off', '/think think', '/think off']) {
      await act(async () => {
        await api().send(cmd, plugin.settings.llm)
      })
    }
    expect(bubbles()).toHaveLength(6)
    expect(navNodes()).toHaveLength(3)

    const pt2 = api().messages.find(
      (m) => m.role === 'user' && m.content?.startsWith('/think think'),
    )
    expect(pt2).toBeDefined()
    await act(async () => {
      const err = await api().rewindTo(api().messages.indexOf(pt2!))
      expect(err).toBe('')
    })

    // 气泡：两轮 4 条 + 回溯 note = 5；导航：只剩两个问题的短横。
    expect(bubbles()).toHaveLength(5)
    expect(navNodes()).toHaveLength(2)
  })
})
