// HermesApprovalPanel (补刀·五十六 / M2-T7): approval surface for hermes
// ACP permission requests (session/request_permission) — rendered in the same
// slot as AskPanel while a hermes turn is pending. Two request flavors:
// dangerous terminal commands (kind=execute, text "description\n$ command")
// and pre-execution file edits (kind=edit, diff content). Answering sends
// the JSON-RPC result back through the hub; closing/denying answers
// cancelled, which hermes treats as deny (fail-closed). Ignoring it is safe:
// the hub auto-cancels after 55s, ahead of hermes' own 60s deny.
//
// M2-T7: edit 类载荷经 blockMapper.parseHermesPermissionRequest 解析为行级
// unified diff（新增绿 / 删除红 / 等宽字体），超长折叠 + 内部滚动。hermes
// 为桌面专属，不做移动端适配权衡。
//
// 按钮统一（M2-T8 收口）：actions 区固定 Yes / No 两枚按钮，不再透传服务
// 端 options——服务端恒带 deny 选项（permissions.py 无条件追加 Deny），与
// 插件固定的拒绝按钮重复成两个拒绝入口。Yes = 首个 allow 类选项（服务端
// 恒 allow_once 在前，最保守的一次性批准；session/always 快捷项不在此面
// 板暴露，由 hermes 侧审批模式控制）；No = onAnswer(null)（fail-closed，
// 与 hermes deny 同语义）。options 无 allow 类时只留 No 兜底。
// 布局（同轮收口）：actions 并入 header 行——Yes/No 与标题同行、右对齐，
// 不再独占底部一行；按钮高度 24px 与 header 行等高适配（styles.css）。

import { useMemo, useState } from 'react'
import { Icon } from '../Icon'
import type { PermissionRequestEvent } from '../../core/hermes/hermesHub'
import type { HermesDiffFile, HermesDiffLine } from '../../core/hermes/blockMapper'
import { parseHermesPermissionRequest } from '../../core/hermes/blockMapper'

export const KIND_LABEL: Record<string, string> = {
  execute: '执行命令',
  edit: '编辑文件',
  read: '读取',
  delete: '删除',
  other: '操作',
}

/** 超过此行数的 diff 默认折叠，只露头部预览。 */
const DIFF_COLLAPSE_LINES = 120
/** 折叠态预览行数。 */
const DIFF_COLLAPSED_PREVIEW = 14

const LINE_SIGN: Record<HermesDiffLine['type'], string> = {
  add: '+',
  del: '−',
  ctx: ' ',
}

function DiffLineRow({ line }: { line: HermesDiffLine }): JSX.Element {
  return (
    <div className="UNagent-hermes-approval-diff-line" data-diff-type={line.type}>
      <span className="UNagent-hermes-approval-diff-sign">{LINE_SIGN[line.type]}</span>
      <span className="UNagent-hermes-approval-diff-text">{line.text}</span>
    </div>
  )
}

function DiffFileBlock({ file }: { file: HermesDiffFile }): JSX.Element {
  const collapsible = file.lines.length > DIFF_COLLAPSE_LINES
  const [expanded, setExpanded] = useState(!collapsible)
  const shown = expanded ? file.lines : file.lines.slice(0, DIFF_COLLAPSED_PREVIEW)
  const hidden = file.lines.length - shown.length

  return (
    <div className="UNagent-hermes-approval-diff-file">
      <div className="UNagent-hermes-approval-diff-head">
        <span className="UNagent-hermes-approval-diff-path" title={file.path}>
          <Icon name={file.isNewFile ? 'file-plus' : 'file-diff'} fallback="file" />
          {file.path}
        </span>
        <span className="UNagent-hermes-approval-diff-stats">
          {file.isNewFile && (
            <span className="UNagent-hermes-approval-diff-badge">新文件</span>
          )}
          <span className="UNagent-hermes-approval-diff-add">+{file.additions}</span>
          <span className="UNagent-hermes-approval-diff-del">−{file.deletions}</span>
        </span>
        {collapsible && (
          <button
            className="UNagent-hermes-approval-diff-toggle"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? '折叠' : '展开全部'}
          >
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
            {expanded ? '折叠' : `展开（${file.totalLines} 行）`}
          </button>
        )}
      </div>
      <div
        className="UNagent-hermes-approval-diff-body"
        data-collapsed={collapsible && !expanded ? 'true' : undefined}
      >
        {shown.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
        {file.truncated && (
          <div className="UNagent-hermes-approval-diff-note">
            … 已截断，共 {file.totalLines} 行
          </div>
        )}
        {!file.truncated && hidden > 0 && (
          <div className="UNagent-hermes-approval-diff-note">… 还有 {hidden} 行</div>
        )}
      </div>
    </div>
  )
}

export function HermesApprovalPanel(props: {
  event: PermissionRequestEvent
  onAnswer: (optionId: string | null) => void
}): JSX.Element {
  const { event, onAnswer } = props
  const model = useMemo(
    () => parseHermesPermissionRequest(event.request),
    [event.request],
  )
  const kind = model.kind
  const options = event.request.options ?? []
  // Yes = 首个 allow 类选项；服务端顺序恒 allow_once 在前（permissions.py），
  // 取最保守的一次性批准，避免点 Yes 落成 session/always 永久授权。
  const allowOption = options.find((opt) => opt.optionId.startsWith('allow'))

  return (
    <div className="UNagent-hermes-approval">
      <div className="UNagent-hermes-approval-header">
        <span className="UNagent-hermes-approval-title">
          <Icon name="shield-question" />
          Hermes 请求批准
          <span
            className="UNagent-hermes-approval-kind"
            data-kind={kind}
          >
            {KIND_LABEL[kind] ?? kind}
          </span>
        </span>
        <button
          className="UNagent-hermes-approval-close"
          onClick={() => onAnswer(null)}
          title="取消"
          aria-label="取消"
        >
          <Icon name="x" />
        </button>
        {/* M2-T8 收口：Yes/No 上移第一行（header 行）右对齐，不再独占底部一行 */}
        <div className="UNagent-hermes-approval-actions">
          {allowOption && (
            <button
              className="UNagent-hermes-approval-option"
              data-option-kind="allow"
              onClick={() => onAnswer(allowOption.optionId)}
            >
              Yes
            </button>
          )}
          <button
            className="UNagent-hermes-approval-deny"
            onClick={() => onAnswer(null)}
          >
            No
          </button>
        </div>
      </div>

      {model.title && (
        <div className="UNagent-hermes-approval-tool">{model.title}</div>
      )}

      {model.texts.map((t, i) => (
        <pre key={`t${i}`} className="UNagent-hermes-approval-text">
          {t}
        </pre>
      ))}

      {model.diffs.map((d, i) => (
        <DiffFileBlock key={`d${i}`} file={d} />
      ))}
    </div>
  )
}
