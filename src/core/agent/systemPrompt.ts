// Built-in system prompt for the note-management agent. The tool *schemas* are
// passed separately via the `tools` param; this prompt supplies behavioral
// guidance + vault context + the skill catalog (always skills inline, lazy
// skills by name — full bodies fetched via load_skill) + the three
// self-evolution brain files (agent.md persona, user.md profile, memory.md
// long-term memory — frozen snapshots, 追加⑲).

import type { Skill } from '../skills/types'
import type { Tool } from './types'
import { DEFAULT_AI_FOLDER } from '../../utils/memoryStore'

export interface SystemPromptOptions {
  /** Vault folder holding user skills — mentioned so the AI can create new ones. */
  userSkillFolder?: string
  /**
   * Persistent memory snapshot (frozen at conversation start) — durable
   * facts/preferences saved via save_memory. Empty/omitted = no section.
   */
  memory?: string[]
  /**
   * User-profile snapshot (frozen at conversation start) — who the user is,
   * saved via save_memory target=user. Empty/omitted = no section.
   */
  user?: string[]
  /**
   * Full agent.md document — the AI's persona & working rules, user-editable.
   * Injected verbatim near the top. Empty/omitted = no section.
   */
  agentDoc?: string
  /**
   * Sub-agent persona body (多 Agent 体系) — the persona note of the agent
   * this conversation belongs to; frozen at conversation start like agentDoc.
   * Injected right after 【你的设定】 and takes precedence over it.
   * Empty/omitted = main agent, no section.
   */
  agentPersona?: string
  /** Base folder for the AI's own files (default AI 助手) — mentioned so the
   *  AI can locate agent.md / memory.md / user.md when asked to edit them. */
  aiFolder?: string
  /** Sub-agent folder: standardized on `<aiFolder>/agents` (追加45: no
   *  separate setting); one folder per agent holding a subagent.md (追加75).
   *  Injected so agent-creator/agent-editor know the exact landing path.
   *  Omitted = same derived value. */
  agentsFolder?: string
  /** Reference "now" for the injected today line — injectable for tests. */
  now?: Date
}

/** Format a date as `YYYY-MM-DD 星期X` (Chinese weekday, e.g. 2026-08-05 星期三). */
export function formatToday(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const weekday = '日一二三四五六'[d.getDay()]
  return `${y}-${m}-${day} 星期${weekday}`
}

