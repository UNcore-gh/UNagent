// M2-T4: hermes 通告的命令注册表（session/update 的
// available_commands_update）。hermes acp_adapter/server.py 在建会话/恢复
// 会话后下发（_schedule_available_commands_update），帧形态（camelCase）：
//   { sessionUpdate: 'available_commands_update',
//     availableCommands: [
//       { name, description?,
//         input?: { kind: 'unstructured', hint } },   // 有参命令才带 input
//       …
//     ] }
// 通告集 = _ADVERTISED_COMMANDS 九条：help/model/tools/context/reset/
// compress/steer/queue/version（其中 model/steer/queue 带 input.hint）。
// 本模块是纯函数层：帧解析 + 用户隐藏名单 + 选中动作绑定 + 预填串，不碰
// 连接与 UI。
//
// 用户级修订（推翻 M2-T4 硬编码隐藏名单）：九条全部露出到命令面板，选中
// 动作按行为绑定表 + 默认规则走（advertisedSelectAction）——
// - model            → 打开 hermes 模型选择窗（不预填不发送）；
// - mode             → 打开 hermes 审批模式选择窗（不预填不发送）；
// - 有 hint（steer/queue）→ 预填 `/<name> ` 光标接参数；
// - 无 hint（help/tools/context/compress/version/reset）→ 选中即发送，
//   经 hermes 轮原样透传（reset 在 send 透传层前置 ConfirmModal 确认，
//   文案 = HERMES_RESET_CONFIRM）。
// 隐藏只剩用户自定义一层（设置项 general.hiddenCommands.hermes，加法）。

/** 归一化后的一条通告命令。 */
export interface HermesAdvertisedCommand {
  name: string
  description?: string
  /** 输入提示（线上 input.hint）——面板 usage 行与选中预填共用。 */
  inputHint?: string
}

/**
 * 解析 session/update 载荷里的 available_commands_update。非该类型返回
 * null；是该类型但清单缺失/畸形返回空数组（hermes 明确说「没有命令」与
 * 「不是这条帧」是两种语义）。条目级容错：name 非字符串即丢弃该条。
 */
export function parseAvailableCommandsUpdate(
  update: unknown,
): HermesAdvertisedCommand[] | null {
  if (!update || typeof update !== 'object') return null
  const u = update as Record<string, unknown>
  if (u.sessionUpdate !== 'available_commands_update') return null
  const list = u.availableCommands
  if (!Array.isArray(list)) return []
  const out: HermesAdvertisedCommand[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (typeof e.name !== 'string' || e.name.length === 0) continue
    const cmd: HermesAdvertisedCommand = { name: e.name }
    if (typeof e.description === 'string' && e.description.length > 0) {
      cmd.description = e.description
    }
    // ACP CommandInput 联合里的 unstructured 形态 { kind, hint }；宽松兼容
    // 扁平 inputHint 写法（老帧/手输测试帧）。
    let hint: string | undefined
    const input = e.input
    if (input && typeof input === 'object') {
      const h = (input as Record<string, unknown>).hint
      if (typeof h === 'string' && h.length > 0) hint = h
    }
    if (!hint && typeof e.inputHint === 'string' && e.inputHint.length > 0) {
      hint = e.inputHint
    }
    if (hint) cmd.inputHint = hint
    out.push(cmd)
  }
  return out
}

/**
 * 用户隐藏名单过滤（用户级修订后仅剩这一层）：hermes 通告九条默认全部
 * 露出，用户在设置里按引擎维护的名单只做加法（隐藏）。原 M2-T4 硬编码
 * 隐藏名单（help/model/compress/reset/version）已移除——面板太单薄、切换
 * 模型费劲；语义重叠改由选中动作绑定解决（见模块头部行为绑定表）。
 */
export function filterAdvertisedCommands(
  cmds: HermesAdvertisedCommand[],
  userHidden: readonly string[],
): HermesAdvertisedCommand[] {
  const drop = new Set<string>(userHidden)
  return cmds.filter((c) => !drop.has(c.name))
}

