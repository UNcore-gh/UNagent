// 审批模式（M2-T8 主 agent 还原）：主 agent 与 hermes 共用同一套模式语义。
// hermes 侧对应 session/set_mode 的 HermesModeId（core/hermes/types.ts 引用
// 本文件，依赖方向 hermes → agent 单向，禁止反向）。
//
// 主 agent 在工具执行前按模式决定是否弹审批面板（agentRunner 的
// destructiveNeedsConfirm）：
// - default      = 破坏性操作每次都弹（逐次询问）；
// - accept_edits = 编辑类工具（category 'write'，即 edit_note）自动放行，
//                  删除/移动等仍弹——对齐 hermes「vault 内编辑自动放行」；
// - dont_ask     = 全部放行（forceConfirm 的 delete_note 仍强制确认——
//                  插件铁律，任何模式不豁免）。
//
// 设置侧：主 agent 用 SafetySettings.approvalMode（/mode 命令双引擎可切）；
// hermes 会话沿用 localAgent.approvalMode + 会话 override（每轮幂等
// set_mode）。敏感路径豁免（.git/.ssh/.env）是 hermes 服务端行为，插件侧
// 无此概念——dont_ask 即全放行。

/** 审批模式 id（结构上 = hermes 的 HermesModeId，跨引擎共用）。 */
export type ApprovalModeId = 'default' | 'accept_edits' | 'dont_ask'

/** 全部模式，按展示顺序排列（/mode 选择窗与设置页下拉共用）。 */
export const APPROVAL_MODES: readonly ApprovalModeId[] = [
  'default',
  'accept_edits',
  'dont_ask',
]

/** 模式 id 的中文文案（/mode 回复、选择窗与设置页共用）。 */
export const APPROVAL_MODE_LABEL: Record<ApprovalModeId, string> = {
  default: '默认（逐次询问）',
  accept_edits: '自动（编辑放行）',
  dont_ask: '免询（全部放行）',
}
