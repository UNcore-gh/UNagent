// ConfirmApprovalPanel (M2-T8 主 agent 审批还原): 主 agent 破坏性工具的审
// 批面板——与 HermesApprovalPanel 同一形态（标题 + kind 徽章 + 正文 +
// Yes/No 两枚按钮），复用 UNagent-hermes-approval-* 样式类保证视觉与
// 交互百分百一致。数据面是插件侧 ConfirmRequest（agentRunner 的 ctx.confirm
// 桥到 React 槽位），不是 hermes ACP 协议；diff 类载荷 hermes 专属，主 agent
// 面板只展示文本（工具参数/自定义摘要）。移动端可用（无桌面专属依赖）。
//
// 模式语义（谁需要审批）在 agentRunner.destructiveNeedsConfirm 计算，本组
// 件只负责「需要审批时的展示与回答」：Yes = 放行本轮工具调用，No = 拒绝
// （工具收到 user_cancelled，与 hermes 面板 No = fail-closed 拒绝同语义）。

import { Icon } from '../Icon'
import type { ConfirmRequest } from '../../core/agent/types'
import { KIND_LABEL } from './HermesApprovalPanel'

/** 工具名 → kind 徽章映射（对齐 HermesApprovalPanel 的 kind 语义）。 */
function kindOfTool(toolName: string): string {
  if (toolName === 'delete_note' || toolName === 'delete_conversation') {
    return 'delete'
  }
  if (toolName === 'edit_note') return 'edit'
  return 'other'
}

export function ConfirmApprovalPanel(props: {
  request: ConfirmRequest
  onAnswer: (ok: boolean) => void
}): JSX.Element {
  const { request, onAnswer } = props
  const kind = kindOfTool(request.toolName)

  return (
    <div className="UNagent-hermes-approval">
      <div className="UNagent-hermes-approval-header">
        <span className="UNagent-hermes-approval-title">
          <Icon name="shield-question" />
          {request.title}
          <span className="UNagent-hermes-approval-kind" data-kind={kind}>
            {KIND_LABEL[kind] ?? kind}
          </span>
        </span>
        <button
          className="UNagent-hermes-approval-close"
          onClick={() => onAnswer(false)}
          title="拒绝"
          aria-label="拒绝"
        >
          <Icon name="x" />
        </button>
        {/* M2-T8 收口：Yes/No 上移第一行（header 行）右对齐（与 HermesApprovalPanel 同款） */}
        <div className="UNagent-hermes-approval-actions">
          <button
            className="UNagent-hermes-approval-option"
            data-option-kind="allow"
            onClick={() => onAnswer(true)}
          >
            Yes
          </button>
          <button
            className="UNagent-hermes-approval-deny"
            onClick={() => onAnswer(false)}
          >
            No
          </button>
        </div>
      </div>

      <pre className="UNagent-hermes-approval-text">{request.message}</pre>
    </div>
  )
}
