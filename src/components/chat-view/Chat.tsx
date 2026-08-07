import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Notice, Platform } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'

import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  resolveActiveModel,
  resolveContextWindow,
  resolveSessionModel,
  configuredModelNameSet,
} from '../../settings/settings'
import { nearLimit, compactHint } from '../../utils/contextBudget'
import {
  SYSTEM_PROMPT_OVERHEAD,
  estimateMessagesTokens,
  formatTokens,
} from '../../utils/tokens'
import { Icon } from '../Icon'
import { relTime } from '../../utils/relTime'
import { useAgentBridge } from './agentBridge'
import { ChatMessageView } from './ChatMessageView'
import type { MessageActions } from './ChatMessageView'
import { COMPOSER_HINTS, Composer } from './Composer'
import type { ComposerHandle } from './Composer'
import { ConversationNav } from './ConversationNav'
import { BacktrackMenu } from './BacktrackMenu'
import { cleanSelection } from '../../utils/selectionRef'
import { AskPanel } from './AskPanel'
import { HermesApprovalPanel } from './HermesApprovalPanel'
import { ConfirmApprovalPanel } from './ConfirmApprovalPanel'
import { SuggestionsPanel } from './SuggestionsPanel'
import { askName } from './NameInputModal'
import { textOfBlocks, backtrackablePoints, turnPoints } from './types'
import type { UiMessage } from './types'
import { useAutoScroll } from './useAutoScroll'
import { useKeyboardLift } from './useKeyboardLift'
import { CommandPicker, type PickerItem } from './CommandPicker'
import { buildHermesModelRows, buildHermesModeRows } from '../../core/hermes/sessionStates'
import type { HermesPickerRow } from '../../core/hermes/sessionStates'
import { getHermesHub } from '../../core/hermes/hermesHub'
import type { HermesConnState } from '../../core/hermes/hermesHub'
import {
  APPROVAL_MODES,
  APPROVAL_MODE_LABEL,
  type ApprovalModeId,
} from '../../core/agent/approval'

/** core 引擎 /mode 选择窗的每模式简短描述（对齐 hermes 模式语义）。 */
const CORE_MODE_DESC: Record<ApprovalModeId, string> = {
  default: '危险操作与文件编辑每次都问',
  accept_edits: '文件编辑自动放行，删除 / 移动等仍问',
  dont_ask: '全部自动放行（删除笔记仍强制确认）',
}