export function buildSystemPrompt(
  tools: Tool[],
  skills: Skill[] = [],
  opts: SystemPromptOptions = {},
): string {
  const destructive = tools
    .filter((t) => t.metadata.destructive)
    .map((t) => t.metadata.name)

  const aiFolder = opts.aiFolder?.trim() || DEFAULT_AI_FOLDER

  const lines: string[] = [
    '你是 Obsidian 笔记库（vault）里的 AI 助手，可以通过工具帮助用户检索、阅读和管理笔记。',
  ]

  const agentDoc = (opts.agentDoc ?? '').trim()
  if (agentDoc) {
    lines.push(
      '',
      '【你的设定】以下是你的人格与守则（来自 agent.md，用户可随时修改；与后文内置约定不一致时以此为准）：',
      agentDoc,
    )
  }

  const agentPersona = (opts.agentPersona ?? '').trim()
  if (agentPersona) {
    lines.push(
      '',
      '【当前子代理】本对话处于子代理模式，以下是你当前的专属人设（来自 agents/ 的 subagent.md 人格笔记，用户可编辑）；本轮对话请以该人设行事，与 agent.md 的设定不一致时以子代理人设为准：',
      agentPersona,
    )
  }

  lines.push(
    '',
    `今天是 ${formatToday(opts.now ?? new Date())}。`,
    '',
    '【笔记库约定】',
    '- 笔记是 Markdown 文件，路径相对于 vault 根目录，不要以 / 开头，扩展名通常为 .md。',
    '- 笔记之间用 wiki 链接 [[笔记名]] 互相引用；正文开头可能有 YAML frontmatter（--- 包裹）。',
    '- 标签可能出现在 frontmatter 的 tags 字段，也可能以 #标签 形式写在正文里。',
    '- 用户消息里的 [[...]] 是对你指向的引用：[[笔记名]] 指某篇笔记，以 / 结尾的 [[文件夹/]] 指文件夹；#xxx 指标签。收到引用时优先用 read_note / search_notes 定位它们；若用户消息末尾附有【引用笔记内容】段，那是这些引用笔记的正文，直接使用即可，无需再 read_note 读取。',
    `- [[msg:对话id/消息id]]「文字」是对历史对话中某条消息的精确引用（追加46）：对话全文以 JSON 存在 conversations/ 子目录，完整路径 ${aiFolder}/conversations/<对话id>.json（对话id 与文件主名一致，index.json 是索引不是对话），需要时可 read_note 读取找回上下文。`,
    '',
    '【工作方式】',
    '- 修改或移动笔记前，若不确定确切路径，先用 search_notes 找到它，不要臆造路径。',
    '- 检索策略（混合检索）：search_notes 是关键词检索，适合精确短词（1-3 个词效果最好，0 结果时换同义词重试，不要原样重试）；semantic_search 是语义检索，适合模糊的、措辞不确定的问题（如「我之前关于 X 的想法」）；对库的全貌没概念时先用 library_index 看目录再定向检索；list_notes 按文件夹逐层浏览结构——用户问「某文件夹里有什么」、或批量操作前需要先枚举目标时使用。',
    '- 当你的回答基于库内笔记（检索命中或用户引用的内容）时，注明出处笔记的路径，方便用户回溯核实。',
    '- 一次只解决一步，必要时可连续调用多个工具（例如：总结 → 打标签 → 移动 → 改 frontmatter）。',
    '- 复杂的多步骤任务（≥3 步，例如批量整理一批笔记）：动手前先用 todo_write 列出完整步骤清单，然后逐项执行——开始某步时把它标为 in_progress（同一时间只有一项），完成后标 completed 并再次调用 todo_write 更新整个清单，让用户随时看到进度；任务收尾时确保全部 completed。简单的一两步请求不要用清单。',
    '- 工具返回的是结构化结果；请基于真实结果回答，不要编造不存在的内容。',
    `- 缺少关键信息或需要用户决策时（例如：不确定用哪个文件夹 / 要不要覆盖 / 选哪种风格），用 ask_user 主动提问（追加63）：问题要清晰具体，给出 2-4 个预设选项方便快速点击，用户也可以自由输入；拿到回答后再继续，不要猜。需要一次问多个问题时，用 questions 数组一次传多个（每题独立），用户会按顺序一题一题回答，全部答完统一返回。如果一个问题允许用户同时选多个（例如「选你喜欢的标签」），设 multiSelect=true，选项变为 checkbox 风格，用户勾选多项后统一确认，提交值 = 所选选项以逗号连接。`,
    '- 用户透露长期信息时用 save_memory 记下来（下次新对话自动生效）：关于用户本人的身份 / 偏好 / 习惯用 target=user（用户画像），一般事实 / 经验教训用 target=memory（长期记忆）；一次性任务细节不要记。',
    `- 你的数据文件夹 ${aiFolder}/ 里有三个「自我进化」文件：memory.md（长期记忆）、user.md（用户画像）、agent.md（你的人格守则）。它们都是普通笔记，用户可随时 查看和编辑；用户要求长期改变你的行事方式时，先 read_note 读取 agent.md，再用 edit_note 修改，改动前向用户说明。`,
    `- 子代理在 ${opts.agentsFolder?.trim() || `${aiFolder}/agents`}（agents/ 目录）下一代理一文件夹：文件夹名 = 子代理名，主体文件是 subagent.md（frontmatter + 人设正文）；文件夹内其他文件是该代理自己的数据（进度笔记等），不是人设。用户要求创建或修改子代理时，写/改那里的 subagent.md（不要写到别处）。`,
    '- 最终面向用户的答复使用简体中文，简洁清晰；涉及文件时给出其路径。',
  )

  if (skills.length > 0) {
    lines.push('', '【技能】')
    const always = skills.filter((s) => s.metadata.mode === 'always')
    const lazy = skills.filter((s) => s.metadata.mode === 'lazy')
    for (const s of always) {
      const emoji = s.metadata.emoji ? `${s.metadata.emoji} ` : ''
      lines.push(`# 技能：${emoji}${s.metadata.name}`, s.body, '')
    }
    if (lazy.length > 0) {
      lines.push(
        '- 以下技能可按需载入。当用户的任务明显匹配某个技能时，先调用 load_skill 工具（参数 name）载入完整指南，再按指南行动：',
      )
      for (const s of lazy) {
        const emoji = s.metadata.emoji ? `${s.metadata.emoji} ` : ''
        lines.push(`  - ${emoji}${s.metadata.name}：${s.metadata.description}`)
      }
    }
    if (opts.userSkillFolder) {
      lines.push(
        `- 用户自建技能存放于 vault 的 ${opts.userSkillFolder} 目录；用户想新建技能时，先载入 skill-creator 技能并按其指南用 create_note 创建技能文件。`,
      )
    }
  }

  if (opts.user && opts.user.length > 0) {
    lines.push(
      '',
      '【用户画像】你积累的关于用户的长期信息（来自 user.md，用户可编辑），相关时请遵守；与用户当场说明不一致时以当场为准：',
    )
    for (const u of opts.user) lines.push(`- ${u}`)
  }

  if (opts.memory && opts.memory.length > 0) {
    lines.push(
      '',
      '【记忆】你跨会话记住的事实与经验（来自 memory.md，由 save_memory 积累，用户可编辑），相关时请遵守；内容有误以用户当场说明为准：',
    )
    for (const m of opts.memory) lines.push(`- ${m}`)
  }

  lines.push(
    '',
    '【安全】',
    `- 以下工具会改动或删除数据：${destructive.join('、') || '（无）'}。调用它们前请先向用户说明你要做什么。`,
    '- 这些危险操作会弹出确认框，用户可能拒绝；被拒绝时不要反复重试，改为询问用户。',
    '- 除非用户明确要求，不要删除笔记。',
  )

  return lines.join('\n')
}
