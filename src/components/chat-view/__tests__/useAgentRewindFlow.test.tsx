/**
 * @jest-environment jsdom
 *
 * 端到端回归（追加77 排查）：删除/回溯后浮动导航不更新的用户报告。
 * ConversationNav 的节点纯粹派生自 messages prop（conversationNavUpdate
 * 已锁定），所以这里锁定上游状态管道：真 useAgent 挂进隐藏 host 同款
 * Publisher，经 AgentBridge 发布；用三条本地 /think 命令造三轮对话
 *（斜杠命令不碰 LLM），然后回溯 / 删除当前对话，断言订阅端拿到的
 * messages 真的变短——任何一环（setMessages / messagesRef / publish /
 * getSnapshot）残留旧数组，这里立刻红。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { App } from 'obsidian'

import { PluginProvider } from '../../../contexts/plugin-context'
import { DEFAULT_SETTINGS, cloneSettings } from '../../../settings/settings'
import type { StoredConversation } from '../../../utils/conversationStore'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

/** 与 conversationStore.test.ts 同款：内存 adapter fake（只给 adapter，不给 vault 索引 API）。
 * 额外暴露 store 与 failNextWrites——追加77 回归需要模拟「回溯落盘失败」。 */
function mkAppHarness(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  let writesToFail = 0
  const isDir = (p: string): boolean =>
    Object.keys(store).some((k) => k.startsWith(`${p}/`))
  const app = {
    vault: {
      adapter: {
        exists: async (p: string) => p in store || isDir(p),
        read: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p]
        },
        write: async (p: string, data: string) => {
          if (writesToFail > 0) {
            writesToFail -= 1
            throw new Error('simulated disk hiccup')
          }
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
  return {
    app,
    store,
    failNextWrites: (n: number) => {
      writesToFail = n
    },
  }
}

type AppHarness = ReturnType<typeof mkAppHarness>

function mkPlugin(harness: AppHarness): ObsidianAI {
  return {
    app: harness.app,
    settings: cloneSettings(DEFAULT_SETTINGS),
    saveSettings: async () => undefined,
    addSettingsChangeListener: () => () => undefined,
    addDataChangeListener: () => () => undefined,
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
    agents: { getAll: () => [], getByName: () => null },
  } as unknown as ObsidianAI
}

const Publisher = ({ bridge }: { bridge: AgentBridge }) => {
  const api = useAgent()
  React.useEffect(() => {
    bridge.publish(api)
  })
  return null
}

describe('useAgent → AgentBridge 状态管道：回溯 / 删除后 messages 必须更新', () => {
  let root: Root
  let bridge: AgentBridge
  let harness: AppHarness
  let plugin: ObsidianAI

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }
  const userTurns = (): number =>
    api().messages.filter((m) => m.role === 'user' && !m.ephemeral).length

  beforeEach(async () => {
    bridge = new AgentBridge()
    harness = mkAppHarness()
    plugin = mkPlugin(harness)
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginProvider plugin={plugin}>
          <Publisher bridge={bridge} />
        </PluginProvider>,
      )
    })
    // 等 boot（loadIndex）跑完再动手。
    await act(async () => {
      await Promise.resolve()
    })
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('回溯到第 2 轮：第 3 轮从订阅端可见的 messages 里消失', async () => {
    // 三轮本地命令对话（/think 不碰 LLM，只回显 note）。
    for (const cmd of ['/think off', '/think think', '/think off']) {
      await act(async () => {
        await api().send(cmd, plugin.settings.llm)
      })
    }
    expect(userTurns()).toBe(3)

    // 回溯到第 2 轮（追加70 语义：第 2 轮保留，移除其后）。
    const pt2 = api().messages.find(
      (m) => m.role === 'user' && !m.ephemeral && m.content?.startsWith('/think think'),
    )
    expect(pt2).toBeDefined()
    let err = ''
    await act(async () => {
      err = await api().rewindTo(api().messages.indexOf(pt2!))
    })
    expect(err).toBe('')

    // 订阅端（= Chat 面板的数据源）必须只剩两轮 + 回溯 note。
    expect(userTurns()).toBe(2)
    const last = api().messages[api().messages.length - 1]
    expect(last.role).toBe('assistant')
  })

  it('删除当前对话：订阅端的 messages 清空', async () => {
    jest.useFakeTimers()
    try {
      await act(async () => {
        await api().send('/think off', plugin.settings.llm)
      })
      // 本地命令走 debounced autosave（600ms）才落盘分配 convId。
      await act(async () => {
        await jest.advanceTimersByTimeAsync(700)
      })
      const id = api().convId
      expect(id).toBeTruthy()
      await act(async () => {
        await api().deleteConversation(id!)
      })
      expect(api().messages).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  // 追加77 回归：rewindTo 在干净状态（上一轮已落盘、dirty=false）直接
  // persistNow，写盘失败时 catch 依赖「保持 dirty → autosave 重试」，但
  // dirty 本是 false → 截断结果永不重试落盘 → 重启/切换会话后旧轮次从
  // 磁盘复活，浮动导航重新显示已被移除的轮次。修复 = persistNow 前置 dirty。
  it('回溯落盘失败时 dirty 兜底：autosave 重试把截断结果写回磁盘', async () => {
    jest.useFakeTimers()
    try {
      for (const cmd of ['/think off', '/think think', '/think off']) {
        await act(async () => {
          await api().send(cmd, plugin.settings.llm)
        })
      }
      // 先让 autosave 把完整对话落盘（分配 convId，随后 dirty → false）。
      await act(async () => {
        await jest.advanceTimersByTimeAsync(700)
      })
      const id = api().convId
      expect(id).toBeTruthy()
      const path = `AI 助手/conversations/${id}.json`
      const readSaved = (): StoredConversation =>
        JSON.parse(harness.store[path]) as StoredConversation
      expect(readSaved().messageCount).toBe(6) // 三轮 × 2 条

      // 模拟回溯那一次落盘失败（saveConversation 先写 conv 文件再写 index，
      // 失败一次正好命中 conv 文件）。
      harness.failNextWrites(1)
      const pt2 = api().messages.find(
        (m) => m.role === 'user' && !m.ephemeral && m.content?.startsWith('/think think'),
      )
      expect(pt2).toBeDefined()
      await act(async () => {
        const err = await api().rewindTo(api().messages.indexOf(pt2!))
        expect(err).toBe('')
      })
      // 屏幕上是截断列表（两轮 + note），磁盘仍是旧的完整对话——
      // 只有 autosave 重试能把截断结果救回来。
      expect(userTurns()).toBe(2)
      expect(readSaved().messageCount).toBe(6)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(700)
      })
      // 重试成功：磁盘收敛到截断后的列表（两轮 4 条 + 回溯 note）。
      const after = readSaved()
      expect(after.messageCount).toBe(5)
      const lastBlock = after.messages[4].blocks?.[0]
      expect(lastBlock?.kind === 'text' ? lastBlock.text : '').toContain('已回溯到第 2 轮')
    } finally {
      jest.useRealTimers()
    }
  })
})
