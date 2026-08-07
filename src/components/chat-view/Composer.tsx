import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Notice } from 'obsidian'

import type { ThinkLevel } from '../../core/llm/base'
import type { Skill } from '../../core/skills/types'
import { usePlugin } from '../../contexts/plugin-context'
import { extFromName, saveAttachment } from '../../utils/attachments'
import { buildSelectionRef } from '../../utils/selectionRef'
import { Icon } from '../Icon'
import { COMMANDS, THINK_OPTIONS, type CommandDef } from './commands'
import {
  buildDisplay,
  getActiveMention,
  insertMention,
  mapDisplayToValue,
  mapValueToDisplay,
  Mention,
  valueFromDisplay,
} from './mention'
import { MentionPicker, MentionPickerHandle } from './MentionPicker'
import {
  CommandPicker,
  CommandPickerHandle,
  PickerItem,
} from './CommandPicker'
import { buildCommandCandidates, commandToken, getActiveSlash, Slash } from './slash'
import { SlashPicker, SlashPickerHandle } from './SlashPicker'
import type { AgentListItem, ModelListItem } from './useAgent'
import type { HermesPickerRow } from '../../core/hermes/sessionStates'

// The '/'-'@' usage guides (追加⑰ 起移出占位层）：随机选一条显示在空白对话
// 界面的正中间，让新用户一眼看到能做什么。Composer 只留「模型 · 思考强度」
// 状态占位；本数组由 Chat 的空态区使用。追加㊾：扩展为全功能随机提示列表。
export interface TipItem {
  icon: string
  fallback: string
  text: string
}

export const COMPOSER_HINTS: TipItem[] = [
  {
    icon: 'at-sign',
    fallback: 'help-circle',
    text: '输入 @ 引用笔记 · @@ 文件夹 · @@@ 标签',
  },
  {
    icon: 'command',
    fallback: 'help-circle',
    text: '输入 / 命令面板 · // 调用技能 · /// 子代理管理',
  },
  {
    icon: 'bot',
    fallback: 'message-square',
    text: '点击 AI 名称切换子代理，快速开始不同角色的对话',
  },
  {
    icon: 'zap',
    fallback: 'cpu',
    text: '输入 /think 调节思考强度 · /model 切换模型',
  },
  {
    icon: 'message-square',
    fallback: 'help-circle',
    text: '输入 /btw 顺便一问，AI 回答不计入上下文',
  },
  {
    icon: 'rotate-ccw',
    fallback: 'undo-2',
    text: '输入 /rewind 回溯到任意轮 · /branch 分支新对话',
  },
  {
    icon: 'list',
    fallback: 'menu',
    text: '输入 /chats 管理全部对话 · /new 立即开始新对话',
  },
  {
    icon: 'puzzle',
    fallback: 'help-circle',
    text: '输入 /learn 让 AI 复盘并结晶为可复用的技能',
  },
]

/** Icons for each reference kind — beautified chips (用户指示).
 *  追加91: lucide 图标名是 at-sign 不是 at（同 chipInject KIND_ICON）。 */
const MENTION_KIND_ICON: Record<string, string> = {
  file: 'file',
  folder: 'folder',
  tag: 'hash',
  ref: 'at-sign',
}

interface ComposerProps {
  isStreaming: boolean
  onSend: (text: string) => void
  onAbort: () => void
  /** Seed the box with text (the inline box pre-fills the active-note
   *  reference, 追加⑰). */
  initialValue?: string
  /** Focus the textarea once mounted (the inline box wants the caret
   *  immediately, 追加⑰). */
  autoFocus?: boolean
  /** Backspace with the caret at position 0 (nothing to delete) — used by the
   *  inline editor box to exit the inline edit. 追加⑱ 补刀. */
  onBackspaceAtStart?: () => void
  /** Edit mode (追加48): a past USER message is being revised — the box is
   *  pre-filled with its text and submit calls onEditSend instead of onSend. */
  editingMessage?: { id: string; text: string } | null
  /** Commit the edited text (edit mode submit). */
  onEditSend?: (text: string) => void
  /** Leave edit mode without sending. */
  onEditCancel?: () => void
  /** Current session thinking level (badged in the /think submenu). */
  thinking: ThinkLevel
  /** Effective model display name — the placeholder's state line. */
  modelName: string
  /** Capability gate: true = this conversation runs on hermes (engine:
   *  hermes). The placeholder shows the hermes model name + thinking state
   *  (same format as the main agent). */
  hermesPath: boolean
  /** M2-T4: 命令面板数据驱动视图——useAgent 按当前会话引擎构建（插件命令
   *  经 capability/清单过滤 + hermes 引擎并入通告命令）。Composer 通用渲染，
   *  零特判。 */
  panelCommands: CommandDef[]
  /** Configured model profiles (listed in the /model submenu). */
  models: ModelListItem[]
  /** Enabled sub-agents (listed in the /agent submenu, 多 Agent 体系). */
  agents: AgentListItem[]
  /** 追加66: 手输 /rewind 不再开本地子菜单——直接弹与回溯按钮同一套的
   *  BacktrackMenu 浮层（同一设计、不同入口）。 */
  onRewindCommand: () => void
  /** Pick a model profile; '' restores the global default. */
  onPickModel: (id: string) => void
  /** Pick a sub-agent; '' returns to the main agent (多 Agent 体系). */
  onPickAgent: (id: string) => void
  /** An outside-the-vault attachment was saved — bind it to the conversation
   *  so it's deleted with the conversation (追加⑱ 补刀). */
  onAttachmentSaved?: (path: string) => void
  /** Asks to pop open a submenu (hand-typed "/chats" / "/rewind" / "/model").
   *  任务一 §1.2: 'mode' = 审批模式选择窗（M2-T8 起双引擎消费）。 */
  pickerRequest:
    | 'chats'
    | 'rewind'
    | 'model'
    | 'think'
    | 'agent'
    | 'mode'
    | null
  onClearPickerRequest: () => void
  /** Conversation-manager sheet state, OWNED BY CHAT (追加⑯) so the title
   *  bar can toggle it: second tap closes what the first opened. */
  chatsOpen: boolean
  onChatsOpenChange: (open: boolean, origin?: 'title' | 'command') => void
  /** Optional extra controls rendered above the input row (chips, retry). */
  children?: React.ReactNode
  // M2-T1/T2: hermes model/approval mode list (hermesPath=true → /model picker).
  hermesModels?: HermesPickerRow[]
  /** true = hermes list is not ready — selection window disabled, absolutely never fall back to plugin archive. */
  hermesModelsReady?: boolean
  onPickHermesModel?: (id: string) => Promise<void>
  /** 补刀·五十七: hermes 模式 // 选择器数据面——hermes 侧技能清单
   *  （source: 'hermes'，经 hermes CLI 拉取）；core 模式不消费。 */
  hermesSkills?: Skill[]
  /** // 面板打开时按需刷新 hermes 技能清单（fire-and-forget）。 */
  onRefreshHermesSkills?: () => void
  /** 插件已配置的模型名集合（小写）——用于过滤 hermes 模型清单。 */
  hermesConfiguredModelNames?: Set<string>
  /** M2-T2: hermes 审批模式清单行（hermesPath=true → /mode 选择窗数据面）。
   *  主视图 hermes 对话（engine:hermes 子代理 / /hermes 任务分发）使用；
   *  core 引擎不消费。 */
  modes?: HermesPickerRow[]
  modesReady?: boolean
  onPickMode?: (id: string) => Promise<boolean | void>
}

