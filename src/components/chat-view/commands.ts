// The '/' command palette (single slash). Double slash '//' is skill
// invocation — see slash.ts. Commands are Claude Code-style session
// directives: they configure THIS conversation (thinking level, model
// override), ask ephemeral by-the-way questions (/btw — answered from the
// current context but never recorded in it), or manage conversations (list /
// branch / rewind). Conversation state persists to <aiFolder>/conversations/
// — see utils/conversationStore.ts. Session chips (thinking / model) never
// touch global settings.

import type { EngineCapability, EngineId } from '../../core/engine/capabilities'
import { engineCapabilities } from '../../core/engine/capabilities'
import type { HermesAdvertisedCommand } from '../../core/hermes/advertisedCommands'
import {
  advertisedSelectAction,
  filterAdvertisedCommands,
} from '../../core/hermes/advertisedCommands'
import type { HermesModeId } from '../../core/hermes/types'
import { HERMES_COMMAND_CATALOG } from './hermesRefs'
import type { ThinkLevel } from '../../core/llm/base'

/** How the composer reacts when a command row is picked. */
export type CommandKind =
  | 'menu' // opens a second-level list (think levels, conversations, rewind turns)
  | 'insert' // inserts "/id " so the user types the argument
  | 'immediate' // executes on pick (branch)

export interface CommandDef {
  id: string
  /** Chinese display name — the picker's primary label. */
  label: string
  /** One-line purpose shown in the picker. */
  description: string
  /** Lucide icon name. */
  icon: string
  kind: CommandKind
  /** Argument template hint, e.g. "/model <模型名>". */
  usage?: string
  /** M2-T4 能力门控：仅具备该能力的引擎露出此命令（如 /think 挂
   *  extendedThinking——hermes 引擎没有此能力即隐藏）。不挂 = 双引擎可见
   *  （/compact 在 hermes 下走 T5 路由改写，不靠隐藏）。 */
  requiresCapability?: EngineCapability
  /** 命令来源（M2-T4）：缺省 'plugin'；hermes 通告命令转换后挂 'hermes'。 */
  source?: 'plugin' | 'hermes'
  /** 面板徽章文案（hermes 通告命令标注「Hermes」来源）。 */
  badge?: string
}

