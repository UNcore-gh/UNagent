// System prompt assembly, focused on the skills section contract.

import type { Skill } from '../../skills/types'
import { buildSystemPrompt, formatToday } from '../systemPrompt'
import type { Tool } from '../types'

const fakeTool: Tool = {
  metadata: {
    name: 'demo_tool',
    description: 'd',
    category: 'read',
    destructive: false,
    requiresVault: true,
    parameters: { type: 'object', properties: {} },
  },
  run: async () => ({ ok: true, summary: '', output: {} }),
}

const lazySkill: Skill = {
  metadata: { name: 'lazy-one', description: '懒加载技能', mode: 'lazy', emoji: '🧩' },
  body: '懒技能的完整指南正文',
  source: 'builtin',
}

const alwaysSkill: Skill = {
  metadata: { name: 'always-one', description: '常驻技能', mode: 'always' },
  body: '常驻技能：这段正文必须出现在系统提示里。',
  source: 'user',
}

describe('buildSystemPrompt', () => {
  it('omits the skills section entirely without skills', () => {
    const prompt = buildSystemPrompt([fakeTool])
    expect(prompt).not.toContain('【技能】')
    expect(prompt).toContain('【安全】')
  })

  it('lists lazy skills by name+description without their bodies', () => {
    const prompt = buildSystemPrompt([fakeTool], [lazySkill])
    expect(prompt).toContain('【技能】')
    expect(prompt).toContain('🧩 lazy-one：懒加载技能')
    expect(prompt).toContain('load_skill')
    expect(prompt).not.toContain('懒技能的完整指南正文')
  })

  it('inlines always-skill bodies verbatim', () => {
    const prompt = buildSystemPrompt([fakeTool], [alwaysSkill])
    expect(prompt).toContain('常驻技能：这段正文必须出现在系统提示里。')
  })

  it('mentions the user skill folder for skill creation', () => {
    const prompt = buildSystemPrompt([fakeTool], [lazySkill], {
      userSkillFolder: '.obsidian-ai/skills',
    })
    expect(prompt).toContain('.obsidian-ai/skills')
    expect(prompt).toContain('skill-creator')
  })

  it('has no asides section — /btw is now an ephemeral aside, outside the prompt', () => {
    // The old persistent-asides behavior is gone: a /btw exchange is
    // answered from the current context but never recorded in it, so the
    // system prompt has no 【旁注】 section and no option to add one.
    const prompt = buildSystemPrompt([fakeTool])
    expect(prompt).not.toContain('【旁注】')
  })

  it('omits the memory section without memory (or with an empty list)', () => {
    expect(buildSystemPrompt([fakeTool])).not.toContain('【记忆】')
    expect(buildSystemPrompt([fakeTool], [], { memory: [] })).not.toContain('【记忆】')
  })

  it('renders memory bullets before the safety section', () => {
    const prompt = buildSystemPrompt([fakeTool], [], {
      memory: ['用户是前端工程师', '回复偏好表格'],
    })
    expect(prompt).toContain('- 用户是前端工程师')
    expect(prompt).toContain('- 回复偏好表格')
    expect(prompt.indexOf('【记忆】')).toBeLessThan(prompt.indexOf('【安全】'))
  })

  it('guides the AI to persist durable preferences via save_memory', () => {
    expect(buildSystemPrompt([fakeTool])).toContain('save_memory')
  })
})

