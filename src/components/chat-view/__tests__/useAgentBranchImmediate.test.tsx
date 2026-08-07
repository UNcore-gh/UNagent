/**
 * @jest-environment jsdom
 *
 * 追加89 回归：改动必须即时生效，不能「等一会儿 / 重开视图 / 重载插件」。
 *
 * 用户报告的代表性症状：分支对话后要等上一会儿，分支才出现在对话管理
 * 列表里。根因：convList 只在 persistNow 落盘成功后更新，而分支把落盘
 * 押在 debounced autosave 上——branchChild 甚至不改 messages，autosave
 * 根本不触发（分支在下一次发消息前既不上列表也不落盘，此刻关掉
 * Obsidian 分支直接丢失）。修复 = 乐观插入 meta + 分支时立即 persist。
 *
 * 同款问题：数据文件夹（aiFolder）设置改动旧实现只在 boot 读一次，设置
 * 页注明「重新打开对话视图后生效」。修复 = useAgent 订阅 settings 变更，
 * 文件夹一换立刻重载索引。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { App } from 'obsidian'

import { PluginProvider } from '../../../contexts/plugin-context'
import {
  DEFAULT_SETTINGS,
  cloneSettings,
} from '../../../settings/settings'
import type { ObsidianAISettings } from '../../../settings/settings'
import type { StoredConversation } from '../../../utils/conversationStore'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

/** 内存 adapter fake（与 useAgentRewindFlow 同款：只给 adapter，不给 vault
 *  索引 API）。 */
function mkAppHarness(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
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
  return { app, store }
}

type AppHarness = ReturnType<typeof mkAppHarness>

/** fake plugin：settings/data 两个监听注册表做成真的，测试可以主动触发。 */
function mkPluginHarness(harness: AppHarness) {
  const settingsListeners = new Set<(s: ObsidianAISettings) => void>()
  const dataListeners = new Set<() => void>()
  const plugin = {
    app: harness.app,
    settings: cloneSettings(DEFAULT_SETTINGS),
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
    agents: { getAll: () => [], getByName: () => null },
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

/** 微任务冲刷：persistNow 的写盘链全是 adapter promise，不碰 timer。 */
const flushMicro = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

describe('追加89：分支对话即时上列表 + 即时落盘', () => {
  let root: Root
  let bridge: AgentBridge
  let harness: AppHarness
  let ph: PluginHarness

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    bridge = new AgentBridge()
    harness = mkAppHarness()
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
  })

  afterEach(() => {
    act(() => root.unmount())
    jest.useRealTimers()
  })

  const seedTwoTurns = async (): Promise<string> => {
    for (const cmd of ['/think off', '/think think']) {
      await act(async () => {
        await api().send(cmd, ph.plugin.settings.llm)
      })
    }
    // autosave（600ms）把父对话落盘并分配 convId。
    await act(async () => {
      await jest.advanceTimersByTimeAsync(700)
    })
    const id = api().convId
    expect(id).toBeTruthy()
    return id as string
  }

  it('branchChild：不推进时钟，分支立即出现在对话管理列表', async () => {
    const parentId = await seedTwoTurns()

    let result: string | 'empty' | null = null
    await act(async () => {
      result = await api().branchChild()
    })
    expect(typeof result).toBe('string')

    // 关键断言：没有 advanceTimersByTime——列表即时可见。
    const rows = api().conversations
    expect(rows).toHaveLength(2)
    const child = rows.find((r) => r.current)
    expect(child).toBeDefined()
    expect(child!.meta.parentId).toBe(parentId)
    expect(rows.some((r) => r.meta.id === parentId)).toBe(true)

    // 落盘也不等 autosave：冲刷微任务后子对话文件 + 索引已写实
    //（旧实现此刻关掉 Obsidian 分支直接丢失）。
    await flushMicro()
    const childId = api().convId as string
    expect(childId).not.toBe(parentId)
    const childPath = `AI 助手/conversations/${childId}.json`
    expect(harness.store[childPath]).toBeDefined()
    const saved = JSON.parse(harness.store[childPath]) as StoredConversation
    expect(saved.parentId).toBe(parentId)
    expect(saved.messageCount).toBe(4) // 两轮 × 2 条
    const index = JSON.parse(harness.store['AI 助手/conversations/index.json'])
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining([parentId, childId]),
    )
  })

  it('branchFrom：管理页分支同样即时上列表 + 即时落盘', async () => {
    const parentId = await seedTwoTurns()

    let result: string | 'empty' | null = null
    await act(async () => {
      result = await api().branchFrom(parentId)
    })
    expect(typeof result).toBe('string')

    // 不推进时钟：分支行即时可见（旧实现要等 600ms autosave + 磁盘往返）。
    const child = api().conversations.find((r) => r.current)
    expect(child).toBeDefined()
    expect(child!.meta.parentId).toBe(parentId)

    await flushMicro()
    const childId = api().convId as string
    const saved = JSON.parse(
      harness.store[`AI 助手/conversations/${childId}.json`],
    ) as StoredConversation
    expect(saved.parentId).toBe(parentId)
    expect(saved.messageCount).toBe(4)
  })

  it('空对话 branchChild 返回 empty，不产生列表条目', async () => {
    let result: string | 'empty' | null = null
    await act(async () => {
      result = await api().branchChild()
    })
    expect(result).toBe('empty')
    expect(api().conversations).toHaveLength(0)
  })
})