// Ordered by how often they're used (常用度): the daily chat modifiers
// first, then conversation management, then utilities, then the niche one.
export const COMMANDS: CommandDef[] = [
  {
    id: 'btw',
    label: '顺便一问',
    description: '基于当前上下文问个小问题（这一问一答不计入对话上下文）',
    icon: 'message-circle',
    kind: 'insert',
    usage: '/btw <问题>',
  },
  {
    // 分派任务给本机 hermes 执行（桌面专属）——非旁问：任务与 hermes 结果
    // 都进入对话历史，主 agent 可基于结果继续。
    id: 'hermes',
    label: '分派 Hermes',
    description: '把复杂任务分发给本机 Hermes 执行，结果进入对话历史可继续跟进（桌面专属）',
    icon: 'terminal',
    kind: 'insert',
    usage: '/hermes <任务>',
  },
  {
    // 追加㊱: Hermes 模式开关命令——与头部 pill、toggle-hermes-mode 命令同效果。
    id: 'hermes-mode',
    label: '切换 Hermes 模式',
    description: '主 agent ≒ Hermes 模式一键切换（对话整轮由本机 Hermes 代理驱动；桌面专属）',
    icon: 'zap',
    kind: 'immediate',
    usage: '/hermes-mode',
  },
  {
    // 桌面端会话共享的出口（「合并展示」的镜像）：把当前 hermes 对话所在
    // 的 vault 项目在 Hermes 桌面端打开——插件 acp 会话与桌面端会话同库
    // （state.db），桌面端按 cwd 归组即能看到当前会话。挂 hermesDesktop
    // 能力门控：仅 hermes 引擎可见（core 对话无 hermes 会话可言）。
    id: 'hermes-open',
    label: '在 Hermes 桌面端打开',
    description: '打开 Hermes 桌面端并定位到当前对话所在项目（仅 Hermes 模式）',
    icon: 'monitor',
    kind: 'immediate',
    usage: '/hermes-open',
    requiresCapability: 'hermesDesktop',
  },
  {
    // 对话同步初始化命令：确保 Hermes 侧存在当前仓库的项目会话（以仓库名
    // 归组），不存在则新建并写回 settings（vault 级绑定）。挂 hermesDesktop
    // 门控——仅 hermes 引擎面板显示（core 对话手打仍可执行，初始化是
    // vault 级动作）；移动端 / 未启用时由执行侧给兜底提示。
    id: 'hermes-init',
    label: '初始化对话同步',
    description: '初始化 Hermes ↔ Obsidian 对话同步：确保 Hermes 中存在当前仓库项目（不存在则创建）',
    icon: 'refresh-cw',
    kind: 'immediate',
    usage: '/hermes-init',
    requiresCapability: 'hermesDesktop',
  },
  {
    id: 'think',
    label: '深度思考',
    description: '先深度推理再回答（更慢、更贵、更准）',
    icon: 'lightbulb',
    kind: 'menu',
    usage: '/think',
    // M2-T4: 思考档位是 core 引擎能力（extendedThinking）；hermes 用自己
    // 的推理体系，插件的思考档位对它无效 → 能力门控隐藏。
    requiresCapability: 'extendedThinking',
  },
  {
    id: 'model',
    label: '切换模型',
    description: '切换本会话使用的模型：从设置的模型档案中选（多厂商/多协议）',
    icon: 'cpu',
    kind: 'menu',
    usage: '/model',
  },
  {
    // 任务一 §1.2: hermes 会话审批模式切换；M2-T8 起主 agent 同套语义，
    // /mode 不再挂 approvalModes 门控——双引擎可见（hermes = 会话
    // set_mode + override，core = SafetySettings.approvalMode）。
    // M2-T8 收口：kind='menu'——命令面板选中即弹审批模式选择窗（与
    // /model 同款交互，数据面按引擎切换）；手打 /mode 带参仍走中文别名
    // 映射（parseHermesModeArg），无参手打回车同样弹窗。
    id: 'mode',
    label: '审批模式',
    description:
      '切换审批模式：默认（逐次询问）/ 自动（编辑放行）/ 免询（全部放行）',
    icon: 'shield-question',
    kind: 'menu',
    usage: '/mode',
  },
  {
    id: 'chats',
    label: '对话列表',
    description: '管理历史对话：切换 / 分支 / 删除（自动保存，多层级）',
    icon: 'message-square',
    kind: 'menu',
    usage: '/chats',
  },
  {
    id: 'new',
    label: '新建对话',
    description: '保存当前对话，打开一个全新的空白对话',
    icon: 'plus',
    kind: 'immediate',
    usage: '/new',
  },
  {
    id: 'branch',
    label: '分支对话',
    description: '从当前对话开一个子对话（继承上下文，可层层分支）',
    icon: 'git-branch',
    kind: 'immediate',
    usage: '/branch',
  },
  {
    id: 'rewind',
    label: '回溯对话',
    description: '回溯到对话中的任意一轮（丢弃该轮及之后的消息）',
    icon: 'rotate-ccw',
    kind: 'menu',
    usage: '/rewind',
  },
  {
    // 追加86: 双击消息气泡重编辑的命令入口——把最后一条自己发的消息
    // 载入底部输入框修改重发（编辑态气泡挂「正在重新编辑」徽章）。
    id: 'edit',
    label: '重新编辑',
    description: '把最后一条发出的消息载入输入框重新编辑（等同双击消息气泡）',
    icon: 'pencil',
    kind: 'immediate',
    usage: '/edit',
  },
  {
    // M2-T4: 刻意不挂 requiresCapability——双引擎可见。hermes 引擎下发送
    // 时经 M2-T5 路由改写为 hermes 原生 /compress（不是隐藏）。
    id: 'compact',
    label: '压缩上下文',
    description: '把当前对话压缩成摘要再继续（联动记忆库）；命令后可附压缩策略，不附则用默认方法',
    icon: 'archive',
    kind: 'insert',
    usage: '/compact <策略>',
  },
  {
    id: 'settings',
    label: '打开设置',
    description: '打开插件的设置页（模型档案 / 通用 / 技能 / MCP）',
    icon: 'settings',
    kind: 'immediate',
    usage: '/settings',
  },
  {
    id: 'mcp',
    label: 'MCP 服务',
    description: '管理远程 MCP 服务：开关 / 编辑 / 删除 / 添加（仅 streamableHttp）',
    icon: 'plug',
    kind: 'immediate',
    usage: '/mcp',
  },
  {
    id: 'learn',
    label: '结晶技能',
    description: '把本次对话结晶成一个可复用技能，存入技能文件夹',
    icon: 'puzzle',
    kind: 'insert',
    usage: '/learn <要结晶什么>',
  },
]

export interface ThinkOption {
  id: ThinkLevel
  /** Chinese display name — the picker's primary label. */
  label: string
  /** English token shown faint after the label (what "/think <token>" takes). */
  token: string
  description: string
}

