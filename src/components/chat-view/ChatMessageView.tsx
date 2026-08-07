import React from 'react'

import { useSettings } from '../../contexts/settings-context'
import { Icon } from '../Icon'
import { ErrorBoundary } from './ErrorBoundary'
import { Markdown } from './Markdown'
import { ReferenceText } from './ReferenceText'
import { ToolChainBlock } from './ToolChainBlock'
import type { ToolBlock } from './ToolChainBlock'
import { ImageBlock } from './ImageBlock'
import { TodoBlock } from './TodoBlock'
import { activeOf, UiBlock, UiMessage } from './types'

/** The five icon-only action buttons under an assistant message (追加46/48) —
 *  they mirror the existing /-commands (/branch, /rewind) plus regenerate/
 *  quote/copy entry points. Memoized per-message: handlers are recreated
 *  when messages change. */
export interface MessageActions {
  /** /branch — fork the current conversation into a child branch. */
  onBranch(): void
  /** Regenerate THIS answer (re-ask the turn's own question, 追加46 修正 —
   *  NOT a backtrack). */
  onRegenerate(): void
  /** /rewind — direct backtrack to before this answer's turn (追加69:
   *  no longer opens the picker; the picker is the /rewind command's job). */
  onBacktrack(): void
  /** Insert a `[[msg:conv/msg]]「…」` reference to this message. */
  onQuote(): void
  /** Copy this message's plain text to the clipboard. */
  onCopy(): void
}

/** Success-state verb for each '/'-command that gets a status pill. */
const COMMAND_STATUS: Record<string, string> = {
  btw: '已执行',
  learn: '已执行',
  compact: '已压缩',
  hermes: '已完成',
  // 任务一 §1.2: /mode 切换成功的状态徽章。
  mode: '已切换',
}

/**
 * Render a message's blocks, coalescing each run of consecutive tool blocks
 * into ONE thought chain (ToolChainBlock); a text block breaks the run, so
 * chains stay per-"thought" instead of one giant card per message.
 * Every text block is wrapped in an ErrorBoundary: one broken ReferenceText
 * never takes the whole chat with it (用户报: 大量内容时界面消失).
 */
function renderBlocks(blocks: UiBlock[]): React.ReactNode[] {
  const items: React.ReactNode[] = []
  let chain: ToolBlock[] = []
  const flush = (key: string) => {
    if (chain.length > 0) {
      items.push(<ToolChainBlock key={key} blocks={chain} />)
      // Extract generate_image blocks for main-body display (always visible
      // even when the thought chain is collapsed, with action buttons).
      chain.forEach((b) => {
        if (b.name === 'generate_image' && b.state === 'done' && b.output != null) {
          items.push(
            <ErrorBoundary key={`img-${b.callId}`} kind="image-block">
              <ImageBlock output={b.output} />
            </ErrorBoundary>,
          )
        }
      })
      chain = []
    }
  }
  blocks.forEach((block, i) => {
    if (block.kind === 'text') {
      flush(`chain-${i}`)
      if (block.text) {
        items.push(
          <ErrorBoundary key={`text-${i}`} kind="reference-text">
            <ReferenceText content={block.text} />
          </ErrorBoundary>,
        )
      }
    } else if (block.kind === 'todo') {
      // The task list (清单) is its own card — it breaks the tool-chain run
      // just like a text block does.
      flush(`chain-${i}`)
      items.push(<TodoBlock key={`todo-${i}`} block={block} />)
    } else {
      chain = [...chain, block]
    }
  })
  flush(`chain-${blocks.length}`)
  return items
}

/**
 * memo: streaming updates only replace the in-flight message's object —
 * every other message keeps its reference, so React skips re-rendering
 * them (and re-parsing their markdown) entirely. Without this, each
 * streamed chunk re-rendered the whole conversation — sustained CPU/GC
 * pressure on mobile WKWebView (移动端, 插件"自动关闭"的根因之一).
 */