/** Imperative handle so main.ts's Alt+Z command can focus the composer and
 *  optionally insert a selection reference (补刀·五十一). */
export interface ComposerHandle {
  /** Focus the textarea; when `reference` is given, insert it at the caret. */
  focusInput(reference?: string): void
}

/** Which second-level command menu is open (null = top-level list). The
 *  conversation manager is NOT part of this union (追加⑯): Chat owns that
 *  open state (title-bar toggle), so it renders through `chatsOpen`. */
type Menu = 'think' | 'model' | 'agent' | 'mode' | null

// Input area. Enter sends, Shift+Enter inserts a newline. While streaming,
// the send button becomes a stop button wired to the AbortController.
//
// The '/' commands stay keystroke-driven: type '/' for the visual command
// palette, '//' for the skill picker. What they configure shows up as
// session-state chips above the input row (rendered via `children`).
//
// Paperclip + textarea + send form ONE rounded card: the paperclip attaches
// vault files (any type) or uploads system files (saved into the vault);
// pasted images are saved too.
//
// Textarea grows with its content up to a viewport-relative cap, then scrolls
// internally — with a hidden scrollbar, so the surface stays clean.
//
// Triggers, by leading-symbol run length:
//   '/'   → command palette   '//' → skill picker   '///' → sub-agent panel
//   '@'   → note   '@@' → folder   '@@@' → tag
// ↑↓ navigate, Enter/Tab select, Esc closes (or steps back out of a
// submenu). Slash wins while active.
export const Composer = React.forwardRef<ComposerHandle, ComposerProps>(
  function Composer(
    {
      isStreaming,
      onSend,
      onAbort,
      initialValue,
      autoFocus,
      onBackspaceAtStart,
      editingMessage,
      onEditSend,
      onEditCancel,
      thinking,
      modelName,
      hermesPath,
      panelCommands,
      models,
      agents,
      onRewindCommand,
      onPickModel,
      onPickAgent,
      onAttachmentSaved,
      pickerRequest,
      onClearPickerRequest,
      chatsOpen,
      onChatsOpenChange,
      children,
      hermesModels,
      hermesModelsReady,
      onPickHermesModel,
      hermesConfiguredModelNames,
      hermesSkills,
      onRefreshHermesSkills,
      modes,
      modesReady,
      onPickMode,
    },
    ref,
  ) {
  const plugin = usePlugin()
  const [value, setValue] = useState(initialValue ?? '')
  // The display text shown in the textarea: a known /command and every mention
  // are replaced by compact chip markers. The raw `value` (real refs) is
  // expanded back on send. Derived here (before the handlers use it).
  const cmd = commandToken(value)
  const { display, spans } = useMemo(
    () => buildDisplay(value, cmd),
    [value, cmd],
  )
  const overlayActive = spans.length > 0
  const [mention, setMention] = useState<Mention | null>(null)
  const [slash, setSlash] = useState<Slash | null>(null)
  const [menu, setMenu] = useState<Menu>(null)
  const [attachMenu, setAttachMenu] = useState(false)
  const [filePicker, setFilePicker] = useState(false)
  const [attaching, setAttaching] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cmdOverlayRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<MentionPickerHandle>(null)
  const slashRef = useRef<SlashPickerHandle>(null)
  const commandRef = useRef<CommandPickerHandle>(null)
  const attachRef = useRef<CommandPickerHandle>(null)
  const filePickerRef = useRef<MentionPickerHandle>(null)
  // Tracks whether the current menu was opened by pickerRequest (/think
  // / /model no-arg). If so, refreshPickers must NOT close it when the
  // slash disappears (user already committed the command, 补刀).
  const menuFromPicker = useRef(false)

  // Text selected ANYWHERE outside the textarea (note OR chat message): the
  // send button becomes a "＋" that references the selection into the input
  // (补刀; 追加49: chat-message text gets the same treatment — messages carry
  // [[msg:conv/msg]] position refs instead of note refs).
  const [docSelected, setDocSelected] = useState(false)
  useEffect(() => {
    const onSelection = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setDocSelected(false)
        return
      }
      const raw = sel.toString().trim()
      if (!raw) {
        setDocSelected(false)
        return
      }
      // The textarea's own selection is not a doc selection.
      const ta = textareaRef.current
      if (ta && sel.anchorNode && ta.contains(sel.anchorNode)) {
        setDocSelected(false)
        return
      }
      setDocSelected(true)
    }
    document.addEventListener('selectionchange', onSelection)
    onSelection()
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [])

  // 追加89: 技能注册表热重载是原地换内容、引用不变——旧 memo 依赖
  // [plugin] 永不重算，// 选择器一直显示旧列表（重启才见效）。订阅数据
  // 变更通知，用 tick 驱动重算；plugin.settings 进依赖让设置里的技能
  // 开关改动也即时生效。
  const [skillsTick, setSkillsTick] = useState(0)
  useEffect(
    () => plugin.addDataChangeListener(() => setSkillsTick((t) => t + 1)),
    [plugin],
  )

  // Skills the '//' picker may offer: master toggle on, disabled removed.
  // 补刀·五十七: Hermes 模式（纯壳）技能独立——// 选择器切到 hermes 侧
  // 技能清单（source: 'hermes'，经 hermes CLI 拉取），插件技能照旧只服务
  // core 引擎；清单空（未拉取/失败）时面板自动不触发。
  const availableSkills = useMemo(() => {
    if (!plugin.settings.skills.enabled) return []
    if (hermesPath) return hermesSkills ?? []
    const disabled = plugin.settings.skills.disabled
    return plugin.skills.getAll().filter((s) => !disabled.includes(s.metadata.name))
  }, [plugin, plugin.settings, skillsTick, hermesPath, hermesSkills])

  // 追加89: 选择器打开期间按需重扫（2s 节流在 plugin 侧）——兜底 vault
  // 事件盲区（点开头数据文件夹内的改动不发事件、外部静默改动），用户
  // 改完 SKILL.md 打出 // 就能看到最新列表，不必手动「重新载入」。
  // 补刀·五十七: hermes 模式同时按需刷新 hermes 技能清单（fire-and-
  // forget；2s 节流在 useAgent 侧）——用户新装 hermes 技能同样即时可见。
  useEffect(() => {
    if (slash?.level === 2 || menu === 'agent') {
      plugin.pokeDataReload()
      if (hermesPath) onRefreshHermesSkills?.()
    }
  }, [slash, menu, plugin, hermesPath, onRefreshHermesSkills])

  const refreshPickers = (text: string, caret: number) => {
    const activeSlash = getActiveSlash(text, caret)
    // Commands (level 1) and the sub-agent panel (level 3) are always
    // available; skills (level 2) only when enabled.
    const usable =
      activeSlash &&
      (activeSlash.level !== 2 || availableSkills.length > 0)
        ? activeSlash
        : null
    setSlash(usable)
    // Slash (a leading directive) takes priority over a mention on same text.
    setMention(usable ? null : getActiveMention(text, caret))
    // A submenu only makes sense on an active level-1 slash. If the menu was
    // opened by a pickerRequest (/think / /model no-arg), don't auto-close.
    if (!menuFromPicker.current) {
      if (!usable || usable.level !== 1) setMenu(null)
    }
    // Starting a directive dismisses the (possibly docked) manager sheet —
    // only one command surface at a time.
    if (usable) onChatsOpenChange(false)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // The textarea holds the DISPLAY (compact chips); recover the raw value
    // the user edited, then the display re-derives. The pickers run on the
    // display text (what the user actually types/sees).
    const newDisplay = e.target.value
    const caret = e.target.selectionStart ?? newDisplay.length
    setValue(valueFromDisplay(value, newDisplay, cmd))
    // Hermes 性能：输入即后台预热连接+项目会话（幂等、失败静默）——
    // 用户发送时 hermes 侧慢启动（session/new 数秒）已在打字间隙消化。
    plugin.agentBridge.getSnapshot()?.warmupHermes?.()
    // Typing means the user moved on — drop the attach sheet (this only
    // fires for real textarea edits, not programmatic setValue).
    setAttachMenu(false)
    refreshPickers(newDisplay, caret)
  }

  // Fires on caret movement (arrows, clicks) — close/reopen pickers as the
  // caret leaves or re-enters a trigger span.
  const handleSelect = () => {
    const ta = textareaRef.current
    if (ta) refreshPickers(ta.value, ta.selectionStart)
  }

  // Edit mode (追加48): when a message enters editing, load its text into the
  // box and focus — the user revises HERE, not inside the message bubble.
  useEffect(() => {
    if (!editingMessage) return
    setValue(editingMessage.text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      // Pin the caret at the end so the user SEES where they are (追加52:
      // a long edited message without an explicit caret lands mid-scroll).
      const len = el.value.length
      el.setSelectionRange(len, len)
      autoGrow()
    })
  }, [editingMessage])

  const closeAll = () => {
    menuFromPicker.current = false
    setMention(null)
    setSlash(null)
    setMenu(null)
    setAttachMenu(false)
    setFilePicker(false)
    onChatsOpenChange(false)
  }

  // Send `text` as a full message (used by Enter and by picker selections
  // that resolve to a complete directive, e.g. "/think-hard", "/branch").
  const submitText = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return
    if (editingMessage) {
      // Edit mode: commit through the edit path — Chat replaces the past
      // message and re-runs the agent (追加48).
      onEditSend?.(trimmed)
    } else {
      onSend(trimmed)
    }
    setValue('')
    closeAll()
    requestAnimationFrame(() => autoGrow())
  }

  const submit = () => submitText(value)

  // Shared picker→textarea replacement; refocuses after the state round-trip.
  // `at`/caret are DISPLAY positions (the picker scans the display); map them
  // back to the raw value, then the new caret back to a display position.
  const applyInsert = (at: number, insert: string, close: () => void) => {
    const ta = textareaRef.current
    const caret = ta?.selectionStart ?? display.length
    const atValue = mapDisplayToValue(spans, at)
    const caretValue = mapDisplayToValue(spans, caret)
    const { text, caret: nextCaretValue } = insertMention(
      value,
      atValue,
      caretValue,
      insert,
    )
    setValue(text)
    close()
    const nextSpans = buildDisplay(text, commandToken(text)).spans
    const nextCaret = mapValueToDisplay(nextSpans, nextCaretValue)
    // Restore focus + caret (setSelectionRange needs the post-render DOM).
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
      autoGrow()
    })
  }

  // Grow AND shrink with content up to a viewport-relative cap, then let CSS
  // take over (internal scroll, hidden scrollbar). Cap tracks the viewport so
  // a tall composer never eats a phone screen.
  //
  // The highlight overlay (UNagent-composer-cmd) is a static clipping
  // window whose INNER layer rides translateY(-scrollTop); a height change can
  // clamp scrollTop WITHOUT firing a scroll event, leaving the inner layer
  // stranded (用户报: 长文本粘进去文字「溢出」输入框——实际是覆盖层与 textarea
  // 错位)。So after every resize we resync via a rAF loop that runs while
  // scrollTop keeps changing (paste auto-scrolls to the caret AFTER the
  // effect flush — one-shot syncs miss it).
  const syncOverlay = useCallback(() => {
    const ta = textareaRef.current
    const ov = cmdOverlayRef.current
    if (ta && ov) ov.style.transform = `translateY(-${ta.scrollTop}px)`
  }, [])
  // Keep resyncing for a short window after a resize: paste scrolls the caret
  // into view AFTER the effect flush, and a height collapse can clamp scrollTop
  // silently — one-shot syncs miss both. A single rAF chain (guarded by refs)
  // absorbs repeated calls from fast typing without stacking loops.
  const syncTicksRef = useRef(0)
  const syncChainActive = useRef(false)
  const syncOverlayFor = useCallback(
    (frames: number) => {
      syncTicksRef.current = Math.max(syncTicksRef.current, frames)
      if (syncChainActive.current) return
      syncChainActive.current = true
      const tick = () => {
        if (!textareaRef.current) {
          syncChainActive.current = false
          return
        }
        syncOverlay()
        syncTicksRef.current -= 1
        if (syncTicksRef.current > 0) requestAnimationFrame(tick)
        else syncChainActive.current = false
      }
      requestAnimationFrame(tick)
    },
    [syncOverlay],
  )
  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const cap = Math.min(240, Math.max(120, Math.round(window.innerHeight * 0.35)))
    // Collapse FIRST so scrollHeight measures the CONTENT, not the current
    // box: once an inline height is set, scrollHeight never reports below it,
    // so measuring directly means the box can grow but never shrink back
    // (用户报: 删字/发送后输入框停在抬升高度). Collapse + restore happen in
    // ONE synchronous block — no paint in between, so no flicker. CSS
    // min-height keeps the collapsed box at its resting height, which also
    // becomes the empty-state floor.
    el.style.height = '0px'
    const targetH = Math.min(el.scrollHeight, cap)
    el.style.height = `${targetH}px`
    syncOverlayFor(15)
  }, [syncOverlayFor])

  // The overlay mounts only when markers appear mid-text — the textarea may
  // already be scrolled, so align once on mount (the rAF window also catches
  // the browser's scroll-into-view right after).
  useEffect(() => {
    if (overlayActive) syncOverlayFor(10)
  }, [overlayActive, syncOverlayFor])

  // Insert attachment links at the caret. The textarea shows the DISPLAY, so
  // the caret maps back to the raw value; the new caret maps forward again.
  const insertAtCaret = useCallback(
    (insert: string) => {
      const el = textareaRef.current
      const caretValue = mapDisplayToValue(
        spans,
        el?.selectionStart ?? display.length,
      )
      const before = value.slice(0, caretValue)
      const after = value.slice(caretValue)
      const sepB = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
      const sepA = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
      const next = before + sepB + insert + sepA + after
      setValue(next)
      const nextSpans = buildDisplay(next, commandToken(next)).spans
      const caretDisplay = mapValueToDisplay(
        nextSpans,
        caretValue + sepB.length + insert.length,
      )
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(caretDisplay, caretDisplay)
        autoGrow()
      })
    },
    [value, spans, display, autoGrow],
  )

  // Reference the currently-selected text (补刀 + 追加49 + 追加68): all the
  // source detection (chat message / memos card / canvas node / table row /
  // note / bases / 三方视图) lives in the shared buildSelectionRef — the ＋
  // button and Option+Z produce IDENTICAL refs.
  const referenceDocSelection = useCallback(() => {
    void buildSelectionRef(plugin.app)
      .then((ref) => {
        if (!ref) return
        insertAtCaret(ref)
        setDocSelected(false)
      })
      .catch((err) => {
        // 追加69: 别让失败静默——控制台留痕便于定位。
        console.error('[UNagent] 引用选中文字失败:', err)
      })
  }, [plugin, insertAtCaret])

  // Native hover preview for reference chips: trigger Obsidian's hover-link,
  // then dismiss on mouseleave.
  const hoverRef = useRef<{ popover: { onClose: () => void } | null } | null>(
    null,
  )

  // Resolve a mention's raw [[note]] to the note's vault path, for the native
  // hover preview. Folders ([[…/]]) and #tags have no note to preview → null.
  const mentionHref = useCallback((raw: string): string | null => {
    try {
      const m = raw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/)
      if (!m) return null
      const target = (m[2] ?? m[1]).trim()
      if (!target || target.endsWith('/')) return null
      const cache = plugin.app.metadataCache as unknown as {
        getFirstLinkpathDest?: (l: string, s: string) => { path: string } | null
      }
      const file = cache.getFirstLinkpathDest?.(target, '')
      return file ? file.path : null
    } catch {
      return null
    }
  }, [plugin])
  const closeNotePreview = useCallback(() => {
    const p = hoverRef.current
    p?.popover?.onClose()
    hoverRef.current = null
  }, [])
  const showNotePreview = useCallback(
    (e: React.MouseEvent, linktext: string) => {
      closeNotePreview()
      const parent: { popover: { onClose: () => void } | null } = {
        popover: null,
      }
      hoverRef.current = parent
      ;(plugin.app.workspace as unknown as {
        trigger: (name: string, opts: unknown) => void
      }).trigger('hover-link', {
        event: e.nativeEvent,
        source: 'UNagent',
        hoverParent: parent,
        targetEl: e.currentTarget,
        linktext,
        sourcePath: '',
      })
    },
    [plugin, closeNotePreview],
  )

  // Hover-preview from the textarea's mouse events (the chips sit BELOW the
  // textarea, so this is what detects which reference is under the cursor).
  const textareaMouseMove = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      let offset: number | null = null
      try {
        const cp = document.caretPositionFromPoint
          ? document.caretPositionFromPoint(e.clientX, e.clientY)
          : null
        if (cp) offset = cp.offset
        else {
          const r = (
            document as unknown as {
              caretRangeFromPoint?: (
                x: number,
                y: number,
              ) => { startOffset: number } | null
            }
          ).caretRangeFromPoint?.(e.clientX, e.clientY)
          offset = r ? r.startOffset : null
        }
      } catch {
        offset = null
      }
      const span =
        offset != null
          ? spans.find(
              (s) =>
                s.kind === 'mention' &&
                offset >= s.ds &&
                offset <= s.de,
            )
          : undefined
      if (!span) {
        closeNotePreview()
        return
      }
      const href = mentionHref(value.slice(span.vs, span.ve))
      if (!href) {
        closeNotePreview()
        return
      }
      const linktext = href.split('/').pop()!.replace(/\.md$/, '')
      showNotePreview(e, linktext)
    },
    [spans, value, mentionHref, showNotePreview, closeNotePreview],
  )

  // Grow/shrink with content (also after programmatic edits clear the box).
  useEffect(() => {
    autoGrow()
  }, [value, autoGrow])

  // Inline box (追加⑰): take the caret on open, after any seed text.
  useEffect(() => {
    if (!autoFocus) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }, [autoFocus])

  /* ── attachments (paperclip) ─────────────────────────────────────── */

  // Save files into the vault and insert their links at the caret. Shared by
  // the system file chooser and the paste handler. Failures surface a Notice
  // per file; one bad file never blocks the rest.
  const saveFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setAttaching((n) => n + files.length)
      try {
        for (const f of files) {
          try {
            const bytes = await f.arrayBuffer()
            const saved = await saveAttachment(
              plugin.app,
              bytes,
              f.name,
              f.type,
              plugin.settings.image.attachmentFolder,
            )
            insertAtCaret(saved.insert)
            // Bind the saved file to the conversation (deleted with it).
            onAttachmentSaved?.(saved.path)
          } catch {
            new Notice(`保存到库失败：${f.name || '粘贴的内容'}`)
          }
        }
      } finally {
        setAttaching((n) => Math.max(0, n - files.length))
      }
    },
    [plugin, insertAtCaret, onAttachmentSaved],
  )

  // Pasted images (or any pasted file with a recognizable extension) are
  // saved into the vault and inserted as embeds/links; plain text pastes
  // fall through to the default behavior.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    const savable = files.filter(
      (f) => f.type.startsWith('image/') || extFromName(f.name) !== '',
    )
    if (savable.length === 0) return
    e.preventDefault()
    void saveFiles(savable)
  }

  const attachItems: PickerItem[] = useMemo(
    () => [
      {
        id: 'vault',
        label: '从库中选择…',
        description: '笔记 / 图片 / 任意附件，插入为链接',
        icon: 'image',
        iconFallback: 'file',
      },
      {
        id: 'upload',
        label: '从系统添加…',
        description: '上传图片或其他文件到库里（可多选）',
        icon: 'upload',
        iconFallback: 'plus',
      },
    ],
    [],
  )

  const handleAttachSelect = (id: string) => {
    setAttachMenu(false)
    if (id === 'vault') {
      setFilePicker(true)
    } else {
      fileInputRef.current?.click()
    }
  }

  // Hand-typed "/chats" / "/rewind" / "/model" + Enter — useAgent asks us to
  // open the matching submenu (the input box is already cleared by
  // submitText). '/chats' routes to the manager sheet owned by Chat (追加⑯);
  // the rest stay in the local Menu union.
  useEffect(() => {
    if (!pickerRequest) return
    setMention(null)
    setSlash(null)
    setAttachMenu(false)
    if (pickerRequest === 'chats') {
      onChatsOpenChange(true, 'command')
    } else if (pickerRequest === 'rewind') {
      // 追加66: 与按钮同一套 BacktrackMenu 浮层——命令入口只是换了个
      // 打开方式，列表/选择/回溯逻辑完全一致。
      onChatsOpenChange(false)
      onRewindCommand()
    } else if (pickerRequest === 'mode') {
      // M2-T2: /mode 无参 → 弹审批模式选择窗。数据面同 /model 选择窗：
      // hermes 引擎用 hub 缓存的清单（未就绪禁用占位）；M2-T8 起 core 引擎
      // 也发此请求，数据面由 Chat 按引擎切换（core = 固定三模式行）。
      onChatsOpenChange(false)
      menuFromPicker.current = true
      setMenu('mode')
    } else {
      onChatsOpenChange(false)
      menuFromPicker.current = true
      setMenu(pickerRequest)
    }
    onClearPickerRequest()
  }, [pickerRequest, onClearPickerRequest, onChatsOpenChange, onRewindCommand])

  // When the menu closes (any path — Esc, pick, closeAll), reset the
  // picker-origin flag so the next manual slash can open its own menu cleanly.
  useEffect(() => {
    if (!menu) menuFromPicker.current = false
  }, [menu])

  // Only ONE command surface at a time: opening the manager dismisses any
  // open submenu (they share the keyboard ref and would fight over it).
  useEffect(() => {
    if (chatsOpen) setMenu(null)
  }, [chatsOpen])

  /* ── command palette ─────────────────────────────────────────────── */

  // M2-T4: 面板数据 = useAgent 构建的引擎视图（panelCommands）——插件命令
  // +（hermes 引擎）通告命令，通用渲染零特判；可见性不在这里判断。
  const commandItems: PickerItem[] = useMemo(
    () =>
      buildCommandCandidates(
        panelCommands,
        slash?.level === 1 ? slash.query : '',
      ).map(
        (c) => ({
          id: c.id,
          // Chinese name leads; the English command word follows, faint.
          label: c.label,
          sub: `/${c.id}`,
          description: c.description,
          icon: c.icon,
          // 来源徽章优先（hermes 通告命令标「Hermes」）；其次是参数提示
          // 徽章——只在它比裸命令词传递更多信息时显示。
          badge:
            c.badge ??
            (c.usage && c.usage !== `/${c.id}` ? c.usage : undefined),
        }),
      ),
    [slash, panelCommands],
  )

  // Thinking-level submenu: 追加㊶（用户指示：命令的启用情况不在输入框
  // 相关界面说明）——去掉「当前」徽章，只列强度档位。
  const thinkItems: PickerItem[] = useMemo(
    () =>
      THINK_OPTIONS.map((o) => ({
        id: o.id,
        label: o.label,
        sub: o.token,
        description: o.description,
        icon: 'lightbulb',
      })),
    [thinking],
  )

  // Model profiles: a "恢复默认" row first (clears the session override),
  // then every configured profile. 追加㊶：同去「当前/默认」徽章。
  // M2-T1: hermes 路径下 /model 选择窗改用 hermes 自己的模型清单——绝不回落
  // 插件档案列表（档案 model_id ≠ hermes encoded choice id，混用会诱导用户
  // 选到 hermes 拒绝的 id）。清单未就绪显示「hermes 清单加载中」并禁用选择。
  const modelItems: PickerItem[] = useMemo(() => {
    if (hermesPath) {
      if (!hermesModelsReady || !hermesModels || hermesModels.length === 0) {
        return [
          {
            id: '__hermes_loading__',
            label: 'hermes 清单加载中…',
            description: '模型清单由 hermes 会话建立/恢复时下发，就绪后方可选择',
            icon: 'loader-2',
            iconFallback: 'clock',
          },
        ]
      }
      return hermesModels
        .filter((m) => {
          // 过滤：只显示插件已配置的模型（按模型名匹配 hermes modelId）。
          if (!hermesConfiguredModelNames || hermesConfiguredModelNames.size === 0) return true
          const modelName = m.id.includes(':')
            ? m.id.split(':').slice(1).join(':')
            : m.id
          return hermesConfiguredModelNames.has(modelName.toLowerCase())
        })
        .map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description,
          icon: 'cpu',
          badge: m.current ? '当前' : undefined,
        }))
    }
    return [
      {
        id: '',
        label: '↩ 恢复默认模型',
        description: '清除本会话的覆盖，跟随设置里的默认档案',
        icon: 'undo-2',
        iconFallback: 'x',
      },
      ...models.map((m) => ({
        id: m.id,
        label: m.name,
        description: m.description,
        icon: 'cpu',
      })),
    ]
  }, [models, hermesPath, hermesModels, hermesModelsReady, hermesConfiguredModelNames])

  // M2-T2: /mode 选择窗行——hermes 审批模式清单（hub 按会话缓存），未就绪
  // 显示「清单加载中」并禁用选择（绝不回落插件侧任何兜底）。
  const modeItems: PickerItem[] = useMemo(() => {
    if (!modesReady || !modes || modes.length === 0) {
      return [
        {
          id: '__hermes_loading__',
          label: 'hermes 清单加载中…',
          description: '审批模式清单由 hermes 会话建立/恢复时下发，就绪后方可选择',
          icon: 'loader-2',
          iconFallback: 'clock',
        },
      ]
    }
    return modes.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      icon: 'shield-question',
      iconFallback: 'shield',
      badge: m.current ? '当前' : undefined,
    }))
  }, [modes, modesReady])

  // Sub-agent manager (多 Agent 体系, styled after the conversation
  // manager): 主对话入口 + 每个已启用的子代理——行内带编辑人设笔记操作，
  // 当前对话所属的代理标记「当前」徽章。
  // Hermes 模式（纯壳）agent 独立：不提供插件子代理管理，
  // 列表只剩 agents（该模式下仅主对话出口）。
  const agentItems: PickerItem[] = useMemo(
    () => [
      ...agents.map((a) =>
        a.id === ''
          ? {
              id: '',
              // 统一 emoji 前缀列宽：主对话无 emoji，补通用占位，让面板里
              // 各代理文字起点一致（用户报：主对话/Hermes/追问启发没对齐）。
              label: `✨ ${a.name}`,
              description: a.description,
              icon: 'message-circle',
              badge: a.current ? '当前' : undefined,
            }
          : {
              id: a.id,
              label: `${a.emoji ? `${a.emoji} ` : '✨ '}${a.name}`,
              description: a.description,
              icon: 'bot',
              iconFallback: 'user',
              badge: a.current ? '当前' : undefined,
              actions: a.path
                ? [{ id: 'edit', icon: 'pencil', label: '编辑人设笔记' }]
                : undefined,
            },
      ),
    ],
    [agents, hermesPath],
  )

  // The LIVE '///' panel filters those rows by the typed token (like the
  // '//' skill picker does); the menu-path panel (pickerRequest) shows all.
  const agentPanelItems: PickerItem[] = useMemo(() => {
    const q =
      slash?.level === 3 ? slash.query.trim().toLowerCase() : ''
    if (!q) return agentItems
    return agentItems.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.description ?? '').toLowerCase().includes(q),
    )
  }, [agentItems, slash])

  const handleCommandSelect = (id: string) => {
    // M2-T4: 在面板视图里找（插件命令 + hermes 通告命令统一走这里）。
    const cmd = panelCommands.find((c) => c.id === id)
    if (!cmd) return
    if (cmd.kind === 'menu') {
      // Capability backstop: /think 没有 extendedThinking 能力的引擎上已被
      // 面板视图过滤，这里是防御性兜底，防任何漏网入口打开死菜单。
      // M2-T1: /model 已 hermes-aware（弹 hermes 模型清单），不拦。
      if (hermesPath && id === 'think') return
      // Menu-kind ids: think / model open the local submenu; mode
      // (M2-T8 收口：审批模式选择窗，数据面按引擎切换) 同款。
      // the conversation manager (chats) is owned by Chat — open it in place.
      // 追加66: rewind 不再开本地子菜单，改弹与回溯按钮同一套的
      // BacktrackMenu 浮层（同一设计、不同入口）。
      // These are functional commands with no argument to type, so the
      // "/cmd" text is cleared instead of retained (用户指示).
      setSlash(null)
      setValue('')
      if (id === 'chats') {
        onChatsOpenChange(true, 'command')
      } else if (id === 'rewind') {
        onChatsOpenChange(false)
        onRewindCommand()
      } else {
        onChatsOpenChange(false)
        // Clearing the "/cmd" text shrinks the textarea value, which fires a
        // `select` event → handleSelect → refreshPickers. With the slash now
        // gone, refreshPickers would setMenu(null) and the submenu we just
        // opened flashes shut. Flag the menu as picker-opened (same guard the
        // pickerRequest path uses) so refreshPickers leaves it alone. The flag
        // auto-resets when the menu closes (the `!menu` effect below).
        menuFromPicker.current = true
        setMenu(id as Menu)
      }
    } else if (cmd.kind === 'insert') {
      // Leave "/name " in the box so the user types the argument + Enter.
      applyInsert(0, `/${id} `, () => setSlash(null))
    } else {
      // immediate：选中即发（branch 等插件命令；hermes 通告无 hint 命令
      // 同款——经 send 原样透传，/reset 的确认由 useAgent send 层兜底）。
      submitText(`/${id}`)
    }
  }

  const handleThinkSelect = (id: string) => submitText(`/think ${id}`)

  const handleModeSelect = (id: string) => {
    setMenu(null)
    // 「加载中」占位行不可选，忽略点击。
    if (id === '__hermes_loading__') return
    if (onPickMode) void onPickMode(id)
  }

  const handleModelSelect = (id: string) => {
    setMenu(null)
    // M2-T1: hermes 路径下选中 → hub.setModel(model_id)；「加载中」占位行
    // （__hermes_loading__）不可选，忽略点击。
    if (hermesPath) {
      if (id === '__hermes_loading__') return
      if (onPickHermesModel) void onPickHermesModel(id)
      return
    }
    onPickModel(id)
  }

  const handleAgentSelect = (id: string) => {
    // Both open paths leave a residue to clear: the live '///' trigger keeps
    // the slashes in the box, the pickerRequest path already cleared it.
    setMenu(null)
    setSlash(null)
    setValue('')
    onPickAgent(id)
  }

  // Per-row management actions in the agent manager panel. These do NOT
  // select the row — the click never opens that agent's conversation.
  const handleAgentAction = (itemId: string, actionId: string) => {
    if (actionId !== 'edit') return
    const path = agents.find((a) => a.id === itemId)?.path
    if (!path) return
    setMenu(null)
    setSlash(null)
    setValue('')
    void plugin.app.workspace.openLinkText(path, '')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mobile software keyboards / IMEs vary; never intercept mid-composition.
    if (e.nativeEvent.isComposing) return

    const activeHandle = chatsOpen
      ? commandRef.current
      : menu
        ? commandRef.current
        : attachMenu
          ? attachRef.current
          : filePicker
            ? filePickerRef.current
            : slash
              ? slash.level === 2
                ? slashRef.current
                : commandRef.current
              : mention
                ? pickerRef.current
                : null
    if (activeHandle) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          activeHandle.move(1)
          return
        case 'ArrowUp':
          e.preventDefault()
          activeHandle.move(-1)
          return
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          activeHandle.selectActive()
          return
        case ' ':
          // Space in the mention picker selects the highlighted item and keeps
          // multi-selecting (用户指示) — Enter confirms the whole selection.
          if (mention && activeHandle === pickerRef.current) {
            e.preventDefault()
            pickerRef.current?.addActive()
            return
          }
          break
        case 'Escape':
          e.preventDefault()
          // Esc steps back one layer: manager sheet → submenu → attach
          // sheet → file picker, then closes everything.
          if (chatsOpen) onChatsOpenChange(false)
          else if (menu) setMenu(null)
          else if (attachMenu) setAttachMenu(false)
          else if (filePicker) setFilePicker(false)
          else closeAll()
          return
      }
    }

    if (e.key === 'Backspace') {
      // Backspace at the very start (nothing to delete) exits the inline
      // editor box — the natural "go back" gesture. 追加⑱ 补刀.
      const ta = textareaRef.current
      if (ta && ta.selectionStart === ta.selectionEnd) {
        if (ta.selectionStart === 0 && onBackspaceAtStart) {
          e.preventDefault()
          onBackspaceAtStart()
          return
        }
        // A chip/pill is ONE whole unit — Backspace right after it removes the
        // ENTIRE run at once, not one character at a time (用户指示).
        const span = spans.find((s) => s.de === ta.selectionStart)
        if (span) {
          e.preventDefault()
          const newValue = value.slice(0, span.vs) + value.slice(span.ve)
          setValue(newValue)
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(span.ds, span.ds)
            autoGrow()
          })
          return
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  /* ── render ──────────────────────────────────────────────────────── */

  const showCommandList = slash?.level === 1 && !menu && !chatsOpen
  const commandTitle =
    menu === 'think' ? (
      <>
        <Icon name="lightbulb" />
        思考强度
      </>
    ) : menu === 'model' ? (
      <>
        <Icon name="cpu" />
        选择模型
      </>
    ) : menu === 'agent' ? (
      <>
        <Icon name="bot" fallback="user" />
        子代理管理
      </>
    ) : menu === 'mode' ? (
      <>
        <Icon name="shield-question" fallback="shield" />
        审批模式
      </>
    ) : (
      <>
        <Icon name="command" />
        命令
        {slash && slash.query.trim() ? <code>/{slash.query}</code> : null}
      </>
    )

  // Render the display text with a styled chip at every span. Mention chips
  // render as plain light-blue spans (the textarea is above them, so they are
  // not themselves clickable — hover-preview comes from the textarea's mouse
  // events).
  const renderDisplay = (): React.ReactNode => {
    const out: React.ReactNode[] = []
    let pos = 0
    for (const s of spans) {
      if (s.ds > pos) {
        out.push(
          <React.Fragment key={pos}>{display.slice(pos, s.ds)}</React.Fragment>,
        )
      }
      if (s.kind === 'command') {
        // Leading icon = the SAME lucide icon the command palette shows for
        // this command (用户指示，追加㊱); unknown "/abc" falls back to the
        // palette glyph. Level-2 pills are "//skill-name" invocations (追加
        // ㊺): same pill, sparkles glyph, name-only label.
        const def =
          s.level === 2 ? undefined : COMMANDS.find((c) => c.label === s.label)
        out.push(
          <span key={s.ds} className="UNagent-composer-cmd-token">
            <Icon
              name={def?.icon ?? (s.level === 2 ? 'sparkles' : 'command')}
              fallback="command"
            />
            {s.label}
          </span>,
        )
      } else {
        // `label` is the visible text (marker carries the invisible 1em pad
        // so the textarea lays out the same width as this icon+label chip).
        const chipText = s.label ?? s.marker.slice(1)
        const icon = (
          <Icon
            name={MENTION_KIND_ICON[s.mkind ?? 'file']}
            fallback="file"
          />
        )
        // The chip renders BELOW the textarea, so it is not itself clickable —
        // hover-preview is driven from the textarea's mouse events instead.
        // 追加73: chip 外观保持简洁，引用的选中原文放 title 悬停可见。
        out.push(
          <span
            key={s.ds}
            className="UNagent-composer-mention-chip"
            title={s.snippet || undefined}
          >
            {icon}
            {chipText}
          </span>,
        )
      }
      pos = s.de
    }
    if (pos < display.length) {
      out.push(<React.Fragment key={pos}>{display.slice(pos)}</React.Fragment>)
    }
    return out
  }

  // Imperative handle: the Alt+Z command focuses + optionally inserts a
  // reference (补刀·五十一).
  useImperativeHandle(
    ref,
    () => ({
      focusInput(reference?: string) {
        // Focus FIRST so the caret lands at a known spot — the 引用对话 button
        // may fire while the textarea is unfocused (追加46).
        const el = textareaRef.current
        if (el) el.focus()
        else requestAnimationFrame(() => textareaRef.current?.focus())
        if (reference) {
          insertAtCaret(reference)
        }
      },
    }),
    [insertAtCaret],
  )

  return (
    <div className="UNagent-composer-wrap">
      {children}
      {attaching > 0 && (
        <div className="UNagent-composer-saving" role="status">
          <span className="UNagent-composer-saving-dot" />
          正在存入 {attaching} 个文件…
        </div>
      )}
      {(showCommandList || menu) && (
        <CommandPicker
          ref={commandRef}
          ariaLabel={
            menu === 'think'
              ? '思考强度'
              : menu === 'model'
                ? '选择模型'
                : menu === 'agent'
                  ? '子代理管理'
                  : menu === 'mode'
                    ? '审批模式'
                    : '命令面板'
          }
          title={commandTitle}
          hint={
            menu === 'agent'
              ? '点击进入对话 · 右侧按钮：编辑人设笔记'
              : menu
                ? '↑↓ 选择 · Enter 确认 · Esc 返回'
                : '↑↓ 选择 · Enter 执行 · Esc 关闭'
          }
          items={
            menu === 'think'
              ? thinkItems
              : menu === 'model'
                ? modelItems
                : menu === 'agent'
                  ? agentItems
                  : menu === 'mode'
                    ? modeItems
                    : commandItems
          }
          query={menu ? '' : slash?.query ?? ''}
          emptyText={
            menu === 'model'
              ? '还没有模型档案（设置 → 模型 中添加）'
              : menu === 'agent'
                ? '还没有子代理——点「＋ 新建子代理」描述效果即可创建'
                : menu === 'mode'
                  ? '审批模式清单尚未就绪'
                  : '没有匹配的命令'
          }
          onSelect={
            menu === 'think'
              ? handleThinkSelect
              : menu === 'model'
                ? handleModelSelect
                : menu === 'agent'
                  ? handleAgentSelect
                  : menu === 'mode'
                    ? handleModeSelect
                    : handleCommandSelect
          }
          onAction={menu === 'agent' ? handleAgentAction : undefined}
          onClose={menu ? () => setMenu(null) : () => setSlash(null)}
        />
      )}
      {attachMenu && (
        <CommandPicker
          ref={attachRef}
          ariaLabel="添加文件"
          title={
            <>
              <Icon name="paperclip" fallback="plus" />
              添加文件
            </>
          }
          hint="↑↓ 选择 · Enter 确认 · Esc 关闭"
          items={attachItems}
          emptyText=""
          onSelect={handleAttachSelect}
          onClose={() => setAttachMenu(false)}
        />
      )}
      {filePicker && (
        <MentionPicker
          ref={filePickerRef}
          fileMode
          level={1}
          query=""
          onSelect={(insert) => {
            insertAtCaret(insert)
            setFilePicker(false)
          }}
          onMultiSelect={(inserts) => {
            insertAtCaret(inserts.join(' '))
            setFilePicker(false)
          }}
          onClose={() => setFilePicker(false)}
        />
      )}
      {slash?.level === 2 && (
        <SlashPicker
          ref={slashRef}
          query={slash.query}
          skills={availableSkills}
          onSelect={(name) => applyInsert(0, `//${name}`, () => setSlash(null))}
          onClose={() => setSlash(null)}
        />
      )}
      {/* The LIVE '///' sub-agent manager (多 Agent 体系): same rows/actions
          as the menu-path panel, but opened by the slash trigger itself and
          filtered by the typed token — like '//' opens the skill picker. */}
      {slash?.level === 3 && !menu && !chatsOpen && (
        <CommandPicker
          ref={commandRef}
          ariaLabel="子代理管理"
          title={
            <>
              <Icon name="bot" fallback="user" />
              子代理管理
              {slash.query.trim() ? <code>///{slash.query}</code> : null}
            </>
          }
          hint="点击进入对话 · 右侧按钮：编辑人设笔记"
          items={agentPanelItems}
          query={slash.query}
          emptyText="没有匹配的子代理——选「＋ 新建子代理」描述效果即可创建"
          onSelect={handleAgentSelect}
          onAction={handleAgentAction}
          onClose={() => setSlash(null)}
        />
      )}
      {mention && (
        <MentionPicker
          ref={pickerRef}
          level={mention.level}
          query={mention.query}
          onSelect={(insert) =>
            applyInsert(mention.at, insert, () => setMention(null))
          }
          onMultiSelect={(inserts) =>
            applyInsert(mention.at, inserts.join(' '), () => setMention(null))
          }
          onClose={() => setMention(null)}
        />
      )}

      {/* One card: paperclip + growing textarea + send/stop. */}
      <div className="UNagent-composer">
        {editingMessage && (
          <div className="UNagent-composer-editbar">
            <Icon name="square-pen" fallback="pencil" />
            <span className="UNagent-composer-editbar-label">
              重新编辑
            </span>
            <button
              className="UNagent-composer-editbar-cancel"
              onClick={() => {
                // 取消 = 退出编辑并清空输入框（追加54）。
                setValue('')
                requestAnimationFrame(autoGrow)
                onEditCancel?.()
              }}
              title="取消编辑"
            >
              取消
            </button>
          </div>
        )}
        <button
          className="UNagent-composer-btn UNagent-composer-attach"
          onClick={() => {
            setMenu(null)
            setAttachMenu((v) => !v)
          }}
          aria-label="添加文件或图片"
          title="添加文件或图片（可直接粘贴图片）"
        >
          <Icon name="paperclip" fallback="plus" />
        </button>
        <div
          className={`UNagent-composer-inputbox${
            overlayActive ? ' UNagent-composer-inputbox--overlay' : ''
          }`}
        >
          {/* Live in-input highlight (命令字变色 · 引用浅蓝): the textarea shows
              the DISPLAY text (compact chip markers); when any marker is
              present, its text goes transparent and this layer paints the
              styled chips/pills over them. Because the textarea lays out the
              SAME display text, the caret always aligns with the visible
              chips. Two layers (追加㉞): the outer div is a STATIC clipping
              window; the inner one rides translateY(-scrollTop) in lockstep
              with the textarea. */}
          {overlayActive && (
            <div className="UNagent-composer-cmd" aria-hidden="true">
              <div ref={cmdOverlayRef} className="UNagent-composer-cmd-inner">
                {renderDisplay()}
              </div>
            </div>
          )}
          {value === '' && (
            <div className="UNagent-composer-hint" aria-hidden="true">
              {/* Placeholder state line: the effective model + the thinking
                  strength — what runs on Enter at a glance. 追加㊳ 曾误删
                  （把「命令启用状态不在输入框说明」理解成了这行），追加㊶
                  恢复：用户指的是子菜单里的状态徽章，不是这行占位。 */}
              <span className="UNagent-composer-hint-state">
                <span className="UNagent-composer-hint-ellipsis">
                  {hermesPath
                    ? `${hermesModels?.find((m) => m.current)?.label ?? 'Hermes'} · ${
                        THINK_OPTIONS.find((o) => o.id === thinking)?.label ??
                        thinking
                      }`
                    : modelName +
                      ` · ${
                        THINK_OPTIONS.find((o) => o.id === thinking)?.label ??
                        thinking
                      }`}
                </span>
              </span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="UNagent-composer-input"
            rows={1}
            placeholder=""
            aria-label="发消息"
            value={display}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncOverlay}
            onMouseMove={textareaMouseMove}
            onMouseLeave={closeNotePreview}
          />
        </div>
        {isStreaming ? (
          <button
            className="UNagent-composer-btn UNagent-composer-stop"
            onClick={onAbort}
            aria-label="停止生成"
            title="停止生成"
          >
            <Icon name="square" />
          </button>
        ) : docSelected ? (
          <button
            className="UNagent-composer-btn UNagent-composer-send UNagent-composer-ref"
            onClick={referenceDocSelection}
            aria-label="引用选中的内容"
            title="引用选中的内容"
          >
            <Icon name="plus" />
          </button>
        ) : (
          <button
            className="UNagent-composer-btn UNagent-composer-send"
            onClick={submit}
            disabled={value.trim().length === 0}
            aria-label="发送"
            title="发送"
          >
            <Icon name="arrow-up" />
          </button>
        )}
      </div>
      {/* Hidden system file chooser (paperclip → 从系统添加). */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="UNagent-composer-file"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? [])
          if (fs.length > 0) void saveFiles(fs)
          e.target.value = ''
        }}
      />
    </div>
  )
},
)