// Ordered from NO thinking to the strongest — the list reads as a strength
// scale, top = default/off, bottom = full reasoning.
export const THINK_OPTIONS: ThinkOption[] = [
  {
    id: 'off',
    label: '关闭思考',
    token: 'think-off',
    description: '默认强度：不额外推理（最快、最省）',
  },
  {
    id: 'think',
    label: '标准思考',
    token: 'think',
    description: '适度推理，兼顾速度与质量',
  },
  {
    id: 'think-hard',
    label: '深入思考',
    token: 'think-hard',
    description: '更长的推理链，更慢更准',
  },
  {
    id: 'ultrathink',
    label: '极致思考',
    token: 'ultrathink',
    description: '全力推理（最慢、最贵）',
  },
]

/** M2-T4: 引擎级清单（能力语义装不下的显式名单）——只在 core 引擎有意义
 *  的插件命令，hermes 引擎下隐藏：
 *  - btw:   旁问走插件 LLM 一次性调用，绕过 hermes 当前上下文，易误导；
 *  - hermes: 已经在 hermes 会话里，再「分派 Hermes」是原地套娃；
 *  - learn: 技能结晶走插件 LLM + create_note，与 hermes 会话脱节。 */
export const CORE_ONLY_COMMANDS: string[] = ['btw', 'hermes', 'learn']

/** 命令面板隐藏名单（按引擎）——设置项用户自定义层。hermes 通告命令
 *  的过滤在 core/hermes/advertisedCommands.ts（用户级修订后只剩用户层
 *  加法，原硬编码隐藏名单已移除，九条全露出）。 */
export interface HiddenCommands {
  core: string[]
  hermes: string[]
}

/**
 * M2-T4: 按会话引擎过滤插件命令清单——能力门控（requiresCapability）+
 * 引擎级清单（CORE_ONLY_COMMANDS）+ 用户隐藏名单。hermes 通告命令不在
 * 这里过滤（走 advertisedCommands 的双层名单），见 buildPanelCommands。
 */
export function filterCommandsForEngine(
  cmds: CommandDef[],
  engine: EngineId,
  userHidden: readonly string[] = [],
): CommandDef[] {
  const caps = engineCapabilities(engine)
  const dropUser = new Set(userHidden)
  const dropEngine = engine === 'core' ? null : new Set(CORE_ONLY_COMMANDS)
  return cmds.filter(
    (c) =>
      (!c.requiresCapability || caps.has(c.requiresCapability)) &&
      !dropUser.has(c.id) &&
      !(dropEngine?.has(c.id)),
  )
}

/**
 * M2-T4: hermes 通告命令 → 通用 CommandDef（面板零特判渲染）。润色查
 * HERMES_COMMAND_CATALOG（中文名/图标/说明），未收录回退 /name + terminal
 * 图标。kind 按行为绑定表映射（advertisedSelectAction）：model → 'menu'
 * （选中开模型选择窗，hermes 路径即 hermes 清单）；有 hint → 'insert'
 * （预填 `/<name> ` 由用户接参数）；无 hint → 'immediate'（选中即发，
 * 经 hermes 轮原样透传）。未命中的 /xxx 照常透传（slashPassthrough），
 * 面板有无该项不拦截发送。
 */
export function advertisedToCommandDef(cmd: HermesAdvertisedCommand): CommandDef {
  const meta = HERMES_COMMAND_CATALOG[cmd.name]
  const action = advertisedSelectAction(cmd)
  return {
    id: cmd.name,
    label: meta?.label ?? cmd.name,
    description:
      meta?.description ??
      cmd.description ??
      (cmd.inputHint ? `参数：${cmd.inputHint}` : 'Hermes 原生命令'),
    icon: meta?.icon ?? 'terminal',
    kind: action === 'model-menu' ? 'menu' : action === 'prefill' ? 'insert' : 'immediate',
    usage: cmd.inputHint ? `/${cmd.name} <${cmd.inputHint}>` : `/${cmd.name}`,
    source: 'hermes',
    badge: 'Hermes',
  }
}

/**
 * M2-T4: 命令面板视图构建（useAgent 每轮调用）——插件命令按引擎过滤后，
 * hermes 引擎再并入通告命令（用户隐藏名单已过、标注来源）。面板合并处的
 * 一次引擎判断是唯一允许的落点；命令级可见性全部由 capability/清单驱动。
 *
 * 用户级修订：model 去重——通告侧 model 与插件自有 /model（kind='menu'，
 * hermes 路径已弹 hermes 模型清单，M2-T1）会 id 冲突成双入口，保留插件
 * 自有菜单项作为面板唯一模型入口（选中开窗），通告侧 model 不并入。
 * mode 同款去重：插件自有 /mode（M2-T8 收口改 kind='menu'，选中即弹
 * 审批模式选择窗）优先，通告侧 mode（kind='menu'）在面板中不并入。 */