export const ChatMessageView = React.memo(function ChatMessageView({
  message,
  hideRole = false,
  assistantLabel,
  actions,
  editing = false,
  onEditStart,
  onSwitchVersion,
}: {
  message: UiMessage
  /** Drop the role label (你/AI) — the inline editor answer stays bare and
   *  compact, 补刀. */
  hideRole?: boolean
  /** Assistant-name override (多 Agent 体系, 追加㊼): in a sub-agent
   *  conversation the role label shows the AGENT's name instead of the
   *  global assistantName; Hermes 模式下统一传「Hermes」。 */
  assistantLabel?: string
  /** Assistant-message action row (分支/重新/引用/复制, 追加46). */
  actions?: MessageActions
  /** Flip the shown answer version ◀ N/M ▶ (追加52). */
  onSwitchVersion?: (dir: -1 | 1) => void
  /** This user message is being edited IN THE COMPOSER (追加48) — highlight
   *  the bubble, the textarea lives in the composer now. */
  editing?: boolean
  onEditStart?: () => void
}) {
  // Role names are user-customizable (追加⑱: general.userName/assistantName).
  // 空值在显示端回落默认（追加㊳：设置项不再逼回默认字，允许删干净重打）。
  const { settings } = useSettings()
  const isUser = message.role === 'user'
  // The version currently shown (追加52): an answer with versions reads its
  // body unless the ◀ N/M ▶ switcher pinned an earlier one.
  const v = activeOf(message)
  const roleName = isUser
    ? settings.general.userName.trim() || '你'
    : assistantLabel ?? (settings.general.assistantName.trim() || 'AI')
  // Ephemeral /btw exchange: rendered but marked — never part of the
  // conversation (excluded from history, persistence, turn counting).
  const ephemeral = message.ephemeral === true

  if (isUser) {
    return (
      <div
        className={`UNagent-message UNagent-message--user${
          ephemeral ? ' UNagent-message--ephemeral' : ''
        }${editing ? ' UNagent-message--editing' : ''}`}
        data-ai-msg-id={message.id}
        onDoubleClick={
          ephemeral || !onEditStart
            ? undefined
            : (e) => {
                e.preventDefault()
                onEditStart()
              }
        }
        title={ephemeral || !onEditStart ? undefined : '双击编辑此消息'}
      >
        {!hideRole && <div className="UNagent-message-role">{roleName}</div>}
        {ephemeral && (
          <div className="UNagent-message-btw">
            <Icon name="message-circle" />
            顺便一问 · 不计入上下文
          </div>
        )}
        {/* 追加86: 编辑态徽章——与 btw 提示/命令状态 pill 同族的小胶囊，
            明示「这条正在重编辑、改完在底部输入框发送」（双击或 /edit 进入）。 */}
        {editing && (
          <div className="UNagent-message-edit-badge">
            <Icon name="pencil" fallback="edit" />
            正在重新编辑 · 在下方输入框修改后发送
          </div>
        )}
        {/* User text gets the SAME native rendering + chips as AI answers
            (追加㊺): markdown, [[引用]] chips and inline /cmd · //skill pills
            alike — wrapped so a broken block never blanks the chat. */}
        <div className="UNagent-message-user-text">
          <ErrorBoundary key={`user-${message.id}`} kind="reference-text">
            <ReferenceText content={message.content ?? ''} />
          </ErrorBoundary>
        </div>
      </div>
    )
  }

  const blocks = v.blocks ?? []
  const versions = message.versions
  const versionTotal = versions?.length ?? 0
  const versionCur = Math.min(
    message.activeVersion ?? versionTotal - 1,
    versionTotal - 1,
  )
  return (
    <div
      className={`UNagent-message UNagent-message--assistant${
        ephemeral ? ' UNagent-message--ephemeral' : ''
      }`}
      data-ai-msg-id={message.id}
    >
      {!hideRole && <div className="UNagent-message-role">{roleName}</div>}
      {v.command && !v.error && (
        <span className="UNagent-command-status">
          <span className="UNagent-command-status-check">✓</span>
          /{v.command} {COMMAND_STATUS[v.command] ?? '已执行'}
        </span>
      )}
      {ephemeral && (
        <div className="UNagent-message-btw">
          <Icon name="message-circle" />
          顺便一问 · 不计入上下文
        </div>
      )}

      {v.error ? (
        <div className="UNagent-message-error">
          <div className="UNagent-message-error-head">
            <Icon name="alert-triangle" />
            <span className="UNagent-message-error-title">
              {v.errorInfo?.title ?? '请求出错'}
            </span>
            {v.errorInfo?.status != null && (
              <span className="UNagent-message-error-status">
                HTTP {v.errorInfo.status}
              </span>
            )}
          </div>
          <div className="UNagent-message-error-body">{v.error}</div>
          {v.errorInfo?.suggestion && (
            <div className="UNagent-message-error-hint">
              {v.errorInfo.suggestion}
            </div>
          )}
          {v.errorInfo?.raw &&
            v.errorInfo.raw !== v.error && (
              <details className="UNagent-message-error-detail">
                <summary>服务返回的原始信息</summary>
                <pre>{v.errorInfo.raw}</pre>
              </details>
            )}
        </div>
      ) : null}

      {renderBlocks(blocks)}

      {!v.error && blocks.length === 0 && v.isStreaming ? (
        <Markdown content="…" />
      ) : null}

      {(actions || versionTotal > 1) && (
        <div className="UNagent-message-actions">
          {actions && !v.error && !ephemeral && !v.isStreaming && (
            <>
              <button
            className="UNagent-msg-action"
            onClick={actions.onBranch}
            title="分支对话：复制当前对话为独立分支（/branch）"
          >
            <Icon name="git-branch" fallback="share-2" />
          </button>
          <button
            className="UNagent-msg-action"
            onClick={actions.onRegenerate}
            title="重新输出：对这条回答不满意，让 AI 重新生成（保留本轮提问）"
          >
            <Icon name="rotate-ccw" />
          </button>
          <button
            className="UNagent-msg-action"
            onClick={actions.onBacktrack}
            title="回溯：回到这条回答之前重新开始（/rewind）"
          >
            <Icon name="undo-2" />
          </button>
          <button
            className="UNagent-msg-action"
            onClick={actions.onQuote}
            title="引用对话：把这条消息作为引用插入输入框（精确定位到对话位置）"
          >
            <Icon name="quote" fallback="message-square" />
          </button>
          <button
            className="UNagent-msg-action"
            onClick={actions.onCopy}
            title="复制对话：把这条消息的文本复制到剪贴板"
          >
            <Icon name="copy" />
          </button>
            </>
          )}

          {versionTotal > 1 && (
            <span className="UNagent-msg-versions">
              <button
                className="UNagent-msg-versions-btn"
                onClick={() => onSwitchVersion?.(-1)}
                disabled={versionCur <= 0}
                aria-label="上一个版本"
                title="上一个版本"
              >
                <Icon name="chevron-left" />
              </button>
              <span className="UNagent-msg-versions-count">
                {versionCur + 1} / {versionTotal}
              </span>
              <button
                className="UNagent-msg-versions-btn"
                onClick={() => onSwitchVersion?.(1)}
                disabled={versionCur >= versionTotal - 1}
                aria-label="下一个版本"
                title="下一个版本"
              >
                <Icon name="chevron-right" />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
})
