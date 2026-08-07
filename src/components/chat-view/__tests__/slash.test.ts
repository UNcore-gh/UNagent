// Leading-directive logic: '/' (level 1) opens the command palette, '//'
// (level 2) invokes a skill. Covers trigger detection, the send-time
// classifier (parseDirective), command + skill candidate ranking, and the
// /think argument parser.

import type { Skill } from '../../../core/skills/types'
import { COMMANDS, THINK_OPTIONS, buildLearnPrompt, parseThinkLevel } from '../commands'
import {
  buildCommandCandidates,
  buildSkillCandidates,
  commandToken,
  findInlineCommandTokens,
  getActiveSlash,
  parseDirective,
} from '../slash'

describe('getActiveSlash', () => {
  it('detects a bare / as level 1', () => {
    expect(getActiveSlash('/', 1)).toEqual({ level: 1, query: '' })
  })

  it('tracks the query token after /', () => {
    expect(getActiveSlash('/th', 3)).toEqual({ level: 1, query: 'th' })
  })

  it('reads // as level 2 (skill invocation)', () => {
    expect(getActiveSlash('//', 2)).toEqual({ level: 2, query: '' })
    expect(getActiveSlash('//we', 4)).toEqual({ level: 2, query: 'we' })
  })

  it('reads /// as level 3 (sub-agent manager, 多 Agent 体系)', () => {
    expect(getActiveSlash('///', 3)).toEqual({ level: 3, query: '' })
    expect(getActiveSlash('///追问', 5)).toEqual({ level: 3, query: '追问' })
  })

  it('collapses 4+ slashes into level 3', () => {
    expect(getActiveSlash('////x', 5)).toEqual({ level: 3, query: 'x' })
  })

  it('ignores / not at position 0 (it is a message-level directive)', () => {
    expect(getActiveSlash('hi /x', 5)).toBeNull()
  })

  it('closes once a space is typed (argument / message body begins)', () => {
    expect(getActiveSlash('/weekly 写周报', 10)).toBeNull()
  })

  it('needs the caret past the slash and rejects huge tokens', () => {
    expect(getActiveSlash('/x', 0)).toBeNull()
    expect(getActiveSlash('/' + 'x'.repeat(41), 42)).toBeNull()
  })
})

describe('parseDirective', () => {
  it('classifies a single-slash line as a command with its arg', () => {
    expect(parseDirective('/model gpt-5')).toEqual({
      kind: 'command',
      name: 'model',
      arg: 'gpt-5',
    })
  })

  it('commands may carry no argument', () => {
    expect(parseDirective('/branch')).toEqual({ kind: 'command', name: 'branch', arg: '' })
  })

  it('classifies a double-slash line as a skill with its body', () => {
    expect(parseDirective('//weekly-report 写周报')).toEqual({
      kind: 'skill',
      name: 'weekly-report',
      body: '写周报',
    })
  })

  it('classifies three slashes as the sub-agent panel trigger (多 Agent 体系)', () => {
    expect(parseDirective('///')).toEqual({ kind: 'agents', query: '' })
    expect(parseDirective('///追问启发')).toEqual({
      kind: 'agents',
      query: '追问启发',
    })
    expect(parseDirective('///追问 更温柔')).toEqual({
      kind: 'agents',
      query: '追问 更温柔',
    })
    expect(parseDirective('////x')).toEqual({ kind: 'agents', query: 'x' })
  })

  it('tolerates leading whitespace and non-ASCII names', () => {
    expect(parseDirective('  //周报 做一份')).toEqual({ kind: 'skill', name: '周报', body: '做一份' })
  })

  it('returns null without a leading directive', () => {
    expect(parseDirective('写周报 /weekly')).toBeNull()
    expect(parseDirective('plain text')).toBeNull()
    expect(parseDirective('/')).toBeNull()
    expect(parseDirective('')).toBeNull()
  })
})