/**
 * 插件侧合成命令：不在 hermes 原生注册表里，但面板必须常驻露出
 * （live 注册表同步后也不消失）。行为经 advertisedSelectAction 绑定
 * （mode → 开审批模式选择窗）。同样过用户隐藏名单。
 */
export const HERMES_SYNTHETIC_COMMANDS: readonly HermesAdvertisedCommand[] = [
  {
    name: 'mode',
    description:
      'Show or switch Hermes approval mode (default / accept_edits / dont_ask)',
  },
]

/**
 * 面板命令构建（通告清单 + 合成命令合并）：通告清单（live 注册表或
 * 静态兑底）过用户隐藏名单后，并入合成命令（同样过名单）——合成命令
 * 不依赖 live 同步，会话建立/恢复后依旧常驻。
 */
export function buildHermesPanelCommands(
  advertised: readonly HermesAdvertisedCommand[],
  userHidden: readonly string[],
): HermesAdvertisedCommand[] {
  const drop = new Set<string>(userHidden)
  return [
    ...advertised.filter((c) => !drop.has(c.name)),
    ...HERMES_SYNTHETIC_COMMANDS.filter((c) => !drop.has(c.name)),
  ]
}

/** 面板选中一条通告命令后的动作（行为绑定表 + 默认规则的唯一真相源，
 *  主 Composer 的通告项选中路径使用）。 */
export type AdvertisedSelectAction =
  | 'model-menu' // model 例外：打开 hermes 模型选择窗（不预填不发送）
  | 'mode-menu' // mode 例外：打开 hermes 审批模式选择窗（不预填不发送）
  | 'prefill' // 有 inputHint：预填 `/<name> ` 光标接参数
  | 'send' // 无 hint：选中即发送（reset 的确认由 send 透传层兜）

export function advertisedSelectAction(
  cmd: HermesAdvertisedCommand,
): AdvertisedSelectAction {
  if (cmd.name === 'model') return 'model-menu'
  if (cmd.name === 'mode') return 'mode-menu'
  return cmd.inputHint ? 'prefill' : 'send'
}

/** /reset 透传前置确认的文案（send 层拦截与测试共用同一份）：hermes
 *  /reset 只清 hermes 侧 state.db 历史，插件侧对话实录保留，两边会脱节。 */
export const HERMES_RESET_CONFIRM = {
  title: '确认 /reset',
  message:
    '将清空 hermes 侧对话历史，插件侧消息保留，两边会脱节。确定继续？',
} as const

/** 选中一条命令后面板预填的串：`/<name> `（带尾空格，光标接参数）。 */
export function commandPrefill(name: string): string {
  return `/${name} `
}

/**
 * 静态兜底清单：会话尚未同步到 live 注册表（刚进 hermes 模式、还没跑过
 * 一轮）时垫底用——内容与 hermes _ADVERTISED_COMMANDS 逐条对齐（含三条
 * input.hint）。同样要过用户隐藏名单。
 */
export const HERMES_ADVERTISED_FALLBACK: readonly HermesAdvertisedCommand[] = [
  { name: 'help', description: 'List available commands' },
  {
    name: 'model',
    description: 'Show current model and provider, or switch models',
    inputHint: 'model name to switch to',
  },
  { name: 'tools', description: 'List available tools with descriptions' },
  { name: 'context', description: 'Show conversation message counts by role' },
  { name: 'reset', description: 'Clear conversation history' },
  { name: 'compress', description: 'Compress conversation context' },
  {
    name: 'steer',
    description: 'Inject guidance into the currently running agent turn',
    inputHint: 'guidance for the active turn',
  },
  {
    name: 'queue',
    description: 'Queue a prompt to run after the current turn finishes',
    inputHint: 'prompt to run next',
  },
  { name: 'version', description: 'Show Hermes version' },
]