describe('追加89：数据文件夹设置改动即时生效', () => {
  let root: Root
  let bridge: AgentBridge
  let harness: AppHarness
  let ph: PluginHarness

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    bridge = new AgentBridge()
    // 新文件夹里预置一条索引——模拟 migrateDataFolder 之后的目的地。
    harness = mkAppHarness({
      '新夹/conversations/index.json': JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'seed1',
            title: '迁移过来的对话',
            createdAt: 1,
            updatedAt: 1,
            parentId: null,
            parentMessageCount: 0,
            messageCount: 2,
          },
        ],
      }),
    })
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
  })

  afterEach(() => {
    act(() => root.unmount())
    jest.useRealTimers()
  })

  it('aiFolder 一换，对话管理列表立即重载新文件夹的索引', async () => {
    // boot 读的是默认「AI 助手」（空）。
    expect(api().conversations).toHaveLength(0)

    const next = cloneSettings(ph.plugin.settings)
    next.general.aiFolder = '新夹'
    await act(async () => {
      ph.notifySettings(next)
    })
    await flushMicro()

    const rows = api().conversations
    expect(rows).toHaveLength(1)
    expect(rows[0].meta.id).toBe('seed1')
    expect(rows[0].meta.title).toBe('迁移过来的对话')
  })

  it('其他设置变更不触发列表重载（folder 未变则保持现状）', async () => {
    const next = cloneSettings(ph.plugin.settings)
    next.general.assistantName = '新名字'
    await act(async () => {
      ph.notifySettings(next)
    })
    await flushMicro()
    expect(api().conversations).toHaveLength(0)
  })
})

describe('追加89：注册表热重载通知驱动 memo 重算', () => {
  it('dataTick 是 useAgent 暴露面的一部分（agents memo 依赖它）', async () => {
    // 结构回归：useAgent 挂载时订阅 addDataChangeListener——fake 若是缺
    // 方法会在 mount 时抛错，本文件所有用例都会红；这里显式跑一次空挂载。
    jest.useFakeTimers()
    try {
      const bridge = new AgentBridge()
      const harness = mkAppHarness()
      const ph = mkPluginHarness(harness)
      const container = document.createElement('div')
      const root = createRoot(container)
      await act(async () => {
        root.render(
          <PluginProvider plugin={ph.plugin}>
            <Publisher bridge={bridge} />
          </PluginProvider>,
        )
      })
      await act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })
      // notifyData 不应抛错（订阅已建立）。
      await act(async () => {
        ph.notifyData()
      })
      expect(bridge.getSnapshot()).not.toBeNull()
      act(() => root.unmount())
    } finally {
      jest.useRealTimers()
    }
  })
})