describe('commandToken', () => {
  it('detects a known command token with the rest of the text', () => {
    expect(commandToken('/btw 顺便问一下')).toEqual({
      token: '/btw',
      label: '顺便一问',
      known: true,
      end: 4,
      level: 1,
    })
  })

  it('only counts a command once a space follows its name (用户指示)', () => {
    // Bare name (still typing, or Enter without an arg) → not correct yet.
    expect(commandToken('/btw')).toBeNull()
    expect(commandToken('/think')).toBeNull()
    expect(commandToken('/chats')).toBeNull()
    // A space-less continuation is not a valid invocation either.
    expect(commandToken('/btw问题')).toBeNull()
    // A trailing space is the trigger.
    expect(commandToken('/btw ')?.known).toBe(true)
    expect(commandToken('/chats ')?.known).toBe(true)
    // The tab separator counts too.
    expect(commandToken('/btw\tx')?.known).toBe(true)
  })

  it('flags every built-in command as known once followed by a space', () => {
    expect(commandToken('/think ')?.known).toBe(true)
    expect(commandToken('/think hard')?.token).toBe('/think')
    expect(commandToken('/model ')?.known).toBe(true)
    expect(commandToken('/learn 结晶')?.known).toBe(true)
    expect(commandToken('/compact ')?.known).toBe(true)
    expect(commandToken('/chats ')?.known).toBe(true)
    expect(commandToken('/new ')?.known).toBe(true)
    expect(commandToken('/branch ')?.known).toBe(true)
    expect(commandToken('/rewind ')?.known).toBe(true)
    expect(commandToken('/settings ')?.known).toBe(true)
  })

  it('does not highlight an unknown command', () => {
    const t = commandToken('/abc 什么')
    expect(t).not.toBeNull()
    expect(t!.known).toBe(false)
  })

  it('ignores non-command text and the agents panel', () => {
    expect(commandToken('//skill-name')).toBeNull()
    expect(commandToken('///x ')).toBeNull()
    expect(commandToken('hello /btw')).toBeNull()
    expect(commandToken('plain')).toBeNull()
    expect(commandToken('')).toBeNull()
  })

  it('renders a "//skill-name " invocation as a level-2 pill (追加㊺)', () => {
    expect(commandToken('//agent-creator 帮我练口语')).toEqual({
      token: '//agent-creator',
      label: 'agent-creator',
      known: true,
      end: 15,
      level: 2,
    })
    // Same spacing rules as commands: space required, else still mid-name.
    expect(commandToken('//agent-creator')).toBeNull()
    expect(commandToken('//agent-creator问题')).toBeNull()
    expect(commandToken('//agent-creator ')).not.toBeNull()
    expect(commandToken('  //search-notes 找文件')?.level).toBe(2)
  })

  it('tolerates leading whitespace like the rest of the parser', () => {
    expect(commandToken('  /btw x')).toEqual({
      token: '  /btw',
      label: '顺便一问',
      known: true,
      end: 6,
      level: 1,
    })
  })
})

describe('findInlineCommandTokens', () => {
  it('finds known-shaped tokens at word boundaries in prose', () => {
    expect(findInlineCommandTokens('用 /btw 问问')).toEqual([
      { start: 2, end: 6, slashes: 1, name: 'btw' },
    ])
    expect(findInlineCommandTokens('发 //agent-creator 创建')).toEqual([
      { start: 2, end: 17, slashes: 2, name: 'agent-creator' },
    ])
    // Punctuation and end-of-text close a token.
    expect(findInlineCommandTokens('（/compact）。')).toEqual([
      { start: 1, end: 9, slashes: 1, name: 'compact' },
    ])
  })

  it('skips prose lookalikes: URLs, numbers, glued CJK, agents panel', () => {
    expect(findInlineCommandTokens('见 https://example.com')).toEqual([])
    expect(findInlineCommandTokens('完成 10/20 任务')).toEqual([])
    expect(findInlineCommandTokens('/btw问题 这样')).toEqual([])
    expect(findInlineCommandTokens('///agent-creator x')).toEqual([])
  })

  it('keeps offsets independent of the leading boundary', () => {
    const t = findInlineCommandTokens('开头 /learn 一下')
    expect(t[0].start).toBe(3)
    expect(t[0].end).toBe(9)
  })
})

describe('parseThinkLevel', () => {
  it('accepts the three levels', () => {
    expect(parseThinkLevel('think')).toBe('think')
    expect(parseThinkLevel('think-hard')).toBe('think-hard')
    expect(parseThinkLevel('ultrathink')).toBe('ultrathink')
  })

  it('accepts off aliases', () => {
    expect(parseThinkLevel('off')).toBe('off')
    expect(parseThinkLevel('think-off')).toBe('off')
    expect(parseThinkLevel('no')).toBe('off')
  })

  it('is case-insensitive and rejects garbage', () => {
    expect(parseThinkLevel('THINK')).toBe('think')
    expect(parseThinkLevel('bogus')).toBeNull()
    expect(parseThinkLevel('')).toBeNull()
  })
})

