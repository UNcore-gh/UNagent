/**
 * @jest-environment jsdom
 *
 * 评审修复回归：新对话第 1 轮的 pushUndo 必须拿到非空 convId。
 *
 * 修复前：会话 id 在 persistNow 首次落盘时才生成，第 1 轮工具执行时
 * convIdRef.current === null → undo 条目缺会话戳 → 回溯的 countFor /
 * rollbackFrom（按 convId 精确比较）永远匹配不到，第 1 轮的 AI 修改回溯
 * 时不回滚。修复后：runCore 开始处（工具执行前）即为非 ephemeral 轮提前
 * 分配 id。本测试用 scripted provider 跑一个真实工具轮，断言
 * undoStack.push 收到的 meta.convId 非空。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { App } from 'obsidian'

import { PluginProvider } from '../../../contexts/plugin-context'
import { DEFAULT_SETTINGS, cloneSettings } from '../../../settings/settings'
import type { StreamChunk, LLMProvider } from '../../../core/llm/base'
import type { Tool, ToolRunResult } from '../../../core/agent/types'
import type ObsidianAI from '../../../main'
import { AgentBridge } from '../agentBridge'
import type { AgentApi } from '../useAgent'
import { useAgent } from '../useAgent'

const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

// 每个 streamChat 调用回放一段脚本（最后一段重复）。第 1 轮要求执行
// fake_touch 工具，第 2 轮直接收尾。
const mockScripts: StreamChunk[][] = [
  [
    {
      type: 'tool-call',
      toolCall: { index: 0, id: 'call-1', name: 'fake_touch', arguments: '{}' },
    },
    // finish 必须是 tool-calls，agentRunner 才会执行工具（'stop' = 终答）。
    { type: 'finish', reason: 'tool-calls' },
  ],
  [{ type: 'text', text: '好的，已完成。' }, { type: 'finish', reason: 'stop' }],
]

jest.mock('../../../core/llm/manager', () => {
  let turn = 0
  const provider: LLMProvider = {
    id: 'scripted',
    async *streamChat() {
      const script = mockScripts[Math.min(turn, mockScripts.length - 1)]
      turn++
      for (const chunk of script) yield chunk
    },
  }
  return { createLLMProvider: () => provider }
})

function mkAppHarness() {
  const store: Record<string, string> = {}
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

/** 执行即 pushUndo 的假工具（非破坏性，无确认）。 */
function mkTouchTool(): Tool {
  return {
    metadata: {
      name: 'fake_touch',
      description: 'fake touch',
      category: 'write',
      destructive: false,
      requiresVault: true,
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, ctx): Promise<ToolRunResult> {
      ctx.pushUndo('假操作', async () => undefined)
      return { ok: true, summary: 'done', output: {} }
    },
  }
}

function mkPlugin(harness: AppHarness, pushSpy: jest.Mock): ObsidianAI {
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
      push: pushSpy,
      onChange: () => () => undefined,
      canUndo: () => false,
      undoLast: async () => undefined,
      lastLabel: () => '',
    },
    registry: { getAll: () => [mkTouchTool()] },
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

describe('新对话第 1 轮 pushUndo 拿到非空 convId（评审修复）', () => {
  let root: Root
  let bridge: AgentBridge

  const api = (): AgentApi => {
    const snapshot = bridge.getSnapshot()
    if (!snapshot) throw new Error('host 还没发布 agent API')
    return snapshot
  }

  beforeEach(async () => {
    bridge = new AgentBridge()
    const harness = mkAppHarness()
    const pushSpy = jest.fn()
    const plugin = mkPlugin(harness, pushSpy)
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PluginProvider plugin={plugin}>
          <Publisher bridge={bridge} />
        </PluginProvider>,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    // 挂到容器上供用例取用。
    ;(bridge as unknown as { __pushSpy?: jest.Mock }).__pushSpy = pushSpy
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('第 1 轮工具执行的 undo 条目带非空 convId（= 当前会话 id）', async () => {
    // 普通文本 → runCore（真实工具轮，scripted provider）。
    await act(async () => {
      await api().send('帮我做个假操作', plugin_llm(api()))
    })

    const pushSpy = (bridge as unknown as { __pushSpy: jest.Mock }).__pushSpy
    expect(pushSpy).toHaveBeenCalledTimes(1)
    // push(label, revert, meta, data?) —— meta 里的会话戳必须已分配。
    const meta = pushSpy.mock.calls[0][2] as { convId?: string; turnNo?: number }
    expect(meta.convId).toBeTruthy()
    expect(meta.turnNo).toBe(1)
    expect(meta.convId).toBe(api().convId)
  })
})

// send 需要 LLMSettings；直接从快照拿不便（api 不导出 settings），用默认值。
function plugin_llm(_api: AgentApi) {
  return cloneSettings(DEFAULT_SETTINGS).llm
}