export const Chat = ({ leaf }: { leaf?: WorkspaceLeaf }) => {
  const plugin = usePlugin()
  const { settings } = useSettings()
  // The conversation agent lives in a hidden host root (追加⑰); the chat
  // panel binds to it through the bridge — the SAME agent the editor's
  // inline box uses, so both drive one conversation. Null only for the
  // first instants after plugin load, before the host's first commit.
  const agent = useAgentBridge(plugin.agentBridge)
  // 补刀·五十九: Hermes 服务连接状态灯——hub 单例订阅（idle/connecting 灰、
  // ready 绿、failed 红）。pill 常驻（启用 Hermes 即显示），主对话与 hermes
  // 对话共用，不随模式切换消失。
  const [hermesConnState, setHermesConnState] = useState<HermesConnState>(
    () => getHermesHub().connState,
  )
  useEffect(() => {
    return getHermesHub().subscribe(() => {
      setHermesConnState(getHermesHub().connState)
    })
  }, [])
  // Blank-screen teaching (追加⑰): a random @// guide in the middle of the
  // empty conversation — picked once per mount. 追加㊾ 扩展为全功能随机提示。
  const [emptyHint] = useState(
    () => COMPOSER_HINTS[Math.floor(Math.random() * COMPOSER_HINTS.length)],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  // Root of the chat panel — publishes the live visual-viewport height as
  // --ai-vvh so absolutely-positioned popups (the / command palette, @
  // mention picker, //skill picker) can cap their max-height on the
  // keyboard-shrunk viewport instead of 100vh (which keeps the full
  // layout-viewport size and lets the popup top spill off-screen behind
  // the keyboard on iPad).
  const rootRef = useRef<HTMLDivElement>(null)
  const { autoScrollToBottom, resetPreventAutoScroll } = useAutoScroll(scrollRef)

  // On-screen keyboard adaptation, unified across all four mobile views
  // (Android/iPad × main area/side drawer) — see useKeyboardLift.ts. It
  // prefers Obsidian's native --keyboard-height, falls back to
  // visualViewport, and estimates only as a last resort. Outputs the
  // .is-keyboard class plus --ai-kb / --ai-vvh, which styles.css consumes
  // to pin the composer's bottom edge flush against the keyboard top and
  // zero the safe-area/66px paddings. Desktop is untouched. The app arg
  // enables on-device diag lines (diag:kb-open/kb-close) in the boot log.
  const keyboardOpen = useKeyboardLift(rootRef, plugin.app)

  // Inline-edit state (追加46/48): the user message being edited — the
  // editing happens IN THE COMPOSER (double-click loads the text there), so
  // this id only drives the bubble highlight + the composer edit bar.
  const [editingId, setEditingId] = useState<string | null>(null)

  // Backtrack picker (追加51): which turn to rewind to — opened from the
  // undo button on an assistant message, anchored at the button's corner.
  const [backtrackAt, setBacktrackAt] = useState<{ x: number; y: number } | null>(
    null,
  )

  // Conversation-manager open state lives HERE (not in the composer, 追加⑯)
  // so the title button can TOGGLE it — a second tap closes what the first
  // opened. `origin` decides where the sheet renders: a title-bar tap docks
  // it in the slot right below the header (the composer portals it there);
  // the /chats command keeps the classic position above the composer.
  const [chatsOpen, setChatsOpen] = useState(false)
  const [chatsOrigin, setChatsOrigin] = useState<'title' | 'command'>('title')
  const dockRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const chatsPanelRef = useRef<HTMLDivElement | null>(null)

  // Register the composer's focus handle so the Alt+Z command can jump to the
  // input box (and optionally pre-fill a selection reference, 补刀·五十一).
  // Keyed by THIS instance's leaf: on iPad the drawer and a main-area tab
  // coexist, and the command must focus exactly the instance it revealed.
  useEffect(() => {
    plugin.setComposerFocusHandler(leaf ?? null, ({ reference }) => {
      composerRef.current?.focusInput(reference)
    })
    return () => plugin.setComposerFocusHandler(leaf ?? null, null)
  }, [plugin, leaf])

  const toggleChats = useCallback(() => {
    setChatsOrigin('title')
    setChatsOpen((open) => !open)
  }, [])

  const handleChatsOpenChange = useCallback(
    (open: boolean, origin?: 'title' | 'command') => {
      if (origin) setChatsOrigin(origin)
      setChatsOpen(open)
    },
    [agent],
  )

  // Re-render when the undo stack changes so the button state stays accurate.
  const [, setUndoTick] = useState(0)
  useEffect(() => plugin.undoStack.onChange(() => setUndoTick((t) => t + 1)), [plugin])

  const [showAgentMenu, setShowAgentMenu] = useState(false)
  // 追加97: 面板关闭三通道——① 点击面板外任意空白（document pointerdown，
  // 排除面板与 pill 自身）② 二次点击 pill（click toggle）③ Esc（下方
  // useEffect）。refs 供外部点击判定排除区。
  const pillRef = useRef<HTMLButtonElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)

  // 追加⑧：agent pill 浮窗按 Esc 关闭。
  useEffect(() => {
    if (!showAgentMenu) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAgentMenu(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showAgentMenu])

  // 追加97: 点击面板外任意空白关闭——菜单内部点击（选择行/拖滚动条）与
  // pill 自身不触发；pill 的二次点击关闭由 click toggle 处理，避免与外
  // 部点击监听互相抢关。
  useEffect(() => {
    if (!showAgentMenu) return
    const handler = (e: PointerEvent) => {
      const t = e.target as Node
      if (agentMenuRef.current?.contains(t)) return
      if (pillRef.current?.contains(t)) return
      setShowAgentMenu(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [showAgentMenu])

  useEffect(() => {
    // 回溯/删除消息后重置 preventAutoScroll，避免 scrollTop 被浏览器自动
    // clamp 到底部后 preventAutoScrollRef 残留为 true，导致后续新消息不会
    // 自动滚动到底部。
    resetPreventAutoScroll()
    autoScrollToBottom()
  }, [agent?.messages, autoScrollToBottom, resetPreventAutoScroll])

  // Context-usage chip (追加⑯): the EFFECTIVE model of this conversation
  // (session override beats the global default) sizes the denominator; the
  // numerator is a rough estimate of what the next turn hands the model —
  // every real (non-ephemeral) message plus a fixed system-prompt budget
  // (tools + skills + memory snapshot). Signals headroom, not a bill.
  // Task #8: 当最近一轮 done 事件带回真实 promptTokens 时，chip 的「已用」
  // 改用实际值（比粗估准），否则维持估算。
  const sessionModel = useMemo(
    () => resolveSessionModel(settings.llm, agent?.modelOverride ?? null),
    [settings.llm, agent?.modelOverride],
  )
  const contextWindow = resolveContextWindow(
    sessionModel.model,
    sessionModel.contextWindow,
  )
  const hasRealUsage = typeof agent?.lastPromptTokens === 'number'
  const usedTokens = useMemo(() => {
    if (!agent) return 0
    if (typeof agent.lastPromptTokens === 'number') {
      return agent.lastPromptTokens
    }
    return (
      estimateMessagesTokens(
        agent.messages
          .filter((m) => !m.ephemeral)
          .map((m) =>
            m.role === 'user' ? (m.content ?? '') : textOfBlocks(m.blocks),
          ),
      ) + SYSTEM_PROMPT_OVERHEAD
    )
  }, [agent])

  // Task #8: 接近上下文上限时一次性提示（每个会话只提示一次）——用
  // compactHint 引导 /compact。ref 记录已提示过的会话 id（null = 尚未
  // 提示过当前会话），切换会话 / 新对话后允许再次提示。
  const compactHintShownConvRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!agent) return
    if (usedTokens <= 0 || contextWindow <= 0) return
    if (compactHintShownConvRef.current === agent.convId) return
    if (nearLimit(usedTokens, contextWindow)) {
      compactHintShownConvRef.current = agent.convId
      new Notice(compactHint(usedTokens, contextWindow))
    }
  }, [agent, usedTokens, contextWindow])

  if (!agent) {
    return (
      <div className="UNagent-chat">
        <div className="UNagent-chat-empty">
          <Icon name="message-square" />
          <div>会话加载中…</div>
        </div>
      </div>
    )
  }

  const {
    messages,
    isStreaming,
    send,
    retry,
    abort,
    newConversation,
    openConversation,
    branchFrom,
    branchChild,
    editUserMessage,
    regenerate,
    switchVersion,
    deleteConversation,
    renameConversation,
    rewindTo,
    onAttachmentSaved,
    convId,
    convTitle,
    convAgentId,
    hermesPath,
    toggleHermesMode,
    conversations,
    models,
    pickModel,
    agents,
    pickAgent,
    pickerRequest,
    clearPickerRequest,
    editRequest,
    clearEditRequest,
    thinking,
    askSession,
    answerAsk,
    cancelAsk,
    pendingHermesPermission,
    answerHermesPermission,
    pendingConfirm,
    answerConfirm,
    pickCoreApprovalMode,
    hermesSessionStates,
    pickHermesModel,
    pickHermesMode,
    pendingSuggestions,
    approveSuggestion,
    dismissSuggestions,
  } = agent

  const canUndo = plugin.undoStack.canUndo()

  // The message being edited (追加48): editing happens in the COMPOSER — this
  // only drives the bubble highlight + the composer edit bar.
  const editingMsg = editingId
    ? (messages.find((m) => m.id === editingId) ?? null)
    : null

  // 追加86: /edit 命令信号——校验目标仍是可重编辑的用户消息后走双击同路
  // （清选区 + 进编辑态）；无论命中与否都清场，信号不留存。
  useEffect(() => {
    if (!editRequest) return
    const target = messages.find(
      (m) => m.id === editRequest && m.role === 'user' && !m.ephemeral,
    )
    if (target) {
      window.getSelection()?.removeAllRanges()
      setEditingId(target.id)
    }
    clearEditRequest()
  }, [editRequest, messages, clearEditRequest])

  // 追加: 对话管理器面板的 Escape 关闭 + 外部点击关闭（从 Composer 移至此
  // 处，确保 Hermes 模式下面板也响应）。
  useEffect(() => {
    if (!chatsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleChatsOpenChange(false)
      }
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (
        target instanceof Element &&
        target.closest('.obsidian-ai-chat-title')
      ) {
        return
      }
      const el = chatsPanelRef.current
      if (el && !el.contains(target)) handleChatsOpenChange(false)
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [chatsOpen, handleChatsOpenChange])

  // Assistant-message action row (追加46/48): /branch fork, REGENERATE this
  // answer, BACKTRACK to this turn (/rewind), quote-as-reference, copy text.
  // Rebuilt when messages change — the message list is the source of truth.
  const makeActions = useCallback(
    (msg: UiMessage): MessageActions | undefined => {
      if (isStreaming || !convId) return undefined
      // The message's plain text (copy + quote snippet).
      const plain = msg.blocks
        ? textOfBlocks(msg.blocks).replace(/\s+/g, ' ').trim()
        : (msg.content ?? '').replace(/\s+/g, ' ').trim()
      return {
        onBranch: () => {
          void branchChild().then((result) => {
            if (result && result !== 'empty') {
              new Notice(`已分支到新对话「${result}」，可继续聊天。`)
            }
          })
        },
        onRegenerate: () => {
          // 重新输出：对这条回答不满意 — 保留本轮提问，原位重新输出这条回答
          //（追加51：不再清除这条回答之后的对话）。
          void regenerate(msg.id, settings.llm)
        },
        onBacktrack: () => {
          // 回溯（追加69/70）：按钮不再弹选择器——直接回溯到这条回答所在
          // 的轮，该轮保留（提问 + 回答），只移除它之后的轮次。
          // 想挑具体轮次用 /rewind 命令（弹选择器）。
          const idx = messages.findIndex((m) => m.id === msg.id)
          if (idx < 0) return
          const pt = turnPoints(messages)
            .filter((p) => p.index <= idx)
            .at(-1)
          if (!pt) {
            new Notice('没有可回溯的位置。')
            return
          }
          void rewindTo(pt.index).then((err) => {
            if (err) new Notice(err)
          })
        },
        onQuote: () => {
          // 补刀85: 片段必须过 cleanSelection——正文里的「」引号（AI 回答很
          // 常见）会让 `[[msg:…]]「…」` 引用 token 在半路被 `」` 截断，
          // 剩下的正文片段作为裸文字漏在 chip 旁边（用户报：引用后多出一段
          // 和 AI 输出有关的文字）。
          const snippet = (cleanSelection(plain) || '这条消息').slice(0, 40)
          composerRef.current?.focusInput(`[[msg:${convId}/${msg.id}]]「${snippet}」 `)
        },
        onCopy: () => {
          void navigator.clipboard
            .writeText(plain)
            .then(() => new Notice('已复制该条消息'))
            .catch(() => new Notice('复制失败'))
        },
      }
    },
    [isStreaming, convId, messages, branchChild, regenerate, rewindTo, settings.llm],
  )

  // M2-T1: 主视图 hermes 路径（engine:hermes 子代理 / /hermes 任务分发）的
  // /model 选择窗数据——hermes 自己的模型清单（hub 按会话缓存），绝不回落
  // 插件档案列表。与主 Composer 的 hermes 路径同款接线。
  const hermesModelList = useMemo(
    () => buildHermesModelRows(hermesSessionStates),
    [hermesSessionStates],
  )
  // 插件已配置的模型名集合（小写）——hermes 模型清单过滤：只显示启用的模型。
  const hermesConfiguredModelNames = useMemo(
    () => configuredModelNameSet(settings.llm),
    [settings.llm],
  )
  // M2-T2: /mode 审批模式选择窗数据——同款 hermes 清单（未就绪禁用占位）。
  const hermesModeList = useMemo(
    () => buildHermesModeRows(hermesSessionStates),
    [hermesSessionStates],
  )

  // M2-T8: core 引擎的 /mode 选择窗数据——固定三模式（与 hermes 清单同
  // 行结构，Composer 零特判），current = 当前设置值；hermes 引擎仍走 hub
  // 清单（hermesModeList），两路按 hermesPath 切换。
  const coreModeRows: HermesPickerRow[] = useMemo(
    () =>
      APPROVAL_MODES.map((id) => ({
        id,
        label: APPROVAL_MODE_LABEL[id],
        description: CORE_MODE_DESC[id],
        current: settings.safety.approvalMode === id,
        loading: false,
      })),
    [settings.safety.approvalMode],
  )

  // Sub-agent context (多 Agent 体系, 追加㊼): inside an agent conversation
  // the assistant role label is the AGENT's name, and the header action
  // becomes 「返回主对话」 instead of 「新对话」.
  // 普通子代理对话显示代理名。Hermes 模式（engine:hermes 子代理 / /hermes
  // 任务分发绑定 / 内置 Hermes 代理）统一显示「Hermes」——AI 输出上的
  // 名字跟着引擎走。
  const assistantLabel = hermesPath
    ? 'Hermes'
    : convAgentId
      ? agents.find((a) => a.id === convAgentId)?.name
      : undefined

  // Current agent name displayed in the empty-state pill.
  const currentAgentName = assistantLabel ?? (settings.general.assistantName.trim() || 'AI')

  // Conversation manager items (chatsPicker): computed here so the panel
  // renders in the right position regardless of composer state.
  const chatsItems = useMemo<PickerItem[]>(
    () => [
      {
        id: 'new',
        label: '新建对话',
        description: '保存当前对话，开始新的一段',
        icon: 'plus',
      },
      ...conversations.map((c) => ({
        id: c.meta.id,
        label: c.meta.title,
        description:
          `${c.meta.messageCount} 条消息 · ${relTime(c.meta.updatedAt)}` +
          `${c.depth > 0 ? ' · 子对话' : ''}` +
          `${c.meta.hermesSessionId ? ' · Hermes' : ''}` +
          `${c.external ? ' · 桌面端' : ''}`,
        icon: c.external
          ? 'monitor'
          : c.depth > 0
            ? 'git-branch'
            : 'message-square',
        iconFallback: c.external ? 'message-square' : undefined,
        depth: c.depth,
        current: c.current,
        // 当前对话身份徽章：子代理名 > hermes 会话（/hermes 任务分发）> 主对话；
        // 外部行（桌面端会话）非当前，恒标「桌面端」来源。
        badge: c.current
          ? (agents.find((a) => a.id === (c.meta.agentId ?? ''))?.name ??
            (c.meta.hermesSessionId ? 'Hermes' : '主对话'))
          : c.external
            ? '桌面端'
            : undefined,
        // 外部行无插件侧文件（不可重命名/分支/删除）——actions 留空。
        actions: c.external
          ? []
          : [
              { id: 'rename', icon: 'pencil', label: '重命名' },
              { id: 'branch', icon: 'git-branch', label: '以此对话开分支' },
              {
                id: 'delete',
                icon: 'trash-2',
                iconFallback: 'trash',
                label: '删除对话',
                danger: true,
              },
            ],
      })),
    ],
    [conversations, agents],
  )

  // Agent pill picker items (quick-switch, same as /// panel without "新建").
  // 统一 emoji 前缀列宽（主对话 ✨ 占位，与 /// 面板同款）：各代理标题字
  // 起点一致（用户报：智慧之王/Hermes/追问启发三条字没对齐）。
  const agentPillItems: PickerItem[] = useMemo(
    () => agents.map((a) => ({
      id: a.id,
      label: `${a.emoji ?? '✨'} ${a.name}`,
      description: a.description,
      badge: convAgentId === a.id || (a.id === '' && convAgentId == null) ? '当前' : undefined,
    })),
    [agents, convAgentId],
  )

  // "Configured" = the GLOBAL default profile (active, else first; legacy
  // block when there are no profiles yet) has both a key and a model.
  const activeModel = resolveActiveModel(settings.llm)
  const hasConfig = Boolean(
    activeModel.apiKey.trim() && activeModel.model.trim(),
  )

  const last = messages[messages.length - 1]
  // Ephemeral /btw asides are display-only — a failed aside has nothing to
  // retry into the conversation.
  const canRetry =
    !isStreaming &&
    last?.role === 'assistant' &&
    Boolean(last.error) &&
    !last.ephemeral

  // The question-index rail appears once there is at least one question;
  // the message list then reserves a sliver of right padding for it.
  const hasNav = messages.some((m) => m.role === 'user')

  return (
    <div
      ref={rootRef}
      className={`UNagent-chat${keyboardOpen ? ' is-keyboard' : ''}`}
      data-ai-conv-id={convId ?? ''}
    >
      <div className="UNagent-chat-header">
        {/* The title doubles as the conversation-manager TOGGLE: a tap opens
            the /chats sheet (docked below the header), a second tap closes
            it (追加⑯). The chevron flips while the sheet is open. */}
        <button
          className={`UNagent-chat-title${chatsOpen ? ' is-open' : ''}`}
          onClick={toggleChats}
          title={
            chatsOpen
              ? '关闭对话管理'
              : '打开对话管理（切换 / 分支 / 删除 / 新建）'
          }
          aria-label={chatsOpen ? '关闭对话管理' : '打开对话管理'}
          aria-expanded={chatsOpen}
        >
          <span className="UNagent-chat-title-text">
            {convTitle || 'AI 助手'}
          </span>
          <Icon name="chevron-down" />
        </button>
        <span className="UNagent-chat-header-actions">
          {messages.length > 0 && (
            <span
              className="UNagent-chat-usage"
              title={
                hasRealUsage
                  ? `上下文已用 ${formatTokens(
                      usedTokens,
                    )} / ${formatTokens(
                      contextWindow,
                    )} token（上一轮实际 prompt 用量）。发 /compact 可压缩上下文。`
                  : `上下文已用约 ${formatTokens(
                      usedTokens,
                    )} / ${formatTokens(
                      contextWindow,
                    )} token（粗估，含系统提示）。发 /compact 可压缩上下文。`
              }
            >
              <Icon name="gauge" fallback="activity" />
              {formatTokens(usedTokens)} / {formatTokens(contextWindow)}
            </span>
          )}
          {canUndo && (
            <button
              className="UNagent-chat-undo"
              onClick={() => {
                void plugin.undoStack.undoLast().catch(() => undefined)
              }}
              disabled={isStreaming}
              title={plugin.undoStack.lastLabel()}
            >
              撤销
            </button>
          )}
          {/* 追加⑧：右上角曾有的「返回主对话」按钮已彻底移除（用户要求）——
              子代理对话用 /chats 面板切回，或右上角 Hermes pill（hermes
              路径）退出；此处不再渲染任何模式外按钮。 */}
          {/* Hermes 模式 pill——固定「Hermes」字样，不随模式换名；点击原地
              切换模式（切换 = 新建该模式的全新会话，/new 语义，两套上下文
              彻底分离）。高亮 = 当前对话在 Hermes 模式。出现与否跟随设置
              「启用 Hermes 集成」（开启即常驻，与 Hermes 窗口是否打开
              无关；桌面专属）。内嵌连接状态灯（补刀·五十九）：绿=已就绪、
              灰=未连接/连接中、红=连接失败；失败后点击切换会自动重连。 */}
          {settings.localAgent.enabled && !Platform.isMobile && (
            <button
              className={`UNagent-chat-mode${hermesPath ? ' is-active' : ''}`}
              onClick={() => toggleHermesMode()}
              disabled={isStreaming}
              title={
                hermesConnState === 'ready'
                  ? `Hermes 已就绪 · ${
                      hermesPath ? '切回主 agent（新开主对话）' : '切换到 Hermes（新开 Hermes 会话）'
                    }`
                  : hermesConnState === 'connecting'
                    ? 'Hermes 正在连接…'
                    : hermesConnState === 'failed'
                      ? 'Hermes 连接失败（点击切换时会自动重试）'
                      : 'Hermes 未连接（使用时会自动启动）'
              }
            >
              <span
                className={`UNagent-hermes-status UNagent-hermes-status--${hermesConnState}`}
                aria-hidden="true"
              />
              Hermes
            </button>
          )}
        </span>
      </div>

      {/* Dock for the title-bar-opened conversation manager (追加⑯): an
          empty in-flow slot — zero height while empty, so the layout is
          unchanged. When the composer portals the sheet here it pushes the
          body down, reading as "below the title bar". Command-opened
          (/chats) sheets never land here. */}
      <div className="UNagent-chat-popdock" ref={dockRef} />

      {!hasConfig && (
        <div className="UNagent-chat-notice">
          尚未配置：请在 设置 → AI Assistant → 模型 中添加模型档案（厂商协议 / API Key / 模型名）。
        </div>
      )}

      <div
        className={`UNagent-chat-body${
          hasNav ? ' UNagent-chat-body--nav' : ''
        }`}
      >
        <div className="UNagent-chat-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="UNagent-chat-empty">
              <Icon name={emptyHint.icon} fallback={emptyHint.fallback} />
              <div className="UNagent-chat-empty-title">
                开始和{' '}
                <button
                  ref={pillRef}
                  className="UNagent-agent-pill"
                  onClick={() => setShowAgentMenu((v) => !v)}
                >
                  {currentAgentName}
                </button>
                {' '}对话吧
              </div>
              <div className="UNagent-chat-empty-tip">
                {emptyHint.text}
              </div>
              {showAgentMenu && (
                <div ref={agentMenuRef} className="UNagent-agent-pill-overlay">
                  <div className="UNagent-agent-pill-menu">
                    <CommandPicker
                      ariaLabel="切换子代理"
                      title="切换子代理"
                      hint="点击切换当前对话的代理身份"
                      items={agentPillItems}
                      emptyText="没有其他子代理"
                      onSelect={(id) => {
                        setShowAgentMenu(false)
                        pickAgent(id)
                      }}
                      onClose={() => setShowAgentMenu(false)}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <ChatMessageView
                  key={m.id}
                  message={m}
                  assistantLabel={assistantLabel}
                  actions={m.role === 'assistant' ? makeActions(m) : undefined}
                  onSwitchVersion={
                    m.role === 'assistant' ? (dir) => switchVersion(m.id, dir) : undefined
                  }
                  editing={editingId === m.id}
                  onEditStart={
                    m.role === 'user' && !m.ephemeral
                      ? () => {
                          // The browser selects the word under the double-click
                          // BEFORE the handler runs; that live selection would
                          // flip the send button into the "＋" quick-reference
                          // mode (追加49) and the next send would inject a stray
                          // [[msg:…]] token into the re-run (追加50). Clear it.
                          window.getSelection()?.removeAllRanges()
                          setEditingId(m.id)
                        }
                      : undefined
                  }
                />
              ))}
              {canRetry && (
                <button
                  className="UNagent-retry"
                  onClick={() => {
                    void retry(settings.llm).catch(() => undefined)
                  }}
                >
                  <Icon name="rotate-ccw" />
                  重试上一条
                </button>
              )}
            </>
          )}
        </div>
        <ConversationNav messages={messages} scrollRef={scrollRef} />
      </div>

      {backtrackAt && (
        <BacktrackMenu
          x={backtrackAt.x}
          y={backtrackAt.y}
          points={backtrackablePoints(messages)}
          onPick={(idx) => {
            setBacktrackAt(null)
            void rewindTo(idx).then((err) => {
              if (err) new Notice(err)
            })
          }}
          onClose={() => setBacktrackAt(null)}
        />
      )}

      {askSession && (
        <AskPanel
          questions={askSession.questions}
          index={askSession.index}
          onAnswer={answerAsk}
          onCancel={cancelAsk}
        />
      )}

      {/* 补刀·五十六: hermes 权限审批面板（阻塞中——hermes 在等回复，
          优先级高于复盘建议；ask_user 提问在场时仍让位）。 */}
      {!askSession && pendingHermesPermission && (
        <HermesApprovalPanel
          event={pendingHermesPermission}
          onAnswer={answerHermesPermission}
        />
      )}

      {/* M2-T8: 主 agent 审批面板（ConfirmApprovalPanel）——破坏性工具
          待确认时渲染，与 hermes 审批面板同形态同槽位优先级。 */}
      {!askSession && !pendingHermesPermission && pendingConfirm && (
        <ConfirmApprovalPanel
          request={pendingConfirm}
          onAnswer={answerConfirm}
        />
      )}

      {/* 进化 B 案：复盘建议确认面板。ask_user 提问在场时让位（提问阻塞
          对话流，优先回答）；建议是异步的，等提问关闭后再显示。 */}
      {!askSession &&
        !pendingHermesPermission &&
        !pendingConfirm &&
        pendingSuggestions.length > 0 && (
          <SuggestionsPanel
            suggestions={pendingSuggestions}
            onApprove={(s) => void approveSuggestion(s, settings.llm)}
            onDismiss={dismissSuggestions}
          />
        )}

      {/* 对话管理器面板（command-origin 浮在 composer 上方，title-origin 经
          portal 进 dock 槽位）。 */}
      {chatsOpen && (() => {
        const chatsPicker = (
          <div ref={chatsPanelRef}>
            <CommandPicker
              ariaLabel="对话列表"
              title={
                <>
                  <Icon name="message-square" />
                  对话管理
                </>
              }
              hint="点击切换 · 右侧按钮：重命名 / 分支 / 删除"
              items={chatsItems}
              emptyText="还没有保存的对话"
              onSelect={(id) => {
                handleChatsOpenChange(false)
                if (id === 'new') {
                  void newConversation().catch(() => undefined)
                } else {
                  void openConversation(id).catch(() => undefined)
                }
              }}
              onAction={(itemId, actionId) => {
                handleChatsOpenChange(false)
                if (actionId === 'rename') {
                  const target = conversations.find((c) => c.meta.id === itemId)
                  void askName(plugin.app, {
                    title: '重命名对话',
                    initial: target?.meta.title ?? '',
                    placeholder: '对话名称',
                    confirmText: '保存',
                  }).then((name) => {
                    if (name) void renameConversation(itemId, name).catch(() => undefined)
                  }).catch(() => undefined)
                } else if (actionId === 'branch') {
                  void branchFrom(itemId).then((result) => {
                    if (result === 'empty') new Notice('该对话没有可分支的内容。')
                  }).catch(() => undefined)
                } else if (actionId === 'delete') {
                  const target = conversations.find((c) => c.meta.id === itemId)
                  void plugin
                    .confirm({
                      toolName: 'delete_conversation',
                      title: '删除对话',
                      message: `确定删除「${
                        target?.meta.title ?? '该对话'
                      }」及其全部消息？此操作无法撤销。`,
                    })
                    .then((ok) => {
                      if (ok) void deleteConversation(itemId).catch(() => undefined)
                    })
                    .catch(() => undefined)
                }
              }}
              variant="chats"
              docked={chatsOrigin === 'title'}
              onClose={() => handleChatsOpenChange(false)}
            />
          </div>
        )
        return chatsOrigin === 'title' && dockRef.current
          ? createPortal(chatsPicker, dockRef.current)
          : chatsPicker
      })()}

      <Composer
        ref={composerRef}
        isStreaming={isStreaming}
        onSend={(text) => {
          void send(text, settings.llm).catch(() => undefined)
        }}
        onAbort={abort}
        editingMessage={
          editingMsg ? { id: editingMsg.id, text: editingMsg.content ?? '' } : null
        }
        onEditSend={(text) => {
          const id = editingId
          setEditingId(null)
          if (id) void editUserMessage(id, text, settings.llm).catch(() => undefined)
        }}
        onEditCancel={() => setEditingId(null)}
        thinking={thinking}
        modelName={sessionModel.displayName}
        hermesPath={hermesPath}
        panelCommands={agent.panelCommands}
        models={models}
        onPickModel={pickModel}
        agents={agents}
        onPickAgent={pickAgent}
        onAttachmentSaved={onAttachmentSaved}
        onRewindCommand={() => {
          // 追加66: /rewind 命令与回溯按钮同一套 BacktrackMenu 浮层——
          // 入口不同、设计一致。追加69: 浮层锚定在聊天视图容器内底部
          // 中央（composer 上方），避免用 window 坐标在侧边栏视图下
          // 偏到右边空白处/视口外。
          const rect = rootRef.current?.getBoundingClientRect()
          const w = rect?.width ?? 300
          const h = rect?.height ?? 400
          const left = rect?.left ?? 12
          const top = rect?.top ?? 12
          setBacktrackAt({
            x: Math.max(12, left + w / 2 - 150),
            y: Math.max(12, top + h - 280),
          })
        }}
        pickerRequest={pickerRequest}
        onClearPickerRequest={clearPickerRequest}
        chatsOpen={chatsOpen}
        onChatsOpenChange={handleChatsOpenChange}
        hermesModels={hermesModelList.rows}
        hermesModelsReady={hermesModelList.ready}
        onPickHermesModel={pickHermesModel}
        hermesConfiguredModelNames={hermesConfiguredModelNames}
        hermesSkills={agent.hermesSkills}
        onRefreshHermesSkills={agent.refreshHermesSkills}
        modes={hermesPath ? hermesModeList.rows : coreModeRows}
        modesReady={hermesPath ? hermesModeList.ready : true}
        onPickMode={hermesPath ? pickHermesMode : pickCoreApprovalMode}
      />
    </div>
  )
}
