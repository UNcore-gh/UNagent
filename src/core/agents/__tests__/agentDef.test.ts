// Sub-agent persona parsing (多 Agent 体系): frontmatter contract, fallbacks,
// tolerance for broken files, the persona size cap, and the registry shape.
// Pure functions only — no obsidian runtime.

import {
  AgentRegistry,
  MAX_AGENT_PERSONA_CHARS,
  parseAgentDef,
} from '../agentDef'

const FULL_NOTE = `---
name: 追问启发
emoji: 🎓
description: 就当前笔记层层追问，难度递进
model: qwen-plus
---
你是一位苏格拉底式的追问教练。
先读进度笔记再提问。`

describe('parseAgentDef', () => {
  it('parses full frontmatter + persona body', () => {
    const def = parseAgentDef(FULL_NOTE, {
      source: 'user',
      path: 'AI 助手/agents/追问启发/subagent.md',
    })
    expect(def).not.toBeNull()
    expect(def!.name).toBe('追问启发')
    expect(def!.emoji).toBe('🎓')
    expect(def!.description).toBe('就当前笔记层层追问，难度递进')
    expect(def!.modelOverride).toBe('qwen-plus')
    expect(def!.body).toContain('苏格拉底式的追问教练')
    expect(def!.source).toBe('user')
    expect(def!.path).toBe('AI 助手/agents/追问启发/subagent.md')
  })

  it('falls back to the folder name without a name frontmatter (追加75)', () => {
    // 追加75: 扫描只喂 subagent.md 进来，所以无 name frontmatter 时用
    // 文件夹名兜底（一代理一文件夹，文件夹名即子代理名）。
    const def = parseAgentDef('人设正文，没有 frontmatter。', {
      source: 'user',
      path: 'AI 助手/agents/写作教练/subagent.md',
      fallbackName: '写作教练',
    })
    expect(def).not.toBeNull()
    expect(def!.name).toBe('写作教练')
  })

  it('prefers the frontmatter name over the folder name', () => {
    const def = parseAgentDef('---\nname: 改名了\n---\n正文', {
      source: 'user',
      fallbackName: '文件夹名',
    })
    expect(def!.name).toBe('改名了')
  })

  it('still requires a name when no folder name is given (追加74)', () => {
    // 无 frontmatter 的正文 —— 像子代理产物文件（进度笔记等），不是 agent；
    // 扫描不会把这类文件喂进来，但解析器保持防御。
    expect(
      parseAgentDef('正文就是人设。', { source: 'user' }),
    ).toBeNull()
    expect(
      parseAgentDef('# 教练\n\n只问不答。', { source: 'user' }),
    ).toBeNull()
  })

  it('skips agent-produced data files like 进度.md (追加74)', () => {
    // 真实场景：追问启发子代理的产物文件没有 frontmatter，必须被忽略。
    const progressNote = `# 追问启发 · 进度

- 当前难度档位：1
- 已问过的主题：无
- 最近几轮要点：无
`
    expect(
      parseAgentDef(progressNote, { source: 'user' }),
    ).toBeNull()
  })

  it('rejects frontmatter without a name even when it has other fields', () => {
    expect(
      parseAgentDef('---\nemoji: 🎓\n---\n正文', { source: 'user' }),
    ).toBeNull()
    expect(
      parseAgentDef('---\ndescription: 只有描述\n---\n正文', {
        source: 'user',
      }),
    ).toBeNull()
  })

  it('returns null for an empty note (neither body nor description)', () => {
    expect(parseAgentDef('', { source: 'user' })).toBeNull()
    expect(
      parseAgentDef('   \n  ', { source: 'user' }),
    ).toBeNull()
  })

  it('caps an oversized persona body', () => {
    const long = '问'.repeat(MAX_AGENT_PERSONA_CHARS + 500)
    const def = parseAgentDef(`---\nname: 话痨\n---\n${long}`, {
      source: 'user',
    })
    expect(def!.body.length).toBe(MAX_AGENT_PERSONA_CHARS)
  })

  it('parses engine: hermes (case-insensitive) — 补刀·五十五', () => {
    const def = parseAgentDef(
      '---\nname: 重活工\nengine: Hermes\n---\n人设正文',
      { source: 'user' },
    )
    expect(def!.engine).toBe('hermes')
  })

  it('engine defaults to undefined and unknown values fall back silently', () => {
    // 常规代理没有 engine。
    const plain = parseAgentDef(FULL_NOTE, { source: 'user' })
    expect(plain!.engine).toBeUndefined()
    // 拼错的引擎名不让代理失效——静默回落常规 LLM。
    const typo = parseAgentDef(
      '---\nname: 写错了\nengine: hermss\n---\n正文',
      { source: 'user' },
    )
    expect(typo!.engine).toBeUndefined()
  })

  it('tolerates a broken frontmatter block (skipped, not thrown)', () => {
    // No closing '---' — splitFrontmatter yields no frontmatter; without a
    // name marker the file is not a persona note, so it is skipped.
    expect(
      parseAgentDef('---\nname: 坏的\n没有结束线', { source: 'user' }),
    ).toBeNull()
  })
})

describe('AgentRegistry', () => {
  const mk = (name: string, source: 'builtin' | 'user') => ({
    name,
    description: `${name} 的描述`,
    body: `${name} 的人设`,
    source,
  })

  it('registers, looks up by name, and lists all', () => {
    const reg = new AgentRegistry()
    reg.register(mk('a', 'user'))
    reg.registerAll([mk('b', 'user'), mk('c', 'builtin')])
    expect(reg.getAll()).toHaveLength(3)
    expect(reg.getByName('b')?.name).toBe('b')
    expect(reg.getByName(' missing ')).toBeUndefined()
  })

  it('removes by source without touching the others', () => {
    const reg = new AgentRegistry()
    reg.registerAll([mk('a', 'user'), mk('b', 'builtin')])
    reg.removeBySource('user')
    expect(reg.getAll().map((d) => d.name)).toEqual(['b'])
  })

  it('same-name re-register replaces (reload idempotence)', () => {
    const reg = new AgentRegistry()
    reg.register({ ...mk('a', 'user'), body: '旧人设' })
    reg.register({ ...mk('a', 'user'), body: '新人设' })
    expect(reg.getAll()).toHaveLength(1)
    expect(reg.getByName('a')?.body).toBe('新人设')
  })
})
