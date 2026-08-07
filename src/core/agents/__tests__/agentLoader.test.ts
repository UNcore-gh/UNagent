// Sub-agent loading (追加75: 一代理一文件夹，与 skills 同构): only
// `<agents>/<folder>/subagent.md` files become agents — the agent name is
// the folder name (frontmatter name wins when present), and everything else
// (loose .md notes left over from the old layout, agent data files inside
// the folder) is ignored. Adapter-level fake, same shape as the
// evolutionSetup tests.

import { App } from 'obsidian'
import { agentsFolder, loadAgentDefs } from '../agentLoader'

function mkApp(
  initial: Record<string, string> = {},
  dirs: string[] = [],
): { app: App; store: Record<string, string> } {
  const store: Record<string, string> = { ...initial }
  const dirSet = new Set<string>(dirs)
  const isDir = (p: string): boolean =>
    dirSet.has(p) || Object.keys(store).some((k) => k.startsWith(`${p}/`))
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
        mkdir: async (p: string) => {
          dirSet.add(p)
        },
        remove: async (p: string) => {
          delete store[p]
        },
        rmdir: async (p: string) => {
          dirSet.delete(p)
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
          for (const d of dirSet) {
            if (!d.startsWith(`${p}/`)) continue
            const rest = d.slice(p.length + 1)
            if (!rest.includes('/')) folders.add(d)
          }
          return { files, folders: [...folders] }
        },
      },
    },
  } as unknown as App
  return { app, store }
}

describe('loadAgentDefs', () => {
  it('returns an empty list when the folder is missing', async () => {
    const { app } = mkApp({})
    expect(await loadAgentDefs(app, agentsFolder('AI 助手'))).toEqual([])
  })

  it('loads one agent per folder holding a subagent.md', async () => {
    const { app } = mkApp({
      'AI 助手/agents/追问启发/subagent.md': `---
name: 追问启发
emoji: 🎓
description: 层层追问
---
人设正文`,
    })
    const defs = await loadAgentDefs(app, agentsFolder('AI 助手'))
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('追问启发')
    expect(defs[0].path).toBe('AI 助手/agents/追问启发/subagent.md')
  })

  it('uses the folder name when subagent.md has no name frontmatter', async () => {
    const { app } = mkApp({
      'AI 助手/agents/写作教练/subagent.md': '人设正文，没有 frontmatter。',
    })
    const defs = await loadAgentDefs(app, agentsFolder('AI 助手'))
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('写作教练')
  })

  it('ignores agent data files inside the folder (进度.md etc.)', async () => {
    const { app } = mkApp({
      'AI 助手/agents/追问启发/subagent.md': '---\nname: 追问启发\n---\n人设',
      'AI 助手/agents/追问启发/进度.md': '# 追问启发 · 进度\n\n- 档位：1\n',
      'AI 助手/agents/追问启发/notes.txt': '随手记',
    })
    const defs = await loadAgentDefs(app, agentsFolder('AI 助手'))
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('追问启发')
  })

  it('ignores loose .md files left over from the old layout', async () => {
    const { app } = mkApp({
      'AI 助手/agents/旧布局残留.md': '---\nname: 残留\n---\n旧文件',
      'AI 助手/agents/追问启发/subagent.md': '---\nname: 追问启发\n---\n人设',
    })
    const defs = await loadAgentDefs(app, agentsFolder('AI 助手'))
    expect(defs.map((d) => d.name)).toEqual(['追问启发'])
  })

  it('skips folders without a subagent.md', async () => {
    const { app } = mkApp({
      'AI 助手/agents/空文件夹/subagent.bak': '不认识的扩展名',
      'AI 助手/agents/追问启发/subagent.md': '---\nname: 追问启发\n---\n人设',
    })
    const defs = await loadAgentDefs(app, agentsFolder('AI 助手'))
    expect(defs.map((d) => d.name)).toEqual(['追问启发'])
  })

  it('never throws on a broken subagent.md (folder name fallback)', async () => {
    const { app } = mkApp({
      'AI 助手/agents/坏的/subagent.md': '---\nname: 坏的\n没有结束线',
      'AI 助手/agents/追问启发/subagent.md': '---\nname: 追问启发\n---\n人设',
    })
    // 追加75: 扫描只喂 subagent.md 进来，无 frontmatter name 时文件夹名
    // 兜底——坏文件不会抛异常，也不会静默消失。
    const defs = await loadAgentDefs(app, agentsFolder('AI 助手'))
    expect(defs.map((d) => d.name)).toEqual(['坏的', '追问启发'])
  })
})