describe('buildSystemPrompt — evolution files (追加⑲)', () => {
  it('injects the agent.md persona under 【你的设定】', () => {
    const prompt = buildSystemPrompt([fakeTool], [], {
      agentDoc: '# 助手人设\n\n- 称呼用户为「老板」',
    })
    expect(prompt).toContain('【你的设定】')
    expect(prompt).toContain('称呼用户为「老板」')
    // Persona sits near the top — before the built-in conventions.
    expect(prompt.indexOf('【你的设定】')).toBeLessThan(
      prompt.indexOf('【笔记库约定】'),
    )
  })

  it('omits 【你的设定】 when agent.md is empty or whitespace-only', () => {
    expect(buildSystemPrompt([fakeTool], [], { agentDoc: '' })).not.toContain('【你的设定】')
    expect(buildSystemPrompt([fakeTool], [], { agentDoc: '  \n ' })).not.toContain('【你的设定】')
  })

  it('injects user-profile bullets under 【用户画像】', () => {
    const prompt = buildSystemPrompt([fakeTool], [], {
      user: ['用户是前端开发者', '用户偏好简洁回答'],
    })
    expect(prompt).toContain('【用户画像】')
    expect(prompt).toContain('- 用户是前端开发者')
    expect(prompt.indexOf('【用户画像】')).toBeLessThan(prompt.indexOf('【安全】'))
  })

  it('omits 【用户画像】 without user entries', () => {
    expect(buildSystemPrompt([fakeTool])).not.toContain('【用户画像】')
    expect(buildSystemPrompt([fakeTool], [], { user: [] })).not.toContain('【用户画像】')
  })

  it('mentions the visible data folder and all three brain files', () => {
    const prompt = buildSystemPrompt([fakeTool])
    expect(prompt).toContain('AI 助手/')
    expect(prompt).toContain('memory.md')
    expect(prompt).toContain('user.md')
    expect(prompt).toContain('agent.md')
  })

  it('honors a custom aiFolder in the guidance line', () => {
    const prompt = buildSystemPrompt([fakeTool], [], { aiFolder: 'my-data' })
    expect(prompt).toContain('my-data/')
    expect(prompt).not.toContain('AI 助手/')
  })

  it('guides target selection for save_memory (user vs memory)', () => {
    const prompt = buildSystemPrompt([fakeTool])
    expect(prompt).toContain('target=user')
    expect(prompt).toContain('target=memory')
  })
})

describe('buildSystemPrompt — sub-agent persona (多 Agent 体系)', () => {
  it('injects the persona under 【当前子代理】 right after 【你的设定】', () => {
    const prompt = buildSystemPrompt([fakeTool], [], {
      agentDoc: '基础人格',
      agentPersona: '你是追问启发，一次只问一个问题。',
    })
    expect(prompt).toContain('【当前子代理】')
    expect(prompt).toContain('你是追问启发，一次只问一个问题。')
    expect(prompt.indexOf('【你的设定】')).toBeLessThan(
      prompt.indexOf('【当前子代理】'),
    )
    expect(prompt.indexOf('【当前子代理】')).toBeLessThan(
      prompt.indexOf('【笔记库约定】'),
    )
  })

  it('declares the persona takes precedence over agent.md', () => {
    const prompt = buildSystemPrompt([fakeTool], [], {
      agentPersona: '人设正文',
    })
    expect(prompt).toContain('以子代理人设为准')
  })

  it('omits the section without a persona (main agent)', () => {
    expect(buildSystemPrompt([fakeTool])).not.toContain('【当前子代理】')
    expect(
      buildSystemPrompt([fakeTool], [], { agentPersona: '  \n ' }),
    ).not.toContain('【当前子代理】')
  })
})

describe('buildSystemPrompt — today date injection', () => {
  // Fixed reference date so the assertion is deterministic (2026-08-05 = 星期三).
  const fixed = new Date(2026, 7, 5)

  it('formats a date as YYYY-MM-DD 星期X with Chinese weekday', () => {
    expect(formatToday(fixed)).toBe('2026-08-05 星期三')
  })

  it('injects the supplied today line before 【笔记库约定】', () => {
    const prompt = buildSystemPrompt([fakeTool], [], { now: fixed })
    expect(prompt).toContain('今天是 2026-08-05 星期三。')
    expect(prompt.indexOf('今天是 2026-08-05 星期三。')).toBeLessThan(
      prompt.indexOf('【笔记库约定】'),
    )
  })

  it('falls back to the real clock when now is omitted', () => {
    const prompt = buildSystemPrompt([fakeTool])
    expect(prompt).toContain('今天是 ')
    // Must still be a well-formed date + Chinese weekday line.
    expect(prompt).toMatch(/今天是 \d{4}-\d{2}-\d{2} 星期[日一二三四五六]。/)
  })
})