export function buildPanelCommands(
  engine: EngineId,
  advertised: HermesAdvertisedCommand[],
  hidden?: Partial<HiddenCommands>,
): CommandDef[] {
  const userHidden = (engine === 'core' ? hidden?.core : hidden?.hermes) ?? []
  const base = filterCommandsForEngine(COMMANDS, engine, userHidden)
  if (engine !== 'hermes') return base
  const keepPluginModel = base.some((c) => c.id === 'model')
  const keepPluginMode = base.some((c) => c.id === 'mode')
  return [
    ...base,
    ...filterAdvertisedCommands(advertised, userHidden)
      .filter((c) => !(keepPluginModel && c.name === 'model'))
      .filter((c) => !(keepPluginMode && c.name === 'mode'))
      .map(advertisedToCommandDef),
  ]
}

/** Parse a "/think-hard"-style argument; tolerant of the 'think-off' alias,
 *  the Chinese label, and the displayed token. */
export function parseThinkLevel(arg: string): ThinkLevel | null {
  const a = arg.trim().toLowerCase()
  if (a === 'off' || a === 'think-off' || a === 'no') return 'off'
  const hit = THINK_OPTIONS.find(
    (o) => o.id === a || o.token === a || o.label === a,
  )
  return hit ? hit.id : null
}

/** 任务一 §1.2: /mode 参数的中文别名 → hermes 模式 id。id 与 hermes 侧
 *  SessionModeState 一致（acp_adapter/server.py：default / accept_edits /
 *  dont_ask）。英文 id 原样接受；未知参数返回 null（调用方给用法提示）。 */
const HERMES_MODE_ALIASES: ReadonlyArray<readonly [string, HermesModeId]> = [
  ['默认', 'default'],
  ['询问', 'default'],
  ['default', 'default'],
  ['自动', 'accept_edits'],
  ['自动审批', 'accept_edits'],
  ['accept_edits', 'accept_edits'],
  ['免询', 'dont_ask'],
  ['不要询问', 'dont_ask'],
  ['dont_ask', 'dont_ask'],
]

export function parseHermesModeArg(arg: string): HermesModeId | null {
  const a = arg.trim().toLowerCase()
  if (!a) return null
  const hit = HERMES_MODE_ALIASES.find(([alias]) => alias === a)
  return hit ? hit[1] : null
}

/** 模式 id 的中文文案（/mode 回复与占位状态行共用）。 */
export const HERMES_MODE_LABEL: Record<HermesModeId, string> = {
  default: '默认（逐次询问）',
  accept_edits: '自动（编辑放行）',
  dont_ask: '免询（全部放行）',
}

/** /mode 非法参数的用法提示文案（路由与测试共用同一份）。 */
export const HERMES_MODE_USAGE =
  '用法：/mode <模式> —— 可选：默认|询问（default）、自动|自动审批（accept_edits）、免询|不要询问（dont_ask）；不带参数则弹出选择窗。'

/**
 * Build the agent turn for "/learn <request>": distill the current
 * conversation into a reusable SKILL.md via the existing create_note tool.
 * No distillation engine (same idea as hermes-agent's /learn) — the agent
 * does the work with the tools it already has, and the skill-creator skill is
 * force-loaded alongside when available.
 */
export function buildLearnPrompt(request: string, skillFolder: string): string {
  const folder =
    skillFolder.trim().replace(/^\/+|\/+$/g, '') || 'AI 助手/skills'
  return [
    '请把本次对话结晶成一个可复用的技能（skill）并保存。',
    '',
    `用户对技能的要求：${request}`,
    '',
    '按以下步骤完成：',
    '1. 回顾本次对话的任务、做法与约定，提炼出值得长期复用的步骤；若确实没有可结晶的内容，如实告诉用户并停止。',
    `2. 用 create_note 在 ${folder}/ 下创建技能文件 <技能名>.md：技能名用小写英文短横线形式，描述「一类任务」，不要用今天的一次性细节命名。`,
    '3. 文件开头是 frontmatter：name（同文件名主名）、description（≤60 字的一句话，说清何时使用——AI 靠这句话决定是否载入）、mode: lazy。',
    '4. 正文是纯文本操作指南：【何时使用】【步骤】【注意】三段；可以引用现有工具名（search_notes / read_note / create_note 等），但绝不包含任何可执行代码。',
    '5. 完成后告诉用户技能名、文件路径和一句话总结。',
  ].join('\n')
}