describe('buildCommandCandidates', () => {
  it('lists every command in defined order on an empty query', () => {
    const items = buildCommandCandidates(COMMANDS, '')
    expect(items.map((i) => i.id)).toEqual([
      'btw',
      'hermes',
      'hermes-mode',
      'hermes-open',
      'hermes-init',
      'think',
      'model',
      'mode',
      'chats',
      'new',
      'branch',
      'rewind',
      'edit',
      'compact',
      'settings',
      'mcp',
      'learn',
    ])
  })

  it('ranks prefix matches first', () => {
    const items = buildCommandCandidates(COMMANDS, 'th')
    expect(items.map((i) => i.id)).toEqual(['think'])
  })

  it('breaks score ties alphabetically', () => {
    // 'b' prefixes both branch (80) and btw (80) → localeCompare order;
    // hermes-init / mcp trail in via their descriptions ('Obsidian' /
    // "streamableHttp" contain 'b') → alphabetical tie-break.
    const items = buildCommandCandidates(COMMANDS, 'b')
    expect(items.map((i) => i.id)).toEqual([
      'branch',
      'btw',
      'hermes-init',
      'mcp',
    ])
  })

  it('matches on the description too', () => {
    // 'model' hits on its label AND description; 'settings' trails in via its
    // description mentioning 模型档案 (score 30).
    const items = buildCommandCandidates(COMMANDS, '模型')
    expect(items.map((i) => i.id)).toEqual(['model', 'settings'])
  })

  it('returns nothing for an unmatched query', () => {
    expect(buildCommandCandidates(COMMANDS, 'zzz')).toEqual([])
  })

  it('carries icons + usage hints for the picker', () => {
    const items = buildCommandCandidates(COMMANDS, '')
    const model = items.find((i) => i.id === 'model')
    expect(model?.icon).toBe('cpu')
    expect(model?.usage).toBe('/model')
  })

  it('exposes Chinese labels for the picker', () => {
    const items = buildCommandCandidates(COMMANDS, '')
    expect(items.map((i) => i.label)).toEqual([
      '顺便一问',
      '分派 Hermes',
      '切换 Hermes 模式',
      '在 Hermes 桌面端打开',
      '初始化对话同步',
      '深度思考',
      '切换模型',
      '审批模式',
      '对话列表',
      '新建对话',
      '分支对话',
      '回溯对话',
      '重新编辑',
      '压缩上下文',
      '打开设置',
      'MCP 服务',
      '结晶技能',
    ])
  })

  it('matches on the Chinese label as well as the id', () => {
    // branch by its label (prefix 80); chats also trails in via its
    // description mentioning 分支 (score 30).
    expect(buildCommandCandidates(COMMANDS, '分支').map((i) => i.id)).toEqual([
      'branch',
      'chats',
    ])
  })
})

const mkSkill = (
  name: string,
  description: string,
  source: Skill['source'] = 'builtin',
): Skill => ({
  metadata: { name, description, mode: 'lazy' },
  body: '指南',
  source,
})

describe('buildSkillCandidates', () => {
  const skills = [
    mkSkill('image-generator', '用 AI 生成图片'),
    mkSkill('weekly-report', '生成周报'),
    mkSkill('my-weekly', '我的周报流程', 'user'),
  ]

  it('lists everything alphabetically on an empty query', () => {
    const items = buildSkillCandidates(skills, '')
    expect(items.map((i) => i.name)).toEqual([
      'image-generator',
      'my-weekly',
      'weekly-report',
    ])
  })

  it('ranks exact > prefix > description, builtin before user on ties', () => {
    const items = buildSkillCandidates(skills, 'weekly')
    // weekly-report (prefix 80, builtin) before my-weekly (includes 60, user)
    expect(items[0].name).toBe('weekly-report')
    expect(items[1].name).toBe('my-weekly')
  })

  it('matches on description too', () => {
    const items = buildSkillCandidates(skills, '图片')
    expect(items.map((i) => i.name)).toEqual(['image-generator'])
  })
})

describe('/learn command', () => {
  it('is registered as an insert command with a usage hint', () => {
    const learn = COMMANDS.find((c) => c.id === 'learn')
    expect(learn?.kind).toBe('insert')
    expect(learn?.usage).toBe('/learn <要结晶什么>')
  })

  it('matches a Chinese description query', () => {
    const items = buildCommandCandidates(COMMANDS, '技能')
    expect(items.map((i) => i.id)).toContain('learn')
  })
})

describe('conversation-management commands', () => {
  it('registers /chats and /rewind as menu commands', () => {
    expect(COMMANDS.find((c) => c.id === 'chats')?.kind).toBe('menu')
    expect(COMMANDS.find((c) => c.id === 'rewind')?.kind).toBe('menu')
  })

  it('registers /branch and /new as immediate commands', () => {
    expect(COMMANDS.find((c) => c.id === 'branch')?.kind).toBe('immediate')
    expect(COMMANDS.find((c) => c.id === 'new')?.kind).toBe('immediate')
  })

  it('registers /edit as an immediate re-edit command (追加86)', () => {
    const edit = COMMANDS.find((c) => c.id === 'edit')
    expect(edit?.kind).toBe('immediate')
    expect(edit?.usage).toBe('/edit')
  })

  it('orders thinking strength from none to strongest', () => {
    expect(THINK_OPTIONS.map((o) => o.id)).toEqual([
      'off',
      'think',
      'think-hard',
      'ultrathink',
    ])
  })

  it('dropped the old memory-only /restore command', () => {
    expect(COMMANDS.find((c) => c.id === 'restore')).toBeUndefined()
  })

  it('matches the conversation list by Chinese description', () => {
    const items = buildCommandCandidates(COMMANDS, '对话')
    expect(items.map((i) => i.id)).toContain('chats')
  })
})

describe('buildLearnPrompt', () => {
  it('embeds the request and the configured skill folder', () => {
    const p = buildLearnPrompt('周报流程', '/my-skills/')
    expect(p).toContain('周报流程')
    expect(p).toContain('my-skills/ 下创建')
  })

  it('falls back to the default folder when unset', () => {
    const p = buildLearnPrompt('x', '  ')
    expect(p).toContain('AI 助手/skills/ 下创建')
  })

  it('keeps skills prompt-only (no executable code)', () => {
    expect(buildLearnPrompt('x', 'skills')).toContain('绝不包含任何可执行代码')
    expect(buildLearnPrompt('x', 'skills')).toContain('mode: lazy')
  })
})
