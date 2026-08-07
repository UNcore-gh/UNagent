// 引擎能力模型（M2-T4 §2）：每个会话引擎「会什么」。命令面板的命令级
// 可见性只由能力声明（CommandDef.requiresCapability）+ 引擎级清单驱动，
// 禁止在渲染/过滤路径散落 `if (engine === 'hermes')` 特判——面板合并处
// 的一次引擎判断是唯一允许的落点（buildPanelCommands）。

export type EngineId = 'core' | 'hermes'

export type EngineCapability =
  | 'slashPassthrough' // / 文本透传给运行时本地拦截
  | 'extendedThinking' // /think 有意义
  | 'localCompaction' // 插件侧 /compact
  | 'approvalModes' // hermes 会话审批模式（session/set_mode）——/mode 挂此门
  | 'hermesDesktop' // 在 Hermes 桌面端打开当前会话（/hermes-open）——core 无桌面端会话

const CAPABILITY_TABLE: Record<EngineId, ReadonlyArray<EngineCapability>> = {
  // core = 插件自有 LLM agent 循环：思考档位与插件侧压缩都是真实能力。
  core: ['extendedThinking', 'localCompaction'],
  // hermes = 整轮由本机 hermes 原生驱动：未命中的 /xxx 原样透传给 hermes
  // 本地拦截（slashPassthrough）。插件侧 /think 对它无效（隐藏）；/compact
  // 是例外——面板保持可见，发送时路由改写成 hermes 原生 /compress（M2-T5），
  // 所以 /compact 不挂 localCompaction 门槛。审批模式是 hermes 会话的真实
  // 能力（session/set_mode：default/accept_edits/dont_ask），/mode 挂
  // approvalModes 门控——core 引擎无此能力即隐藏（任务一 §1.2）。桌面端
  // 打开（/hermes-open）同样只在 hermes 会话有意义（对话由 hermes 驱动、
  // 会话在 hermes state.db 里）——core 引擎无此能力即隐藏。
  hermes: ['slashPassthrough', 'approvalModes', 'hermesDesktop'],
}

/** 取引擎的能力集（每次返回新 Set，调用方可安全增删）。 */
export function engineCapabilities(engine: EngineId): Set<EngineCapability> {
  return new Set(CAPABILITY_TABLE[engine])
}

/** 引擎是否具备某能力（能力门控的最小读接口）。 */
export function engineHasCapability(
  engine: EngineId,
  capability: EngineCapability,
): boolean {
  return CAPABILITY_TABLE[engine].includes(capability)
}
