import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileSystemAdapter, Notice, Platform } from 'obsidian'

import { AgentEvent, runAgent } from '../../core/agent/agentRunner'
import { askRewindRollback } from '../../core/agent/ConfirmModal'
import { buildSystemPrompt } from '../../core/agent/systemPrompt'
import type {
  AskQuestion,
  AskResult,
  ConfirmRequest,
  ToolContext,
} from '../../core/agent/types'
import { ChatMessage, ThinkLevel } from '../../core/llm/base'
import { LLMError, describeError, friendlyMessage } from '../../core/llm/errors'
import { createLLMProvider } from '../../core/llm/manager'
import { createImageProvider } from '../../core/image/manager'
import { SkillRegistry } from '../../core/skills/SkillRegistry'
import type { Skill } from '../../core/skills/types'
import { skillsFolder } from '../../core/skills/skillLoader'
import { agentsFolder } from '../../core/agents/agentLoader'
import { HERMES_AGENT_NAME } from '../../core/agents/agentDef'
import { expandHermesRefs } from '../../core/hermes/refExpand'
import { DEFAULT_HERMES_COMMAND, spawnDetachedLocal } from '../../core/desktop/localAgent'
import {
  getHermesHub,
  type PermissionRequestEvent,
} from '../../core/hermes/hermesHub'
import {
  HERMES_RESET_CONFIRM,
} from '../../core/hermes/advertisedCommands'
import type { EngineId } from '../../core/engine/capabilities'
import { getOrCreateProjectSession, runHermesTurn } from '../../core/hermes/runHermesTurn'
import { listHermesSkills } from '../../core/hermes/hermesSkills'
import { warmupHermesNow } from '../../core/hermes/warmup'
import {
  ensureHermesProject,
  ensureHermesProjectOnce,
} from '../../core/hermes/hermesProject'
import type { HermesModeId } from '../../core/hermes/types'
import { usePlugin } from '../../contexts/plugin-context'
import type { LLMSettings } from '../../settings/settings'
import { McpManageModal } from '../../settings/McpManageModal'
import {
  MAIN_AGENT_KEY,
  isMcpEnabledForAgent,
  isSkillEnabledForAgent,
  isToolEnabledForAgent,
} from '../../settings/settings'
import {
  activeModel,
  activeProfile,
  resolveCapabilities,
  resolveSessionModel,
  resolveVisionModel,
} from '../../settings/settings'
import {
  ConversationMeta,
  StoredConversation,
  STORE_VERSION,
  conversationDepth,
  deleteConversation as deleteStoredConversation,
  deriveTitle,
  flattenConversationTree,
  loadConversation,
  loadIndex,
  makeConversationId,
  metaOfConversation,
  normalizeAiFolder,
  saveConversation,
  sanitizeMessages,
} from '../../utils/conversationStore'
import { aiFolderExclusion, effectiveExclusions } from '../../utils/exclusions'
import { extractImageEmbedPaths, readImageAsDataUrl } from '../../utils/attachments'
import { buildRefContext, extractNoteRefs } from '../../utils/refContext'
import { addMemoryEntry, loadMemorySnapshot } from '../../utils/memoryStore'
import {
  buildReflectPrompt,
  buildReflectTranscript,
  parseReflectResult,
  shouldReflect,
  type ReflectSuggestion,
} from '../../utils/reflect'
import { agentDocPath } from '../../utils/evolutionSetup'
import { readText } from '../../utils/vaultIO'
import { dlog } from '../../utils/diagnosticLog'
import {
  MAX_COMPACT_MEMORIES,
  MIN_COMPACT_MESSAGES,
  buildCompactPrompt,
  buildCompactTranscript,
  compactionMessageText,
  parseCompactResult,
} from '../../utils/compact'
import {
  COMMANDS,
  HERMES_MODE_LABEL,
  HERMES_MODE_USAGE,
  buildLearnPrompt,
  buildPanelCommands,
  parseHermesModeArg,
  parseThinkLevel,
} from './commands'
import { parseDirective } from './slash'
import { parseTodos } from '../../tools/todoWrite'
import { historyTextOfBlocks } from './transcript'
import {
  UiBlock,
  UiMessage,
  activeOf,
  genId,
  switchMessageVersion,
  turnPoints,
  withNewVersion,
} from './types'

// Mobile memory guards (移动端): a raw phone photo can be tens of MB — base64
// inflates it ~1.33× and the whole string sits in JS memory for the request.
// iOS WKWebView kills the app's process under sustained memory pressure,
// which the user sees as "the plugin keeps turning itself off". Cap both the
// per-image size and the per-message count.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_COUNT = 4

/** One row of the /chats picker: a tree-flattened conversation + UI flags. */
export interface ConversationListItem {
  meta: ConversationMeta
  depth: number
  current: boolean
  /** 桌面端 hermes 会话合成行（无插件侧文件）：面板不渲染插件 actions。 */
  external?: boolean
}

/** One row of the /model picker: a configured profile + UI flags. */
export interface ModelListItem {
  /** Profile id — what pickModel receives (and what the override stores). */
  id: string
  name: string
  /** Vendor protocol + model + endpoint, for the row subtitle. */
  description: string
  /** The global default (settings' active profile). */
  isDefault: boolean
  /** This conversation currently overrides to this profile. */
  current: boolean
}

/** One row of the /agent picker: an enabled sub-agent (多 Agent 体系). */
export interface AgentListItem {
  /** Agent name — what pickAgent receives. '' = back to the main agent. */
  id: string
  name: string
  emoji?: string
  description: string
  /** Persona-note path (user agents only) — the manager panel's edit action
   *  opens it for hand-editing. */
  path?: string
  /** This conversation currently belongs to this agent. */
  current: boolean
}

const KNOWN_COMMANDS = new Set(COMMANDS.map((c) => c.id))

/** Mutable conversation identity kept in a ref (read inside async flows). */
interface ConvIdentity {
  id: string | null // null = not yet persisted (brand-new conversation)
  title: string
  parentId: string | null
  parentMessageCount: number
  createdAt: number | null
  /** Sub-agent this conversation belongs to (多 Agent 体系); null = main. */
  agentId: string | null
  /** Bound hermes ACP session (补刀·五十六); null = none yet. */
  hermesSessionId: string | null
  /** 分支源主干 hermes 会话（补刀·六十）：首轮经 session/fork 建真分支，
   *  消费后清 undefined。缺省 = 非分支对话。 */
  forkSourceHermesSessionId?: string
}

const freshIdentity = (): ConvIdentity => ({
  id: null,
  title: '',
  parentId: null,
  parentMessageCount: 0,
  createdAt: null,
  agentId: null,
  hermesSessionId: null,
})

// Drives the note-management agent: holds the message list + conversation
// identity (persisted to <aiFolder>/conversations/), runs the tool loop for
// each send, and streams text + tool-call blocks into the live assistant
// message. Conversation management (multi-level tree): /chats switches,
// /branch creates a context-inheriting child, /rewind truncates to any turn,
// 清空 starts a fresh conversation — all persisted; the most recently used
// conversation is resumed on startup. Supports mid-stream abort and retry.
//
// '/' commands are handled LOCALLY (no LLM call): they echo the user message
// plus an assistant note describing the state change. The one exception is
// '/learn', which runs as a normal agent turn (runCore rewrites its text and
// force-loads skill-creator). '//' force-loads a skill.
//
// Hermes 性能：warmupNow 把连接 + 项目会话创建（3.7-9.9s）提前到用户打字/
// 切换模式时后台完成，首次发送不再干等 hermes 侧 session/new。
export function useAgent() {
  const plugin = usePlugin()
  // 预热触发（幂等，fire-and-forget，失败静默）——Composer 输入、切换
  // hermes 模式、打开 hermes 会话三处共用；门控（enabled/移动端/本地
  // 路径）统一在 warmup.ts，main.ts onload 也调同一函数。
  const warmupNow = (): void => {
    warmupHermesNow(plugin)
  }
  const [messages, setMessagesState] = useState<UiMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // AI-initiated question panel (追加63): while an ask_user tool call is
  // awaiting an answer, this holds the question the panel above the composer
  // renders; the pending promise's resolver is parked in askResolveRef.
  // 追加76: 多问题批 —— session 持有整批问题 + 当前题号 + 已收集答案，
  // 答完一题自动切下一题，全部答完（或用户关闭）才 resolve 给工具。
  interface AskSession {
    questions: AskQuestion[]
    index: number
    answers: string[]
  }
  const [askSession, setAskSession] = useState<AskSession | null>(null)
  const askSessionRef = useRef<AskSession | null>(null)
  const askResolveRef = useRef<((res: AskResult) => void) | null>(null)

  // 补刀·五十六: hermes ACP 权限审批——hub 把 session/request_permission
  // 转发到这里，面板（HermesApprovalPanel）与 ask_user 同槽位渲染；用户
  // 点选后经 answerHermesPermission 回包（不回复则 hub 55s 后自动按
  // cancelled 处理，hermes 侧 fail-closed 拒绝）。
  const [pendingHermesPermission, setPendingHermesPermission] =
    useState<PermissionRequestEvent | null>(null)

  // M2-T8 主 agent 审批还原：破坏性工具的确认不再走原生 ConfirmModal
  // （plugin.confirm），改经 React 槽位渲染 ConfirmApprovalPanel——与
  // hermes 审批面板同形态（Yes/No）。confirm() 返回 Promise，面板点选后
  // answerConfirm 回包 resolve；No/关闭 = false（工具收到 user_cancelled）。
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(
    null,
  )
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null)

  // 进化 B 案（AI 反思建议）：实质对话轮结束后按节流跑一次复盘（一次性额
  // 外模型调用），模型提出的建议进这个确认队列——**用户点 ✓ 之前绝不写
  // 盘**。reflectGateRef = 每对话节流状态（最近一次反思的轮号，随对话切
  // 换重置）；reflectAbortRef = 在途反思的控制器（用户发新消息时打断）。
  const [pendingSuggestions, setPendingSuggestions] = useState<
    ReflectSuggestion[]
  >([])
  const reflectGateRef = useRef<{ convId: string; lastTurn: number }>({
    convId: '',
    lastTurn: 0,
  })
  const reflectAbortRef = useRef<AbortController | null>(null)

  // Mirrors `messages` synchronously (state lags one render) so async flows
  // — autosave, branch, switch — always read the latest list.
  const messagesRef = useRef<UiMessage[]>([])
  const setMessages = useCallback(
    (updater: (prev: UiMessage[]) => UiMessage[]) => {
      setMessagesState((prev) => {
        const next = updater(prev)
        messagesRef.current = next
        return next
      })
    },
    [],
  )

  // Frozen snapshots of the three evolution files (追加⑲) — agent.md
  // (persona doc), user.md (profile entries), memory.md (memory entries) —
  // loaded once per conversation on first send. A ref, not state: it never
  // triggers a render, and every turn reads the same frozen set — mid-session
  // writes hit the files but only take effect next conversation. Reset on
  // switch/new.
  const brainRef = useRef<{
    agent: string
    user: string[]
    memory: string[]
    /** Persona body of this conversation's sub-agent ('' = main agent). */
    agentPersona: string
  } | null>(null)

  // Vault paths of attachments this conversation added from OUTSIDE the
  // vault (paste/upload, 追加⑱ 补刀). Bound to the conversation — deleted
  // from the vault when the conversation is deleted; the message text keeps
  // the path (a wiki link) for traceability. Loaded on open/boot, saved on
  // persist, reset on new/branch.
  const attachmentsRef = useRef<string[]>([])
  const onAttachmentSaved = useCallback((path: string) => {
    attachmentsRef.current = attachmentsRef.current.includes(path)
      ? attachmentsRef.current
      : [...attachmentsRef.current, path]
  }, [])

  // Per-conversation session state (thinking + modelOverride persist with
  // the conversation).
  const [thinking, setThinking] = useState<ThinkLevel>('off')
  const [modelOverride, setModelOverride] = useState<string | null>(null)

  // Task #8: 最近一轮 done 事件报告的真实 prompt token 用量（undefined =
  // 还没跑过带 usage 的轮次）。经 agentBridge 发布给 Chat 头部用量 chip；
  // 新对话 / 切换会话时清空（各 reset 点与 brainRef 同步）。
  const [lastPromptTokens, setLastPromptTokens] = useState<number | undefined>(
    undefined,
  )

  // Conversation identity + the persisted conversation index (drives /chats).
  const convRef = useRef<ConvIdentity>(freshIdentity())
  const [convId, setConvId] = useState<string | null>(null)
  // 追加62: convId 的 ref 镜像——runCore 工具闭包（pushUndo 打会话戳）需要
  // 读到最新值，state 本身对异步闭包会 stale。
  const convIdRef = useRef<string | null>(null)
  convIdRef.current = convId
  const [convTitle, setConvTitle] = useState('')
  // State mirror of convRef.current.agentId (the ref is invisible to render).
  const [convAgentId, setConvAgentId] = useState<string | null>(null)
  // M2-T4: hermes 会话经 available_commands_update 下发的命令注册表改由
  // hub 按 sessionId 缓存（生命周期同 sessionStates，断连作废）——这里不再
  // 自持 state，渲染经 hermesStatesTick 从缓存读（见 hermesAdvertised）。
  // M2-T1/T2: hermes 模型/审批模式清单由 hub 按 sessionId 缓存（session/new
  // 与 session/load 响应解析而来）。这里订阅变更通知，bump tick 驱动选择窗
  // 重渲染；清单未就绪时选择窗禁用（绝不回落插件档案列表）。
  const [hermesStatesTick, setHermesStatesTick] = useState(0)
  // 清单内选择产生的每会话覆盖（mode/model）：每轮幂等 set_mode/set_model
  // 的「模式/模型 id 来源」优先取它，没有才回落到设置值（清单未就绪兜底）。
  const hermesOverridesRef = useRef(
    new Map<string, { model?: string; mode?: HermesModeId }>(),
  )
  // Conversation the user was in BEFORE entering the current sub-agent
  // (追加44): the 返回 button restores it instead of always starting a fresh
  // main-agent conversation. null = never entered an agent from here;
  // { id: null } = entered from a brand-new (unsaved) main conversation.
  const entryConvRef = useRef<{ id: string | null } | null>(null)
  const [convList, setConvList] = useState<ConversationMeta[]>([])
  // Asks the composer to pop open a submenu (hand-typed /chats, /rewind,
  // /model + Enter). 任务一 §1.2: 'mode' = hermes 审批模式选择窗（hermes
  // 路径下主 Composer 消费；core 引擎忽略）。
  const [pickerRequest, setPickerRequest] = useState<
    'chats' | 'rewind' | 'model' | 'think' | 'agent' | 'mode' | null
  >(null)
  // 追加86: /edit 命令的请求载荷——目标用户消息 id。编辑态（editingId）归
  // Chat 管，这里只递信号：Chat 收到后载入输入框并清空本请求。
  const [editRequest, setEditRequest] = useState<string | null>(null)

  // Set whenever messages gain real content; cleared after each persist so
  // the debounced autosave only writes when something actually changed (no
  // rewrite on startup/switch).
  const dirtyRef = useRef(false)

  const confirm = useCallback(
    (request: ConfirmRequest): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve
        setPendingConfirm(request)
      }),
    [],
  )

  // 面板点选后的回包：true = 放行本轮工具；false = 拒绝（含右上角关闭）。
  const answerConfirm = useCallback((ok: boolean) => {
    confirmResolveRef.current?.(ok)
    confirmResolveRef.current = null
    setPendingConfirm(null)
  }, [])

  const noteMsg = (text: string): UiMessage => ({
    id: genId(),
    role: 'assistant',
    blocks: [{ kind: 'text', text }],
  })

  /* ── persistence ──────────────────────────────────────────────────── */

  // Upsert one metadata row into the management list (most-recently-updated
  // first). Shared by persistNow (post-save) and the branch actions, which
  // insert the child OPTIMISTICALLY so it shows up the instant the user
  // branches — no waiting for autosave (追加89).
  const upsertConvMeta = useCallback((meta: ConversationMeta) => {
    setConvList((prev) =>
      [meta, ...prev.filter((e) => e.id !== meta.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    )
  }, [])

  // Write the current conversation to disk (+ index upsert). Assigns an id
  // and title on first save. Fails quietly — a storage hiccup must never
  // block the conversation; the next autosave retries.
  const persistNow = useCallback(
    async (msgs?: UiMessage[]): Promise<void> => {
      const list = sanitizeMessages(msgs ?? messagesRef.current)
      if (list.length === 0) {
        dirtyRef.current = false
        return
      }
      const ident = convRef.current
      if (!ident.id) {
        ident.id = makeConversationId()
        setConvId(ident.id)
      }
      if (!ident.title) {
        ident.title = deriveTitle(list)
        setConvTitle(ident.title)
      }
      if (ident.createdAt === null) ident.createdAt = Date.now()
      const conv: StoredConversation = {
        version: STORE_VERSION,
        id: ident.id,
        title: ident.title,
        createdAt: ident.createdAt,
        updatedAt: Date.now(),
        parentId: ident.parentId,
        parentMessageCount: ident.parentMessageCount,
        messageCount: list.length,
        messages: list,
        thinking,
        modelOverride,
        attachments: attachmentsRef.current,
        ...(ident.agentId ? { agentId: ident.agentId } : {}),
        ...(ident.hermesSessionId
          ? { hermesSessionId: ident.hermesSessionId }
          : {}),
        // 补刀·六十：分支源标记随对话落盘（首轮消费前关 Obsidian 不丢）。
        ...(ident.forkSourceHermesSessionId
          ? { forkSourceHermesSessionId: ident.forkSourceHermesSessionId }
          : {}),
      }
      const folder = plugin.settings.general.aiFolder
      try {
        await saveConversation(plugin.app, folder, conv)
        upsertConvMeta(metaOfConversation(conv))
        dirtyRef.current = false
      } catch {
        // Leave dirty so the next autosave retries.
      }
    },
    [plugin, thinking, modelOverride, upsertConvMeta],
  )

  // Debounced autosave: fires shortly after a turn finishes (or any local
  // echo mutates the list). Skipped while streaming and when clean.
  useEffect(() => {
    if (isStreaming || messages.length === 0 || !dirtyRef.current) return
    const t = window.setTimeout(() => {
      void persistNow()
    }, 600)
    return () => window.clearTimeout(t)
  }, [messages, isStreaming, persistNow])

  // 进化 B 案：换对话（任何路径：切换/新建/分支/子代理）即清场——在途复盘
  // 打断、未确认建议作废（建议属于产生它的那段对话上下文）。节流闸的对话
  // 键在 maybeReflect 内惰性重置。补刀·五十六：未决的 hermes 审批一并清
  // 掉（hub 侧 55s 兜底会按 cancelled 处理 = 拒绝，安全侧倾）。
  useEffect(() => {
    reflectAbortRef.current?.abort()
    setPendingSuggestions([])
    setPendingHermesPermission(null)
  }, [convId])

  // 补刀·五十六：hub 的权限请求转发到面板状态（一插件一 hub 一 handler）。
  useEffect(() => {
    const hub = getHermesHub()
    hub.setPermissionHandler((ev) => setPendingHermesPermission(ev))
    return () => hub.setPermissionHandler(null)
  }, [])

  // M2-T1/T2: 订阅 hub 的模型/模式清单缓存变更（建会话/恢复会话/选中回写/
  // 崩溃清空都会通知）→ bump tick 让选择窗重渲染。
  useEffect(() => {
    return getHermesHub().subscribe(() => setHermesStatesTick((t) => t + 1))
  }, [])

  // 面板点选后的回包：optionId = 批准选项；null = 拒绝/关闭。
  const answerHermesPermission = useCallback(
    (optionId: string | null) => {
      const ev = pendingHermesPermission
      setPendingHermesPermission(null)
      if (ev) getHermesHub().answerPermission(ev.requestId, optionId)
    },
    [pendingHermesPermission],
  )

  // Startup: resume the most recently updated conversation (if any).
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    const folder = plugin.settings.general.aiFolder
    void (async () => {
      // Whole restore wrapped: the Android-only auto-disable hunt showed
      // anything throwing AFTER the two inner try/catches becomes an
      // unhandled rejection Obsidian's loader can hold against the plugin.
      // A failed restore must stay invisible — the chat simply starts empty.
      try {
        let metas: ConversationMeta[]
        try {
          metas = await loadIndex(plugin.app, folder)
        } catch {
          return
        }
        setConvList(metas)
        if (metas.length === 0) return
        const latest = metas.reduce((a, b) =>
          b.updatedAt > a.updatedAt ? b : a,
        )
        let conv: StoredConversation | null = null
        try {
          conv = await loadConversation(plugin.app, folder, latest.id)
        } catch {
          return
        }
        if (!conv) return
        convRef.current = {
          id: conv.id,
          title: conv.title,
          parentId: conv.parentId,
          parentMessageCount: conv.parentMessageCount,
          createdAt: conv.createdAt,
          agentId: conv.agentId ?? null,
          hermesSessionId: conv.hermesSessionId ?? null,
          // 补刀·六十：分支后未发送即关 Obsidian，重启恢复不丢 fork 源。
          forkSourceHermesSessionId: conv.forkSourceHermesSessionId,
        }
        setConvId(conv.id)
        setConvTitle(conv.title)
        setConvAgentId(conv.agentId ?? null)
        setMessages(() => conv.messages)
        setThinking(conv.thinking)
        setModelOverride(conv.modelOverride)
        attachmentsRef.current = conv.attachments ?? []
        dirtyRef.current = false
      } catch (err) {
        console.error('[UNagent] boot restore failed:', err)
      }
    })()
  }, [plugin, setMessages])

  // 追加89: 数据文件夹改动即时生效——旧实现只在 boot 读一次 folder，
  // 设置页只好注明「改动在重新打开对话视图后生效」。现在设置一提交，
  // 对话管理列表立刻换成新文件夹的索引（当前对话的内存态保留；它下次
  // 落盘自然写进新文件夹，与 SettingTab 的 migrateDataFolder 迁移衔接）。
  const aiFolderRef = useRef(normalizeAiFolder(plugin.settings.general.aiFolder))
  useEffect(() => {
    return plugin.addSettingsChangeListener((settings) => {
      const next = normalizeAiFolder(settings.general.aiFolder)
      if (next === aiFolderRef.current) return
      aiFolderRef.current = next
      void loadIndex(plugin.app, next)
        .then((metas) => setConvList(metas))
        .catch(() => undefined)
    })
  }, [plugin])

  // 追加89: 技能 / 子代理注册表热重载是「原地换内容、引用不变」——依赖
  // 它们的 memo（下方 agents 列表）不会自己重算。订阅数据变更通知，用
  // tick 驱动重算（Composer 的技能列表、ReferenceText 同款）。
  const [dataTick, setDataTick] = useState(0)
  useEffect(
    () => plugin.addDataChangeListener(() => setDataTick((t) => t + 1)),
    [plugin],
  )

  /* ── conversation management ──────────────────────────────────────── */

  // Load another conversation (persisting the current one first).
  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      if (abortRef.current || id === convRef.current.id) return
      await persistNow()
      const folder = plugin.settings.general.aiFolder
      let conv: StoredConversation | null = null
      try {
        conv = await loadConversation(plugin.app, folder, id)
      } catch {
        conv = null
      }
      if (!conv) {
        // Stale index entry — drop it from the list.
        setConvList((prev) => prev.filter((e) => e.id !== id))
        return
      }
      convRef.current = {
        id: conv.id,
        title: conv.title,
        parentId: conv.parentId,
        parentMessageCount: conv.parentMessageCount,
        createdAt: conv.createdAt,
        agentId: conv.agentId ?? null,
        hermesSessionId: conv.hermesSessionId ?? null,
        // 补刀·六十：分支源标记透传（切回该对话后首轮仍能 fork 主干）。
        forkSourceHermesSessionId: conv.forkSourceHermesSessionId,
      }
      setConvId(conv.id)
      setConvTitle(conv.title)
      setConvAgentId(conv.agentId ?? null)
      setMessages(() => conv.messages)
      setThinking(conv.thinking)
      setModelOverride(conv.modelOverride)
      attachmentsRef.current = conv.attachments ?? []
      brainRef.current = null // other conversation → fresh memory snapshot
      setLastPromptTokens(undefined) // Task #8: 用量 chip 随会话重置
      dirtyRef.current = false
      // 打开 hermes 会话即后台预热连接+项目会话（幂等，失败静默）——
      // 用户在这条会话里发消息时无需再等 hermes 侧慢启动。
      const agentDef = conv.agentId
        ? plugin.agents.getByName(conv.agentId)
        : undefined
      if (conv.hermesSessionId || agentDef?.engine === 'hermes') warmupNow()
    },
    [persistNow, plugin, setMessages],
  )

  // Start a fresh conversation (persisting the current one first). Wired to
  // both the 清空 button and the /chats "新建对话" row. Optional agentId:
  // 模式切换（toggleHermesMode）首次进入某模式时传 HERMES_AGENT_NAME /
  // null 新建上下文——再次切换优先恢复历史会话，不再走这里（用户修订
  // 2026-08-07：切换不新开窗口）。
  const newConversation = useCallback(
    async (agentId: string | null = null): Promise<void> => {
      if (abortRef.current) return
      await persistNow()
      convRef.current = {
        ...freshIdentity(),
        agentId,
      }
      setConvId(null)
      setConvTitle('')
      setConvAgentId(agentId)
      setMessages(() => [])
      attachmentsRef.current = [] // fresh conversation owns no attachments yet
      brainRef.current = null // new conversation → fresh memory snapshot
      setLastPromptTokens(undefined) // Task #8: 用量 chip 随会话重置
      dirtyRef.current = false
    },
    [persistNow, setMessages, convAgentId],
  )

  // 主窗口内模式切换（补刀·五十七）：Hermes ⇄ 主 agent 一键切换。
  // 用户修订（2026-08-07）：不再每次点击都新建会话——切到目标模式时优先
  // 恢复该模式最近一次会话（convList 最近更新在前，首个匹配即最新），没
  // 有历史才新建；与 openAgentConversation 的子代理恢复、backFromAgent 的
  // 入口恢复同款语义，来回切换始终落在同一批窗口上。isHermes 判定与按钮
  // 高亮（hermesPath）一致：内置 Hermes 代理 / 任意 engine:hermes 子代理 /
  // /hermes 任务分发绑定（hermesSessionId）都算 Hermes 模式 → 点击回主
  // agent；否则 → 切到 Hermes。
  const toggleHermesMode = useCallback((): void => {
    if (abortRef.current) return
    const cur = convList.find((m) => m.id === convId)
    const agentId = (cur ? cur.agentId : convAgentId) ?? null
    const def = agentId ? plugin.agents.getByName(agentId) : undefined
    const hermesSessionId = cur
      ? cur.hermesSessionId
      : convRef.current.hermesSessionId
    const isHermes =
      agentId === HERMES_AGENT_NAME ||
      def?.engine === 'hermes' ||
      hermesSessionId != null
    if (isHermes) {
      // Hermes → 主 agent：优先恢复进入前的入口会话；入口缺失（如重启后
      // 直接处于 Hermes 模式）回落主 agent 最近会话，最后才新建。
      const entry = entryConvRef.current
      entryConvRef.current = null
      if (entry?.id) {
        void openConversation(entry.id)
      } else {
        const main = convList.find((m) => !m.agentId && !m.hermesSessionId)
        if (main) void openConversation(main.id)
        else void newConversation()
      }
    } else {
      // 主 agent → Hermes：先记录入口（切回时恢复），再恢复最近 Hermes
      // 会话；没有历史才新建（不再每次点击都开新窗口）。
      // 切换即后台预热（幂等）——用户键入第一条消息时连接已就绪。
      warmupNow()
      entryConvRef.current = { id: convRef.current.id }
      const target = convList.find((m) => m.agentId === HERMES_AGENT_NAME)
      if (target) {
        void openConversation(target.id)
      } else {
        void newConversation(HERMES_AGENT_NAME)
      }
    }
  }, [
    newConversation,
    convList,
    convId,
    convAgentId,
    plugin.agents,
    openConversation,
  ])

  // Enter a sub-agent (多 Agent 体系, /agent picker): resume that agent's
  // most recent conversation if one exists, otherwise start a fresh
  // conversation tagged with the agent (initial title = agent name). The
  // persona itself is frozen into brainRef on the first send — same
  // snapshot discipline as the three brain files.
  const openAgentConversation = useCallback(
    async (agentName: string): Promise<void> => {
      if (abortRef.current) return
      const name = agentName.trim()
      if (!name) return
      await persistNow()
      // Remember where we came from so the 返回 button can restore it
      // (追加44).
      entryConvRef.current = { id: convRef.current.id }
      // convList is kept most-recently-updated first → first match wins.
      const target = convList.find((m) => m.agentId === name)
      if (target) {
        await openConversation(target.id)
        return
      }
      convRef.current = { ...freshIdentity(), agentId: name, title: name }
      setConvId(null)
      setConvTitle(name)
      setConvAgentId(name)
      setMessages(() => [])
      attachmentsRef.current = []
      brainRef.current = null // new conversation → fresh persona snapshot
      setLastPromptTokens(undefined) // Task #8: 用量 chip 随会话重置
      dirtyRef.current = false
    },
    [persistNow, openConversation, convList, setMessages],
  )

  // Create a CHILD conversation inheriting the full current context (the
  // multi-level branch). The parent stays as-is; the child continues from
  // the same messages under a new identity with parentId set. The child
  // inherits the parent's title by default (no naming prompt — 用户指示).
  // Returns the child title; 'empty' when there is nothing to branch; null
  // when a run is active.
  const branchChild = useCallback(async (): Promise<string | 'empty' | null> => {
    const contextMessages = messagesRef.current.filter((m) => !m.ephemeral)
    if (contextMessages.length === 0) return 'empty'
    if (abortRef.current) return null
    const ident = convRef.current
    await persistNow() // make sure the parent file + index exist first
    convRef.current = {
      id: makeConversationId(),
      title: ident.title || '新对话',
      parentId: ident.id,
      parentMessageCount: contextMessages.length,
      createdAt: Date.now(),
      agentId: ident.agentId,
      // 补刀·六十：hermes 对话分支 = 首轮经 session/fork 从主干会话建真分支
      // （保留主干完整上下文，hermes 桌面端呈分支关系而非并列空会话）；
      // 非 hermes 对话（无绑定会话）保持旧语义新建。
      hermesSessionId: null,
      ...(ident.hermesSessionId
        ? { forkSourceHermesSessionId: ident.hermesSessionId }
        : {}),
    }
    setConvId(convRef.current.id)
    setConvTitle(convRef.current.title)
    setConvAgentId(ident.agentId)
    attachmentsRef.current = [] // a branch starts owning no attachments
    brainRef.current = null // new conversation object → fresh snapshot
    setLastPromptTokens(undefined) // Task #8: 用量 chip 随会话重置
    dirtyRef.current = true
    // 追加89: 分支立即出现在对话管理列表 + 立即落盘。旧实现把这两件事都
    // 押在 debounced autosave 上，而 autosave 只在 messages 变化后触发——
    // branchChild 不改 messages，所以分支在用户下一次发消息前既不上列表
    // 也不落盘（此刻关掉 Obsidian 分支直接丢失）。乐观插入 meta 让列表
    // 零延迟可见；紧随的 persistNow 把子对话写实（失败则 dirty 保持，
    // 下一次 autosave 重试，乐观条目由 openConversation 的 stale 兜底清理）。
    const childId = convRef.current.id as string
    upsertConvMeta({
      id: childId,
      title: convRef.current.title,
      createdAt: convRef.current.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      parentId: convRef.current.parentId,
      parentMessageCount: convRef.current.parentMessageCount,
      messageCount: contextMessages.length,
      ...(ident.agentId ? { agentId: ident.agentId } : {}),
    })
    void persistNow()
    return convRef.current.title
  }, [persistNow, plugin, upsertConvMeta])

  // Branch from ANY saved conversation (the management-page action): load the
  // source, then open a new conversation inheriting the source's full message
  // context as its child (the previously current conversation is persisted
  // first). Same tri-state return as branchChild.
  const branchFrom = useCallback(
    async (id: string): Promise<string | 'empty' | null> => {
      if (abortRef.current) return null
      const folder = plugin.settings.general.aiFolder
      let src: StoredConversation | null = null
      try {
        src = await loadConversation(plugin.app, folder, id)
      } catch {
        src = null
      }
      if (!src) {
        // Stale index entry — drop it from the list.
        setConvList((prev) => prev.filter((e) => e.id !== id))
        return 'empty'
      }
      if (src.messages.length === 0) return 'empty'
      await persistNow() // make sure the previous current file exists first
      const srcConv = src // (narrowed non-null for the closure below)
      convRef.current = {
        id: makeConversationId(),
        title: srcConv.title,
        parentId: srcConv.id,
        parentMessageCount: srcConv.messages.length,
        createdAt: Date.now(),
        agentId: srcConv.agentId ?? null,
        // 补刀·六十：同 branchChild——hermes 对话分支记录主干会话，首轮
        // session/fork 建真分支（保留主干上下文）；非 hermes 对话保持旧语义。
        hermesSessionId: null,
        ...(srcConv.hermesSessionId
          ? { forkSourceHermesSessionId: srcConv.hermesSessionId }
          : {}),
      }
      setConvId(convRef.current.id)
      setConvTitle(convRef.current.title)
      setConvAgentId(srcConv.agentId ?? null)
      setMessages(() => srcConv.messages)
      setThinking(srcConv.thinking)
      setModelOverride(srcConv.modelOverride)
      attachmentsRef.current = [] // a branch starts owning no attachments
      brainRef.current = null // new conversation object → fresh snapshot
      setLastPromptTokens(undefined) // Task #8: 用量 chip 随会话重置
      dirtyRef.current = true
      // 追加89: 同 branchChild——乐观插入 meta + 立即落盘。旧实现靠
      // setMessages 触发的 debounced autosave（600ms + 磁盘往返）才上列表，
      // 用户体感就是「分支后要等一会儿才在对话管理里出现」。
      const childId = convRef.current.id as string
      upsertConvMeta({
        id: childId,
        title: convRef.current.title,
        createdAt: convRef.current.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        parentId: convRef.current.parentId,
        parentMessageCount: convRef.current.parentMessageCount,
        messageCount: srcConv.messages.length,
        ...(convRef.current.agentId ? { agentId: convRef.current.agentId } : {}),
      })
      void persistNow()
      return convRef.current.title
    },
    [persistNow, plugin, setMessages, upsertConvMeta],
  )

  // Rename a saved conversation (the management-page action). The currently
  // open one renames in place (the next autosave writes the file + index);
  // any other conversation is patched on disk directly.
  const renameConversation = useCallback(
    async (id: string, name: string): Promise<void> => {
      const trimmed = name.trim()
      if (!trimmed) return
      setConvList((prev) =>
        prev.map((e) => (e.id === id ? { ...e, title: trimmed } : e)),
      )
      if (convRef.current.id === id) {
        convRef.current.title = trimmed
        setConvTitle(trimmed)
        dirtyRef.current = true // autosave persists the new title
        return
      }
      const folder = plugin.settings.general.aiFolder
      try {
        const conv = await loadConversation(plugin.app, folder, id)
        if (!conv) return
        // saveConversation rewrites the file AND upserts the index meta.
        await saveConversation(plugin.app, folder, {
          ...conv,
          title: trimmed,
          updatedAt: Date.now(),
        })
      } catch {
        // Storage hiccup — the list already shows the new name; the next
        // successful save of this conversation persists it.
      }
    },
    [plugin],
  )

  // Permanently delete a saved conversation (the management-page action). If
  // it is the one currently open, the screen resets to a fresh conversation.
  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      if (abortRef.current) return
      const wasCurrent = convRef.current.id === id
      // Drop the dirty flag FIRST when deleting the open conversation, so a
      // pending debounced autosave can never resurrect the deleted file
      // (persistNow bails on an empty message list anyway once we clear it).
      if (wasCurrent) dirtyRef.current = false
      const folder = plugin.settings.general.aiFolder
      try {
        await deleteStoredConversation(plugin.app, folder, id)
      } catch {
        return
      }
      setConvList((prev) => prev.filter((e) => e.id !== id))
      if (wasCurrent) {
        convRef.current = freshIdentity()
        setConvId(null)
        setConvTitle('')
        setConvAgentId(null)
        setMessages(() => [])
        attachmentsRef.current = []
        brainRef.current = null
        setLastPromptTokens(undefined) // Task #8: 用量 chip 随会话重置
      }
    },
    [plugin, setMessages],
  )

  // Truncate the conversation to before the user message at `index` (a turn
  // boundary — structurally safe). Appends a note recording the rewind.
  // 追加62: 若该轮及之后 AI 修改过笔记（undo 栈里有本会话对应轮次的条目），
  // 弹三选询问：一并回滚修改 / 仅回溯对话记录 / 取消。
  const rewindTo = useCallback(
    async (index: number): Promise<string> => {
      if (abortRef.current) return '生成中，请先停止再回溯。'
      const msgs = messagesRef.current
      if (index <= 0 || index >= msgs.length || msgs[index].role !== 'user') {
        return '没有可回溯的位置。'
      }
      const turnPts = turnPoints(msgs)
      const turnPt = turnPts.find((p) => p.index === index)
      const turn = turnPt?.turn ?? 0
      // 追加70: 回溯到第 N 轮 = 该轮保留（提问 + 回答），只移除它之后的
      // 轮次（“回溯到 b，把 c 及其后面的移除，但 b 保留”）。截断点取
      // 下一轮起点（该轮最后一条消息之后），无下一轮则无可移除。
      const nextTurn = turnPts.find((p) => p.index > index)
      const cut = nextTurn?.index ?? msgs.length
      if (cut >= msgs.length) {
        return `第 ${turn} 轮已是最后一轮，后面没有内容可移除。`
      }
      const turnCut = nextTurn?.turn ?? turnPts.length + 1
      const convKey = convIdRef.current ?? ''
      const affected = plugin.undoStack.countFor(convKey, turnCut)
      let rolledBack = 0
      if (affected > 0) {
        const choice = await askRewindRollback(plugin.app, affected)
        if (choice === 'cancel') return ''
        if (choice === 'rollback') {
          rolledBack = await plugin.undoStack.rollbackFrom(convKey, turnCut)
        }
      }
      // 追加66: 回溯的“条数”按轮计（一轮 = 一条用户消息 + 它的 AI 回答，
      // ephemeral 临时问答不计），比数原始消息条数更符合直觉。
      const removed = turnPts.filter((p) => p.index >= cut).length
      const detail =
        rolledBack > 0
          ? `，回滚了 ${rolledBack} 处 AI 修改`
          : affected > 0
            ? '，保留 AI 修改'
            : ''
      const next = [
        ...msgs.slice(0, cut),
        noteMsg(`已回溯到第 ${turn} 轮（移除了 ${removed} 轮对话${detail}）。`),
      ]
      setMessages(() => next)
      // 追加77: 先置 dirty 再落盘——persistNow 写失败时靠「保持 dirty →
      // autosave 重试」兜底，但回溯发生在干净状态（上一轮已落盘）时 dirty
      // 本是 false，不补这一笔，截断结果就永远不会重试落盘，重启/切换
      // 会话后旧轮次从磁盘复活，浮动导航重新显示已被移除的轮次。
      dirtyRef.current = true
      // 评审修复：回溯后上下文已经变小，lastPromptTokens 留着截断前的陈旧
      // 偏大值会让用量 chip 误报、nearLimit 误触发——与其他会话重置点对齐清空。
      // （editUserMessage / regenerate 不在此列：它们不截断上下文，且紧接着
      // 重发一轮，done 事件会立刻用真实 usage 刷新该值。）
      setLastPromptTokens(undefined)
      await persistNow(next)
      return ''
    },
    [persistNow, setMessages, plugin],
  )

  // Compress the live context into a lossless summary ('/compact [策略]'):
  // ONE-SHOT LLM call (no tools — compression talks, doesn't mutate), then
  // the message list is REPLACED by [command echo, summary]. Same destructive
  // but saved philosophy as /rewind: the old turns leave the live context but
  // survive in the persisted history / branches. Durable takeaways ride along
  // into memory.md through the same store save_memory uses — the memory
  // linkage. Frozen-snapshot convention holds: memoryRef is untouched, so new
  // entries take effect next conversation, not mid-this-one. A failure never
  // truncates — the placeholder bubble just reports it.
  const compactContext = useCallback(
    async (rawText: string, strategy: string, llm: LLMSettings) => {
      if (abortRef.current) return
      const real = messagesRef.current.filter((m) => !m.ephemeral)
      const userMsg: UiMessage = { id: genId(), role: 'user', content: rawText }
      if (real.length < MIN_COMPACT_MESSAGES) {
        dirtyRef.current = true
        setMessages((prev) => [
          ...prev,
          userMsg,
          noteMsg(
            '对话还太短，没必要压缩。聊长一些后再发 /compact（后面可附压缩策略，如：/compact 只保留决策与结论）。',
          ),
        ])
        return
      }
      const summaryId = genId()
      dirtyRef.current = true
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: summaryId,
          role: 'assistant',
          blocks: [{ kind: 'text', text: '正在压缩上下文…' }],
          isStreaming: true,
        },
      ])
      setIsStreaming(true)
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const provider = createLLMProvider(
          resolveSessionModel(llm, modelOverride),
        )
        let raw = ''
        for await (const chunk of provider.streamChat(
          [
            { role: 'system', content: buildCompactPrompt(strategy) },
            { role: 'user', content: buildCompactTranscript(real) },
          ],
          undefined,
          { signal: controller.signal },
        )) {
          if (chunk.type === 'text') raw += chunk.text
        }
        const { summary, memories } = parseCompactResult(raw)
        if (!summary) {
          throw new Error('模型没有返回可用的压缩摘要')
        }
        // Memory linkage: write the distilled entries (dedupe + size caps are
        // enforced inside the store); count only the ones actually added.
        let saved = 0
        for (const mem of memories.slice(0, MAX_COMPACT_MEMORIES)) {
          try {
            const res = await addMemoryEntry(
              plugin.app,
              mem,
              plugin.settings.general.aiFolder,
            )
            if (res.ok && !res.duplicate) saved += 1
          } catch {
            // One bad entry never blocks the compaction itself.
          }
        }
        const next: UiMessage[] = [
          userMsg,
          {
            id: summaryId,
            role: 'assistant',
            blocks: [
              {
                kind: 'text',
                text: compactionMessageText(summary, saved, strategy),
              },
            ],
            command: 'compact',
          },
        ]
        setMessages(() => next)
        // 追加77: 同 rewindTo——压缩替换整个列表，写盘失败时必须让
        // autosave 重试，否则旧列表从磁盘复活。
        dirtyRef.current = true
        await persistNow(next)
      } catch (err) {
        const aborted =
          (err instanceof LLMError && err.code === 'aborted') ||
          (err instanceof Error && err.name === 'AbortError')
        setMessages((prev) =>
          prev.map((m) =>
            m.id === summaryId
              ? {
                  ...m,
                  isStreaming: false,
                  blocks: [
                    {
                      kind: 'text',
                      text: aborted
                        ? '已停止压缩（原对话未受影响）。'
                        : `上下文压缩失败：${friendlyMessage(err)}。原对话未受影响，可重新发送 /compact 再试。`,
                    },
                  ],
                }
              : m,
          ),
        )
      } finally {
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [plugin, modelOverride, persistNow, setMessages],
  )

  /* ── the agent turn ───────────────────────────────────────────────── */

  // 进化 B 案（AI 反思建议）：实质轮结束后节流触发的静默复盘——一次性模型
  // 调用（无工具、用当前会话模型），产出的建议进 pendingSuggestions 确认
  // 队列。B 案契约：绝不自动写盘；全程静默失败（反思不能干扰主对话）。
  const maybeReflect = useCallback(
    async (input: {
      turnNo: number
      command?: string
      ephemeral?: boolean
      noTools?: boolean
      failed?: boolean
      llm: LLMSettings
    }): Promise<void> => {
      try {
        const gate = reflectGateRef.current
        const convKey = convIdRef.current ?? ''
        if (gate.convId !== convKey) {
          gate.convId = convKey
          gate.lastTurn = 0
        }
        if (
          !shouldReflect({
            enabled: plugin.settings.general.reflectSuggestions,
            turnNo: input.turnNo,
            lastReflectTurn: gate.lastTurn,
            ephemeral: input.ephemeral,
            noTools: input.noTools,
            command: input.command,
            failed: input.failed,
          })
        ) {
          return
        }
        // Claim the slot BEFORE the call: a failed pass still waits out the
        // gap, so a broken endpoint can't fire a reflection on every turn.
        gate.lastTurn = input.turnNo

        const transcript = buildReflectTranscript(messagesRef.current)
        if (!transcript) return
        const prompt = buildReflectPrompt(
          transcript,
          plugin.settings.skills.enabled,
        )

        reflectAbortRef.current?.abort()
        const controller = new AbortController()
        reflectAbortRef.current = controller

        const resolved = resolveSessionModel(input.llm, modelOverride)
        const provider = createLLMProvider(resolved)
        let raw = ''
        for await (const chunk of provider.streamChat(
          [{ role: 'user', content: prompt }],
          undefined,
          { signal: controller.signal },
        )) {
          if (chunk.type === 'text') raw += chunk.text
        }
        if (controller.signal.aborted) return
        const suggestions = parseReflectResult(raw)
        if (suggestions.length === 0) return
        dlog(
          'info',
          'reflect',
          `proposed ${suggestions.length} suggestion(s): ${suggestions
            .map((s) => s.type)
            .join(', ')}`,
        )
        // A newer pass replaces unconfirmed leftovers (fresh context wins —
        // the panel is a suggestion surface, not a queue to hoard).
        setPendingSuggestions(suggestions)
      } catch {
        // 静默是设计（B 案契约）：反思失败对用户完全不可见。
      }
    },
    [plugin, modelOverride],
  )

  // Core runner shared by send() and retry(). `historyBase` is the list of
  // prior turns (the current user text is appended separately); `mount`
  // inserts the new assistant message into state (send appends user+assistant,
  // retry replaces the failed assistant message).
  //
  // opts.ephemeral = a /btw aside exchange: the Q&A is displayed but never
  // enters the conversation (no dirty flag → no persist; callers also keep it
  // out of the history they pass in). opts.noTools = pure chat: no tool
  // schemas offered, nothing executable — a side question should talk, not
  // mutate the vault.
  const runCore = useCallback(
    async (
      text: string,
      llm: LLMSettings,
      historyBase: UiMessage[],
      mount: (assistantMsg: UiMessage) => void,
      opts: { ephemeral?: boolean; noTools?: boolean; command?: string; turnNo?: number } = {},
    ) => {
      // 评审修复：会话 id 原本在 persistNow 首次落盘时才生成——新对话第 1
      // 轮工具执行时 convIdRef 仍是 null，pushUndo 落不到会话戳，回溯的
      // countFor/rollbackFrom（按 convId 精确比较）永远匹配不到，第 1 轮
      // 的 AI 修改回溯时不回滚。把分配提前到工具执行之前；persistNow 处
      // 「已有 id 则复用」天然兼容。ephemeral /btw 不落盘，绝不替它建 id。
      if (!opts.ephemeral && !convRef.current.id) {
        const id = makeConversationId()
        convRef.current.id = id
        // state 更新要等渲染才镜像到 convIdRef（line ~220），工具闭包等不
        // 起——这里直接同步 ref，保证本轮 pushUndo 立刻读到。
        convIdRef.current = id
        setConvId(id)
      }
      // Streaming coalescing (移动端): model tokens can arrive far faster
      // than WKWebView can repaint, and every setMessages re-renders the
      // whole chat (re-parsing every markdown block). Unthrottled, a long
      // answer drives sustained CPU/GC pressure that iOS eventually resolves
      // by killing the webview process — the plugin "turns itself off".
      // Text chunks coalesce to ONE state patch per animation frame;
      // non-text events flush first so block order always follows stream
      // order. Declared BEFORE the try (try-scoped let/const are invisible
      // to its catch) so every error path can drain a partial batch safely.
      const patchAssistant = (fn: (blocks: UiBlock[]) => UiBlock[]) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, blocks: fn(m.blocks ?? []) } : m,
          ),
        )
      }
      let pendingPatch: ((blocks: UiBlock[]) => UiBlock[]) | null = null
      let patchRaf = 0
      const flushPatches = () => {
        if (patchRaf !== 0) {
          cancelAnimationFrame(patchRaf)
          patchRaf = 0
        }
        if (pendingPatch) {
          const fn = pendingPatch
          pendingPatch = null
          patchAssistant(fn)
        }
      }
      const queuePatch = (fn: (blocks: UiBlock[]) => UiBlock[]) => {
        // Capture a SNAPSHOT of the previous patch, never the mutable
        // pendingPatch binding: the combined closure runs during React's
        // render phase, AFTER flushPatches() has set pendingPatch = null.
        // Reading the variable then would call null(blocks) →
        // "X is not a function" → React render crash (agent-host subtree).
        const prev = pendingPatch
        pendingPatch = prev ? (blocks) => fn(prev(blocks)) : fn
        if (patchRaf === 0) {
          patchRaf = requestAnimationFrame(() => {
            patchRaf = 0
            if (pendingPatch) {
              const fn2 = pendingPatch
              pendingPatch = null
              patchAssistant(fn2)
            }
          })
        }
      }
      const assistantId = genId()
      // 进化 B 案：handle 的 'error' 事件置真——出错的轮不触发复盘。
      let turnErrored = false

      // The outer try guards the PREPARATION phase too: the brain-file load
      // and image reads below are awaits that run BEFORE the stream's own
      // try. Any throw here must surface as a visible error bubble, never as
      // a rejected send() promise — an unhandled rejection that Obsidian's
      // own listeners still see (preventDefault only stops the default
      // action), and it disables the plugin (the mobile "keeps turning
      // itself off" bug).
      try {
      const assistantMsg: UiMessage = {
        id: assistantId,
        role: 'assistant',
        blocks: [],
        isStreaming: true,
        ...(opts.ephemeral ? { ephemeral: true } : {}),
        ...(opts.command ? { command: opts.command } : {}),
      }

      // Build the LLM history: system prompt + prior turns (text only) + the
      // new user message. Tool-call structure lives only within one send.
      const registry = plugin.registry
      // This run's agent identity for settings lookups: sub-agent name or the
      // main agent key (conversation without an agentId).
      const agentKey = convRef.current.agentId ?? MAIN_AGENT_KEY
      // This run's tool set: 通用启用池 ∩ this agent's own selection (the
      // main agent defaults to the full pool; per-agent overrides live in
      // settings.agents.perAgent). Snapshot now like the skill view below.
      // 追加87: MCP 工具再叠一层服务级开关——该 agent 关掉的服务
      // （perAgent.disabledMcp），其全部工具一并移除。
      const runTools = registry.getAll().filter((t) => {
        if (!isToolEnabledForAgent(plugin.settings.agents, agentKey, t.metadata.name)) {
          return false
        }
        const svcId = t.metadata.mcpServiceId
        return (
          svcId == null ||
          isMcpEnabledForAgent(plugin.settings.agents, agentKey, svcId)
        )
      })

      // This run's skill view: honor the master toggle and the per-skill
      // disabled list from settings. Snapshot now so mid-run settings edits
      // don't leak into an in-flight agent loop.
      const disabledSkills = plugin.settings.skills.disabled
      const runSkills = new SkillRegistry()
      if (plugin.settings.skills.enabled) {
        runSkills.registerAll(
          plugin.skills
            .getAll()
            .filter(
              (s) =>
                !disabledSkills.includes(s.metadata.name) &&
                isSkillEnabledForAgent(
                  plugin.settings.agents,
                  agentKey,
                  s.metadata.name,
                ),
            ),
        )
      }

      // A leading "//skill-name" force-loads that skill for this turn: its
      // body is inlined into the system prompt as an 'always' skill, so the
      // model follows the guide directly — no load_skill round trip. The
      // "//name" prefix is stripped from what the model sees as user text.
      // Unknown names are ignored (the text passes through untouched).
      //
      // "/learn <request>" also routes through here: its text is replaced by
      // the learn prompt and skill-creator is force-loaded, so crystallizing
      // a skill follows the official guide. Retry replays the stored user
      // text, so the same rewrite happens again automatically.
      let skillList = runSkills.getAll()
      let userContent = text
      const directive = parseDirective(text)
      let forcedName: string | undefined
      if (
        directive?.kind === 'command' &&
        directive.name === 'learn' &&
        directive.arg
      ) {
        userContent = buildLearnPrompt(
          directive.arg,
          skillsFolder(plugin.settings.general.aiFolder),
        )
        forcedName = 'skill-creator'
      } else if (directive?.kind === 'skill') {
        forcedName = directive.name
      }
      if (forcedName) {
        const forced = runSkills.getByName(forcedName)
        if (forced) {
          skillList = skillList.map((s) =>
            s.metadata.name === forced.metadata.name
              ? { ...s, metadata: { ...s.metadata, mode: 'always' as const } }
              : s,
          )
          if (directive?.kind === 'skill') {
            userContent =
              directive.body || `请载入并遵循「${directive.name}」技能的指南来帮我。`
          }
        }
      }

      // Evolution files: frozen-snapshot pattern — the three brain files are
      // loaded once per conversation (first send) and reused by every turn
      // and retry. save_memory / edit_note writes during the session update
      // the files, not these snapshots (they take effect next conversation).
      if (brainRef.current === null) {
        const folder = plugin.settings.general.aiFolder
        // Sub-agent persona (多 Agent 体系): frozen with the brain files.
        // Honors the master toggle + per-agent disabled list, same as skills.
        let agentPersona = ''
        const convAgent = convRef.current.agentId
        if (
          convAgent &&
          plugin.settings.agents.enabled &&
          !plugin.settings.agents.disabled.includes(convAgent)
        ) {
          agentPersona = plugin.agents.getByName(convAgent)?.body ?? ''
        }
        brainRef.current = {
          memory: (await loadMemorySnapshot(plugin.app, folder, 'memory')) ?? [],
          user: (await loadMemorySnapshot(plugin.app, folder, 'user')) ?? [],
          agent:
            ((await readText(plugin.app, agentDocPath(folder))) ?? '').trim(),
          agentPersona,
        }
      }

      // Vision routing (补刀·五十三): if the user's message contains image
      // embeds (![[…]]), read each as a data URL and route to a vision-capable
      // model. The configured default vision model wins if it's actually
      // vision-capable; else the first vision model across all vendors; else
      // null (falls back to the current model — the model just won't see the
      // image bytes, though the wiki-link text still references it).
      const imagePaths = extractImageEmbedPaths(text)
      // Model chain (多 Agent 体系): session /model override > the agent's
      // frontmatter model > global default (vision routing may still swap in
      // a vision model below).
      let effectiveOverride =
        modelOverride ??
        (convRef.current.agentId
          ? plugin.agents.getByName(convRef.current.agentId)?.modelOverride ??
            null
          : null)
      let imageDataUrls: string[] = []
      if (imagePaths.length > 0) {
        for (const p of imagePaths.slice(0, MAX_IMAGE_COUNT)) {
          const url = await readImageAsDataUrl(plugin.app, p, MAX_IMAGE_BYTES)
          if (url) imageDataUrls.push(url)
        }
        // Only route to a vision model when at least one image actually
        // made it through — a fully-skipped batch must not switch models.
        if (imageDataUrls.length > 0) {
          const visionId = resolveVisionModel(llm)
          if (visionId) effectiveOverride = visionId
        }
        const skipped = imagePaths.length - imageDataUrls.length
        if (skipped > 0) {
          new Notice(
            `${skipped} 张图片过大（单张上限 ${Math.floor(
              MAX_IMAGE_BYTES / 1024 / 1024,
            )}MB，最多 ${MAX_IMAGE_COUNT} 张），未随消息发送。`,
          )
        }
      }

      // @引用内联（Task #8）：把消息里的 [[笔记]] 引用按设置展开成正文，
      // 附在发给 LLM 的当前 user 消息末尾（【引用笔记内容】段）。只装饰
      // 送给模型的那一份——持久化消息的 content 保持原样（autosave 不放大）。
      // 已作为图片发送的 embed 引用跳过；任何读取失败静默降级（buildRefContext
      // 内部已容错，这里再兜一层 try/catch 保证发送路径不被打断）。
      let llmUserContent = userContent
      try {
        const mentionInline = plugin.settings.general.mentionInline
        if (mentionInline && mentionInline !== 'link') {
          const stripExt = (p: string): string => p.replace(/\.[^./]+$/, '')
          const coveredByImage = (ref: string): boolean =>
            imagePaths.some(
              (p) =>
                p === ref ||
                stripExt(p) === ref ||
                p.endsWith(`/${ref}`) ||
                stripExt(p).endsWith(`/${ref}`),
            )
          const refs = extractNoteRefs(userContent).filter(
            (r) => !coveredByImage(r),
          )
          if (refs.length > 0) {
            const ctxStr = await buildRefContext(plugin.app, refs, mentionInline)
            if (ctxStr) {
              llmUserContent = `${userContent}\n\n【引用笔记内容】\n${ctxStr}`
            }
          }
        }
      } catch {
        // 静默降级：引用展开失败不阻断发送。
      }

      const history: ChatMessage[] = [
        {
          role: 'system',
          content: opts.noTools
            ? // Aside question: plain conversational context, no tools/skills.
              buildSystemPrompt([], [], {
                memory: brainRef.current.memory,
                user: brainRef.current.user,
                agentDoc: brainRef.current.agent,
                agentPersona: brainRef.current.agentPersona,
                aiFolder: normalizeAiFolder(plugin.settings.general.aiFolder),
                agentsFolder: agentsFolder(plugin.settings.general.aiFolder),
              })
            : buildSystemPrompt(runTools, skillList, {
                userSkillFolder: plugin.settings.skills.enabled
                  ? skillsFolder(plugin.settings.general.aiFolder)
                  : undefined,
                memory: brainRef.current.memory,
                user: brainRef.current.user,
                agentDoc: brainRef.current.agent,
                agentPersona: brainRef.current.agentPersona,
                aiFolder: normalizeAiFolder(plugin.settings.general.aiFolder),
                agentsFolder: agentsFolder(plugin.settings.general.aiFolder),
              }),
        },
        ...historyBase.map((m): ChatMessage => ({
          role: m.role,
          content:
            m.role === 'user'
              ? (m.content ?? '')
              : historyTextOfBlocks(activeOf(m).blocks),
        })),
        {
          role: 'user',
          content: llmUserContent,
          ...(imageDataUrls.length > 0 ? { images: imageDataUrls } : {}),
        },
      ]

      mount(assistantMsg)
      if (!opts.ephemeral) dirtyRef.current = true
      setIsStreaming(true)
      // 停止按钮接线：controller 先挂（isStreaming 置位后、任何 await 前）——
      // 停止按钮渲染后任意时刻点击都有效。此前 hermes 分支在
      // expandHermesRefs（@引用展开，读文件可能较慢）之后才赋值，展开挂起
      // 中的「停止」会静默丢失（abort() 里 abortRef.current?.abort() 空转），
      // 随后 prompt 照发。
      const controller = new AbortController()
      abortRef.current = controller

      // 补刀·五十六：整轮委托本机 hermes——**交互式 ACP 会话**（hermes acp，
      // stdio JSON-RPC），完全不碰 LLM 路径。两个入口：① 当前对话属于
      // engine: hermes 的代理（每一轮都走 hermes，hermes 自己记住会话，
      // 跨 Obsidian 重启可恢复）；② /hermes 命令（ephemeral 同 /btw）。
      // 流式文本 / 思考 / 工具卡片 / 计划清单实时映射到消息块；权限请求弹
      // 审批面板（HermesApprovalPanel）。同意契约：用户键入并发送即该轮的
      // 显式同意；具体操作的放行由审批模式（设置 → Hermes）控制。
      const convAgentDef = convRef.current.agentId
        ? plugin.agents.getByName(convRef.current.agentId)
        : undefined
      const isHermesTurn =
        opts.command === 'hermes' || convAgentDef?.engine === 'hermes'
      if (isHermesTurn) {
        // 展开 @file:/@folder: 引用——hermes 的 ACP prompt 只处理 `/` 命令，
        // 不会展开 @ 引用，需插件侧把内容注入 prompt（参考 claudian 附加文件）。
        try {
          userContent = await expandHermesRefs(userContent, plugin.app)
        } catch {
          /* 展开失败不阻断发送 */
        }
        const failText = (text: string): void => {
          patchAssistant(() => [{ kind: 'text', text }])
        }
        try {
          if (Platform.isMobile) {
            failText('Hermes 会话仅桌面端可用（移动端不支持）。')
          } else if (!plugin.settings.localAgent?.enabled) {
            failText('Hermes 集成未启用（设置 → Hermes）。')
          } else if (!(plugin.app.vault.adapter instanceof FileSystemAdapter)) {
            failText('无法取得 vault 的本地路径（非文件系统 vault）。')
          } else {
            const cfg = plugin.settings.localAgent
            const hubConfig = {
              command: cfg.command.trim() || DEFAULT_HERMES_COMMAND,
              cwd: (plugin.app.vault.adapter as FileSystemAdapter).getBasePath(),
            }
            // 显式项目层自动同步：后台确保 Hermes 侧存在当前仓库项目（桌面
            // 端项目区按显式项目分组——没有它，对话只会落在父目录项目如家
            // 目录 main 的仓库节点下，项目区看不到仓库名）。fire-and-forget
            // + 生命周期内去重，不阻塞对话轮；失败只记诊断日志（可 /hermes-init
            // 手动重试）。
            void ensureHermesProjectOnce({
              command: hubConfig.command,
              vaultRoot: hubConfig.cwd,
            })
            // 任务二：hermes 轮编排整体下沉 runHermesTurn（core/hermes）——
            // 会话解析（load→失败降级 new）/ 每轮幂等 set_mode/set_model
            // （set_mode 失败显式 Notice）/ 墙钟超时 cancel→8s dispose /
            // abort→session/cancel / 首轮人设+记忆快照+窗口实录包裹 / 轮末
            // 思考 flush / T3 凭据指引全在里面。这里只接线：块渲染（onBlocks
            // 快照已过 rAF 合并交付，再过一层 queuePatch 与 core 路径同款，
            // 轮末 flushPatches 冲刷残留）、会话绑定持久化与 UI 状态。
            await runHermesTurn({
              hub: getHermesHub(),
              hubConfig,
              cfg: {
                approvalMode: cfg.approvalMode,
                model: cfg.model,
                timeoutMs: cfg.timeoutMs,
                guidedEndpoint: cfg.guidedEndpoint ?? '',
              },
              sessionId: convRef.current.hermesSessionId,
              // 补刀·六十：分支对话首轮从主干会话 fork（hermes 侧真分支，
              // 保留主干上下文）；非分支对话为 null 走旧路径。
              forkSourceSessionId:
                convRef.current.forkSourceHermesSessionId ?? null,
              projectSessionId: plugin.settings.localAgent.projectSessionId || null,
              getOverrides: (sid) => hermesOverridesRef.current.get(sid) ?? {},
              userContent,
              historyWindow: historyBase,
              persona: convAgentDef?.body,
              memory: brainRef.current
                ? {
                    user: brainRef.current.user,
                    memory: brainRef.current.memory,
                  }
                : null,
              agentLabel: convAgentDef?.name,
              modeLabel: (id) => HERMES_MODE_LABEL[id as HermesModeId] ?? id,
              abortSignal: controller.signal,
              onBlocks: (blocks) => queuePatch(() => blocks),
              onSessionBound: (sid) => {
                // /hermes 任务分发与 engine:hermes 都绑定会话到对话（延续性）。
                convRef.current.hermesSessionId = sid
                dirtyRef.current = true // 绑定随对话持久化
              },
              onForkSourceConsumed: () => {
                // 补刀·六十：fork 源一次性消费（首轮解析后无论成败）——后续
                // 轮次不重复 fork；落盘同步清字段。
                convRef.current.forkSourceHermesSessionId = undefined
                dirtyRef.current = true
              },
              onProjectSessionBound: (projectId) => {
                // 项目会话是 vault 级，持久化在 settings 中。
                plugin.settings.localAgent.projectSessionId = projectId
                plugin.saveSettings()
              },
            })
          }
        } catch (err) {
          // 编排外意外的最后防线——runHermesTurn 自身永不 reject（一切失败
          // 已在内部落成整段错误文案）。
          failText(
            `Hermes 会话出错：${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        } finally {
          flushPatches()
          // 追加98: 与 core 路径对齐——消息级 isStreaming 也要清 false。core
          // 在正常结束处清（{...m, isStreaming:false}）、错误路径在 toError
          // 里清；hermes 此前只调全局 setIsStreaming(false)，消息字段残留
          // true → ChatMessageView 五按钮（!v.isStreaming）在 hermes 输出
          // 上永不显示；持久化不存该字段，重新加载后变 undefined 才「看
          // 情况」出现（用户报：初次输出无按钮、后续时有时无）。
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, isStreaming: false } : m,
            ),
          )
          abortRef.current = null
          setIsStreaming(false)
        }
        return
      }

      const { aiFolder, hideAiFolder, excludedFolders } =
        plugin.settings.general
      const ctx: ToolContext = {
        app: plugin.app,
        signal: controller.signal,
        confirm,
        // 追加63: AI 主动提问 —— 面板显示在输入框上方，用户点预设或自由输入
        // 后 resolve；用户关闭面板 → cancelled。追加76: 支持一次多题（batch）
        // —— 用户答完一题再显示下一题，全部答完才 resolve，answers 全量返回。
        askUser: (q) =>
          new Promise<AskResult>((resolve) => {
            const questions =
              'questions' in q && q.questions.length > 0
                ? q.questions
                : [q as AskQuestion]
            askResolveRef.current = resolve
            const session: AskSession = {
              questions,
              index: 0,
              answers: [],
            }
            askSessionRef.current = session
            setAskSession(session)
          }),
        pushUndo: (label, revert, data) =>
          plugin.undoStack.push(
            label,
            revert,
            {
              // 追加62: 记录会话 + 轮次，供回溯时按轮回滚 AI 修改。
              convId: convIdRef.current ?? undefined,
              turnNo: opts.turnNo,
            },
            // Task #8: 工具层已给出可序列化快照（id/path/before/kind…）时，
            // 补全会话戳后透传，供 undo.json 持久化；data 为空（纯运行时
            // 条目）则不传。
            data
              ? {
                  ...data,
                  convId: data.convId ?? convIdRef.current ?? undefined,
                  turnNo: data.turnNo ?? opts.turnNo,
                }
              : undefined,
          ),
        imageProvider: createImageProvider(
          plugin.settings.image,
          plugin.settings.llm,
        ),
        confirmDestructive: plugin.settings.safety.confirmDestructive,
        // M2-T8: 主 agent 审批模式（与 hermes 同套语义）——agentRunner 按
        // 它决定破坏性工具是否弹审批面板（default/accept_edits/dont_ask）。
        approvalMode: plugin.settings.safety.approvalMode,
        skills: runSkills,
        disabledSkills,
        excludedFolders: effectiveExclusions(
          plugin.app,
          excludedFolders,
          aiFolderExclusion(hideAiFolder, aiFolder),
        ),
        aiFolder,
      }

      const handle = (event: AgentEvent) => {
        switch (event.type) {
          case 'text':
            // Coalesce to one patch per animation frame (see queuePatch).
            queuePatch((blocks) => {
              const next = [...blocks]
              const last = next[next.length - 1]
              if (last && last.kind === 'text') {
                next[next.length - 1] = { kind: 'text', text: last.text + event.text }
              } else {
                next.push({ kind: 'text', text: event.text })
              }
              return next
            })
            break
          case 'tool-start':
            // Flush coalesced text first — a tool block must land AFTER the
            // text that preceded it in the stream.
            flushPatches()
            // Task list (清单): todo_write renders as a live checklist block
            // instead of a chain step. UPSERT semantics — a later call
            // refreshes the same block in place (latest list wins); an
            // unparseable payload falls through to the ordinary tool block so
            // the failure stays visible in the thought chain.
            if (event.name === 'todo_write') {
              const items = parseTodos(event.args.todos)
              if (items) {
                patchAssistant((blocks) => {
                  const next = [...blocks]
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].kind === 'todo') {
                      next[i] = {
                        kind: 'todo',
                        callId: event.callId,
                        items,
                        state: 'running',
                      }
                      return next
                    }
                  }
                  next.push({
                    kind: 'todo',
                    callId: event.callId,
                    items,
                    state: 'running',
                  })
                  return next
                })
                break
              }
            }
            // Retry detection (追加⑱ 补刀): if the previous tool block just
            // failed and the model immediately fires another tool call, the
            // failure becomes a "retrying" block (red-pulse dot) until that
            // next call resolves.
            patchAssistant((blocks) => {
              const next = [...blocks]
              const last = next[next.length - 1]
              if (last?.kind === 'tool' && last.state === 'error') {
                next[next.length - 1] = { ...last, state: 'retrying' }
              }
              next.push({
                kind: 'tool',
                callId: event.callId,
                name: event.name,
                args: event.args,
                state: 'running',
                thinking: event.thinking,
              })
              return next
            })
            break
          case 'tool-result':
            flushPatches()
            patchAssistant((blocks) =>
              blocks.map((b) =>
                b.kind === 'tool' && b.callId === event.callId
                  ? {
                      ...b,
                      state: event.ok ? 'done' : 'error',
                      summary: event.summary,
                      output: event.output,
                    }
                  : b.kind === 'todo' && b.callId === event.callId
                    ? { ...b, state: event.ok ? 'done' : 'error' }
                    : b.kind === 'tool' && b.state === 'retrying'
                      ? { ...b, state: 'error' } // the retry resolved — that failure is final
                      : b,
              ),
            )
            break
          case 'error':
            turnErrored = true
            flushPatches()
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, error: event.message } : m,
              ),
            )
            break
          case 'done': {
            // Task #8: 记录本轮真实的 prompt token 用量（供 Chat 头部用量
            // chip 以实际值替代粗估）；finish === 'length' = 输出被截断。
            const promptTokens = event.usage?.promptTokens
            if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
              setLastPromptTokens(promptTokens)
            }
            if (event.finish === 'length') {
              new Notice('回答可能因达到输出长度上限被截断，可继续追问让它补完。')
            }
            break
          }
        }
      }

      // Session overrides: a per-conversation model (profile id, profile /
      // model name, or a raw model string) beats the global default; the
      // thinking level rides along on every agent turn. Vision routing may
      // swap in a vision-capable model for this turn (effectiveOverride).
      const resolved = resolveSessionModel(llm, effectiveOverride)
      const provider = createLLMProvider(resolved)
      // Opt-in diagnostics: which model actually served this turn (metadata
      // only — never message content). No-op when the switch is off.
      dlog(
        'info',
        'chat',
        `turn model=${resolved.model} provider=${resolved.provider}` +
          `${opts.command ? ` command=${opts.command}` : ''}` +
          `${opts.noTools ? ' noTools' : ''}`,
      )
      // Tools: disabled for aside questions (noTools) OR when the resolved
      // model lacks tool-calling capability (tools default true unless
      // explicitly false). The provider also self-gates body.tools, but
      // skipping tool registration entirely avoids confusing the model with
      // tool descriptions it can't invoke.
      const toolsDisabled =
        opts.noTools || resolved.capabilities?.tools === false
      for await (const event of runAgent({
        provider,
        history,
        registry,
        ctx,
        // Task #8: 工具轮数上限来自设置（maxToolTurns），钳制到 4–24。
        maxTurns: Math.min(
          24,
          Math.max(4, plugin.settings.general.maxToolTurns || 8),
        ),
        chatOptions: { thinking },
        // Explicit tool set every time: [] for aside/no-capability turns,
        // otherwise this agent's filtered selection (通用池 ∩ agent 选择).
        tools: toolsDisabled ? [] : runTools,
      })) {
        handle(event)
      }
      // Drain any coalesced chunks before flipping isStreaming off.
      flushPatches()
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, isStreaming: false } : m,
        ),
      )

      // 进化 B 案：轮成功结束后按需节流复盘（fire-and-forget；建议只进
      // 确认面板，绝不自动写盘）。出错/中止的轮不触发。
      void maybeReflect({
        turnNo: opts.turnNo ?? 0,
        command: opts.command,
        ephemeral: opts.ephemeral,
        noTools: opts.noTools,
        failed: turnErrored,
        llm,
      })
      } catch (err) {
        // Paint the streamed text up to the failure point first.
        flushPatches()
        const aborted =
          (err instanceof LLMError && err.code === 'aborted') ||
          (err instanceof Error && err.name === 'AbortError')
        const toError = (m: UiMessage): UiMessage => {
          if (m.id !== assistantId) return m
          if (aborted) {
            const hasContent = (m.blocks ?? []).some(
              (b) =>
                (b.kind === 'text' && b.text) ||
                b.kind === 'tool' ||
                b.kind === 'todo',
            )
            return {
              ...m,
              isStreaming: false,
              blocks: hasContent
                ? m.blocks
                : [{ kind: 'text', text: '（已停止）' }],
            }
          }
          return {
            ...m,
            isStreaming: false,
            error: friendlyMessage(err),
            errorInfo: describeError(err),
          }
        }
        setMessages((prev) =>
          prev.some((m) => m.id === assistantId)
            ? prev.map(toError)
            : // Preparation-stage failure (brain-file load / image reads
              // before the stream started): the assistant message was never
              // mounted — append a visible error bubble instead of letting
              // runCore reject (an unhandled rejection disables the plugin
              // in Obsidian — the mobile "keeps turning itself off" bug).
              [...prev, toError({ id: assistantId, role: 'assistant', blocks: [] })],
        )
      } finally {
        // Drain any last coalesced chunks (normal end or abort).
        flushPatches()
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [plugin, confirm, thinking, modelOverride, setMessages, maybeReflect],
  )

  // Apply a '/' command locally; returns the assistant note to echo.
  const applyCommand = useCallback(
    (name: string, arg: string): { note: string; echo: UiMessage[] } => {
      const userMsg: UiMessage = {
        id: genId(),
        role: 'user',
        content: `/${name}${arg ? ` ${arg}` : ''}`,
      }
      let note: string
      let echo: UiMessage[] = [userMsg]
      switch (name) {
        case 'model':
          if (!arg) {
            note = '用法：/model <档案名|模型名> —— 只对本会话生效；直接发 /model 可从列表里选。'
          } else {
            setModelOverride(arg)
            const resolved = resolveSessionModel(
              plugin.settings.llm,
              arg,
            )
            note = `本会话已切换到「${resolved.displayName}」（${resolved.model} · ${resolved.provider}，不改全局设置）。`
          }
          break
        case 'think': {
          const level = parseThinkLevel(arg)
          if (!level) {
            note =
              '用法：/think <think|think-hard|ultrathink|think-off> —— 深度思考更慢更贵但更准。'
          } else {
            setThinking(level)
            note =
              level === 'off'
                ? '已关闭深度思考，恢复默认。'
                : `已开启深度思考「${level}」：回答前会先推理（更慢、更贵、更准）。`
          }
          break
        }
        default:
          note = `未知命令：/${name}`
      }
      if (note) echo = [...echo, noteMsg(note)]
      return { note, echo }
    },
    [],
  )

  const send = useCallback(
    async (userText: string, llm: LLMSettings) => {
      const text = userText.trim()
      if (!text || abortRef.current) return

      // 进化 B 案：新轮开始即打断在途复盘（其窗口已过时）；面板里已给出
      // 的建议不受影响，用户仍可确认。
      reflectAbortRef.current?.abort()

      // Hermes 模式：整轮由 hermes 原生驱动，插件不解析又不拦截 / 与 @——
      // 原样透传给 runCore 的 hermes 轮，避免强行联合（/model、/compress
      // 等 hermes 命令不该被插件的 KNOWN_COMMANDS 分发吃掉）。
      const directive = parseDirective(text)
      const convAgentDef = convRef.current.agentId
        ? plugin.agents.getByName(convRef.current.agentId)
        : undefined
      const isHermesConv = convAgentDef?.engine === 'hermes'
      // /mode [模式] 的拦截处理（M2-T8 双引擎）：无参 → 弹审批模式选择
      // 窗；非法参数 → 用法提示；合法中文别名/英文 id → 切换。hermesBound
      // = true 走 pickHermesMode（会话 override + hub.setMode 链路），
      // false = 纯 core 语境写 SafetySettings.approvalMode（全局设置，
      // 下一轮工具确认即生效）。回复挂 UiMessage.command='mode' 状态徽章
      // + 当前模式文案。返回 true 表示已消费（调用方 return）。
      const handleModeDirective = async (hermesBound: boolean): Promise<boolean> => {
        if (directive?.kind !== 'command') return false
        const arg = directive.arg.trim()
        const userMsg: UiMessage = {
          id: genId(),
          role: 'user',
          content: text,
        }
        if (!arg) {
          // 与 /model 无参同款（M2-T2 收口）：命令文本不进会话、不标记脏——
          // 直接弹审批模式选择窗。此前把 /mode 当用户消息入列，会让人误
          // 以为命令被当作普通文本发送了（选择窗是唯一反馈面）。
          setPickerRequest('mode')
          return true
        }
        const modeId = parseHermesModeArg(arg)
        if (!modeId) {
          dirtyRef.current = true
          setMessages((prev) => [...prev, userMsg, noteMsg(HERMES_MODE_USAGE)])
          return true
        }
        const ok = hermesBound ? await pickHermesMode(modeId) : await pickCoreApprovalMode(modeId)
        dirtyRef.current = true
        setMessages((prev) => [
          ...prev,
          userMsg,
          ok
            ? {
                ...noteMsg(
                  hermesBound
                    ? `Hermes 审批模式已切换为「${HERMES_MODE_LABEL[modeId]}」（每轮发送时幂等应用）。`
                    : `审批模式已切换为「${HERMES_MODE_LABEL[modeId]}」（破坏性操作将按此模式确认）。`,
                ),
                command: 'mode',
              }
            : noteMsg(
                hermesBound
                  ? '审批模式切换失败——请确认 Hermes 集成已启用且 vault 为本地文件系统（设置 → Hermes）。'
                  : '审批模式切换失败。',
              ),
        ])
        return true
      }

      // /hermes-init: 初始化 Hermes ↔ Obsidian 对话同步——确保 Hermes 侧
      // 存在当前仓库的项目会话（不存在则经 getOrCreateProjectSession 新建
      // 并写回 settings，vault 级绑定），并把项目状态「展开」在回复里。
      // 双引擎共用（hermes 对话拦截防透传；core 对话也可手动初始化）。
      const handleHermesInitDirective = async (): Promise<void> => {
        const userMsg: UiMessage = {
          id: genId(),
          role: 'user',
          content: text,
        }
        dirtyRef.current = true
        if (Platform.isMobile) {
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg('Hermes 对话同步仅桌面端可用（移动端不支持）。'),
          ])
          return
        }
        const hubCfg = buildHermesHubConfig()
        if (!hubCfg) {
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg(
              'Hermes 集成不可用——请在设置 → Hermes 中启用，并确认仓库是本地文件系统。',
            ),
          ])
          return
        }
        const hub = getHermesHub()
        try {
          // 显式项目层（Hermes「项目」= projects.db 显式工作区）：确保存在
          // 与当前仓库对应的项目（name=仓库名，folders=vault 根）——桌面端
          // 项目区按显式项目分组，会话经 cwd 最深匹配归入；没有它对话只会
          // 落在父目录项目（如家目录 main）的仓库节点下。项目创建失败不阻
          // 断项目会话（两层独立，会话层仍可用）。
          const proj = await ensureHermesProject({
            command: hubCfg.command,
            vaultRoot: hubCfg.cwd,
          })
          const previous = plugin.settings.localAgent.projectSessionId ?? null
          const projectId = await getOrCreateProjectSession(hub, hubCfg, previous)
          const created = previous !== projectId
          plugin.settings.localAgent.projectSessionId = projectId
          plugin.saveSettings()
          const repoName =
            hubCfg.cwd.split(/[\\/]/).filter(Boolean).pop() || hubCfg.cwd
          const projNote = proj.ok
            ? proj.created
              ? `已在 Hermes 中新建仓库项目「${repoName}」（桌面端项目区可见）`
              : `Hermes 仓库项目「${repoName}」已存在`
            : `Hermes 仓库项目「${repoName}」创建失败：${proj.error}（项目会话不受影响）`
          const sessNote = created
            ? `已新建项目会话 ${projectId}，此后插件里的 Hermes 对话都会从该项目 fork。`
            : `项目会话 ${projectId} 已就绪，插件里的 Hermes 对话都会从该项目 fork。`
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg(`${projNote}；${sessNote}`),
          ])
        } catch (err) {
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg(
              `Hermes 项目初始化失败：${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          ])
        }
      }

      // M2-T5: hermes 会话的 /compact 路由改写落点——sendText 是最终喂给
      // runCore 的 prompt（用户气泡仍显示原文 text），runCommand 给回复挂
      // 命令状态徽章。非 hermes 对话两者保持原值，下方分发零变化。
      let sendText = text
      let runCommand: string | undefined
      if (isHermesConv) {
        // 能力门控：hermes 路径下除「退出」外，插件指令全部旁路给 hermes。
        // /hermes-mode 必须在此拦截——否则会被原文透传成 hermes 的原生
        // 命令，命令面板的退出入口（以及手打退出）就失效了。
        if (
          directive?.kind === 'command' &&
          directive.name === 'hermes-mode'
        ) {
          // 退回主 agent（与 backFromAgent 同款语义）
          void backFromAgent()
          return
        }
        // /hermes-open: 当前 Hermes 对话在桌面端打开（「合并展示」的镜像
        // 出口）。detached 启动 `hermes desktop --skip-build --cwd <vault>`
        // ——桌面端按 cwd 归组项目，当前 acp 会话（cwd=vault 根）即在该
        // 项目下可见。传 HERMES_DESKTOP_SESSION_ID 环境变量，桌面端可据此
        // 定位到具体对话（当前版本尚不支持，仅做基础设施预留）。
        // 面板已按 hermesDesktop 能力门控隐藏（core 对话无此
        // 命令），此处拦截防手打透传。
        if (directive?.kind === 'command' && directive.name === 'hermes-open') {
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          const cfg = buildHermesHubConfig()
          const sid = convRef.current.hermesSessionId
          const ok =
            !!cfg &&
            spawnDetachedLocal(
              cfg.command,
              ['desktop', '--skip-build', '--cwd', cfg.cwd],
              { cwd: cfg.cwd },
              undefined,
              sid ? { HERMES_DESKTOP_SESSION_ID: sid } : undefined,
            )
          dirtyRef.current = true
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg(
              ok
                ? '已在 Hermes 桌面端打开当前 vault 项目（当前对话可在该项目下找到）。'
                : '打开 Hermes 桌面端失败——请确认 Hermes 集成已启用且 vault 为本地文件系统（设置 → Hermes）。',
            ),
          ])
          return
        }
        // /hermes-init: 插件本地动作（项目会话存在性检查/新建），不透传给
        // hermes（hermes 侧没有对应命令）——hermes 对话中发送也走初始化。
        if (directive?.kind === 'command' && directive.name === 'hermes-init') {
          await handleHermesInitDirective()
          return
        }
        // /settings · /mcp：纯插件本地 UI 动作（打开设置页 / MCP 管理面板），
        // hermes 侧没有对应命令——不拦截的话会被当正文透传给模型。与 core
        // 引擎同名分支同款处理（本地执行 + echo 提示，不进 hermes 轮）。
        if (
          directive?.kind === 'command' &&
          (directive.name === 'settings' || directive.name === 'mcp')
        ) {
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          if (directive.name === 'settings') plugin.openSettingsTab()
          else new McpManageModal(plugin.app, plugin).open()
          dirtyRef.current = true
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg(
              directive.name === 'settings'
                ? '已打开插件设置（设置 → AI Assistant）。'
                : '已打开 MCP 服务管理面板（开关 / 编辑 / 删除 / 添加）。',
            ),
          ])
          return
        }
        // /new: 新开空白对话（无记录的窗口）。hermes 模式必须在此拦截——
        // 否则透传给 hermes 原生 /new 只会在 hermes 侧另起会话并回一句
        // 「已新开」，插件对话界面原地不动。拦截后**保持 hermes 模式**：
        // 新建 HERMES_AGENT_NAME 会话（空白、未绑定 hermesSessionId，
        // 下一轮从项目 fork 新子会话）——与 toggleHermesMode 主→hermes
        // 的新建语义一致；用户若想退出 hermes 有专门的切回入口。
        if (directive?.kind === 'command' && directive.name === 'new') {
          await newConversation(HERMES_AGENT_NAME)
          return
        }
        // 任务一 §1.2: /mode [模式] —— 审批模式切换（hermes 会话语境，
        // 插件侧拦截不透传）；M2-T8 起 core 引擎同款命令照常拦截。
        if (directive?.kind === 'command' && directive.name === 'mode') {
          await handleModeDirective(true)
          return
        }
        // M2-T5: /compact [策略] → hermes 原生 /compress（服务端
        // _handle_slash_command 本地拦截，不走 LLM），不碰插件侧
        // compactContext——不搞双压缩机制。实测 hermes acp_adapter/server.py
        // 的 _cmd_compress：签名虽收 args，但函数体从不读取——无条件对整个
        // history 强制压缩（_compress_context(..., force=True)），策略参数
        // 没有消费点，故降级为裸 /compress（带参透传只会在 hermes 侧留下
        // 无意义的尾巴）。压缩结果经 session/update 以普通文本回来，按普通
        // 消息渲染 + compact 徽章（复用现有 UiMessage.command 机制）。
        if (directive?.kind === 'command' && directive.name === 'compact') {
          sendText = '/compress'
          runCommand = 'compact'
        }
        // 补刀·五十七: //技能名 与主 agent 同款双斜杠唤起——hermes 技能
        // 命令是单斜杠形态（/slug），转单斜杠透传。hermes ACP 对未知斜杠
        // 命令 fall-through 当正文，模型凭系统提示技能索引自行 skill_view
        // 加载（hermes 无 ACP 软件层技能展开）。转换不查清单：//x 即用户
        // 显式技能调用意图，/x 是 hermes 原生形态，未知名照旧当正文处理。
        if (directive?.kind === 'skill') {
          sendText = `/${directive.name}${
            directive.body ? ` ${directive.body}` : ''
          }`
        }
        // 行为绑定表：/reset → ConfirmModal 确认后透传（面板即发与裸输两条
        // 路径都经 send 收口，统一在此拦截）。hermes /reset 只清 hermes 侧
        // state.db 历史，插件侧对话实录保留——两边会脱节，必须显式确认。
        // 拒绝 → 不透传、不发送、不加任何消息。
        if (text === '/reset') {
          const ok = await confirm({
            toolName: 'reset',
            title: HERMES_RESET_CONFIRM.title,
            message: HERMES_RESET_CONFIRM.message,
          })
          if (!ok) return
        }
        // 跳过下方全部插件指令分发，直接落到 runCore 的 hermes 轮。
      } else if (directive?.kind === 'agents') {
        const q = directive.query.trim()
        const hit = q ? plugin.agents.getByName(q) : null
        if (
          hit &&
          plugin.settings.agents.enabled &&
          !plugin.settings.agents.disabled.includes(hit.name)
        ) {
          await pickAgent(hit.name)
        } else {
          setPickerRequest('agent')
        }
        return
      }

      // '/' commands never reach the LLM — they mutate session state and echo
      // a note. Unknown command names fall through as ordinary chat text.
      // Commands that fall through to runCore mark their result message so
      // the chat shows a status pill (追加⑱ 补刀: /btw / /learn / /compact).
      if (!isHermesConv && directive?.kind === 'command' && KNOWN_COMMANDS.has(directive.name)) {
        const { name, arg } = directive

        if (name === 'mode') {
          // /hermes 任务分发对话（agentId 为空但 hermesSessionId 非空）：
          // 会话已绑定，/mode 是 hermes 会话能力，照常拦截处理（弹窗/切
          // 模式）；未绑定是纯 core 语境——M2-T8 起审批模式主 agent 同
          // 套语义，/mode 直接切换 SafetySettings.approvalMode。
          if (convRef.current.hermesSessionId != null) {
            await handleModeDirective(true)
          } else {
            await handleModeDirective(false)
          }
          return
        } else if (name === 'hermes-mode') {
          // 切换模式 = 切换上下文会话（/new 语义）：主对话 ⇄ Hermes 新会话。
          toggleHermesMode()
          return
        } else if (name === 'hermes-init') {
          // /hermes-init: 初始化 Hermes 对话同步——core 对话中也能手动触发
          // （创建/校验 vault 项目会话并写回 settings）。本地动作，不经过 LLM。
          await handleHermesInitDirective()
          return
        } else if (name === 'learn') {
          // '/learn <request>' runs as a real agent turn (runCore rewrites
          // the text into the learn prompt); without an argument, show usage.
          if (!arg) {
            const userMsg: UiMessage = {
              id: genId(),
              role: 'user',
              content: text,
            }
            dirtyRef.current = true
            setMessages((prev) => [
              ...prev,
              userMsg,
              noteMsg(
                '用法：/learn <要结晶什么> —— 回顾本次对话，把可复用的做法写成一个技能文件；之后 //技能名 即可直接调用。',
              ),
            ])
            return
          }
          // fall through to runCore below
          runCommand = 'learn'
        } else if (name === 'compact') {
          // '/compact [策略]' — one-shot context compression (no tools),
          // NOT an agent turn: handled entirely inside compactContext.
          await compactContext(text, arg, llm)
          return
        } else if (name === 'chats') {
          setPickerRequest('chats')
          return
        } else if (name === 'new') {
          // Save what's open and start a blank conversation — the cleared
          // screen (title reverts to "AI 助手") is the feedback.
          await newConversation()
          return
        } else if (name === 'edit') {
          // 追加86: '/edit' = 双击最后一条用户消息进入重编辑（追加46/48 的
          // 命令入口）。不 echo 消息、不进 LLM——只把目标 id 递给 Chat，
          // 由 Chat 载入输入框并挂编辑徽章；没有可编辑目标时给个提示。
          const msgs = messagesRef.current
          const target = [...msgs]
            .reverse()
            .find((m) => m.role === 'user' && !m.ephemeral)
          if (!target) {
            setMessages((prev) => [...prev, noteMsg('还没有可重新编辑的消息。')])
            return
          }
          setEditRequest(target.id)
          return
        } else if (name === 'settings') {
          // Plugin-internal /settings (NOT an Obsidian command, 追加⑪ 补刀):
          // jump straight to this plugin's settings tab.
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          plugin.openSettingsTab()
          dirtyRef.current = true
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg('已打开插件设置（设置 → AI Assistant）。'),
          ])
          return
        } else if (name === 'mcp') {
          // '/mcp' opens the MCP service management modal (toggle / edit /
          // delete / add) without leaving the chat — same logic as the
          // settings-page MCP panel, modal form.
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          new McpManageModal(plugin.app, plugin).open()
          dirtyRef.current = true
          setMessages((prev) => [
            ...prev,
            userMsg,
            noteMsg('已打开 MCP 服务管理面板（开关 / 编辑 / 删除 / 添加）。'),
          ])
          return
        } else if (name === 'model' && !arg) {
          // Bare /model opens the profile picker; "/model <arg>" falls
          // through to applyCommand (typed override).
          setPickerRequest('model')
          return
        } else if (name === 'think' && !arg) {
          // Bare /think opens the thinking-level picker.
          setPickerRequest('think')
          return
        } else if (name === 'rewind') {
          const n = Number.parseInt(arg, 10)
          if (!Number.isFinite(n)) {
            setPickerRequest('rewind')
            return
          }
          // Numeric shortcut: /rewind 3 = rewind to before turn 3.
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          const pts = turnPoints(messagesRef.current)
          const pt = pts.find((p) => p.turn === n)
          if (!pt) {
            dirtyRef.current = true
            setMessages((prev) => [
              ...prev,
              userMsg,
              noteMsg(
                `没有第 ${n} 轮（当前共 ${pts.length} 轮）。直接发 /rewind 可从列表里选。`,
              ),
            ])
            return
          }
          if (pt.index <= 0) {
            // 追加57: 首轮之前没有位置可回（rewindTo 拒绝 index<=0）——
            // 给友好提示而不是抛「没有可回溯的位置」错误。
            dirtyRef.current = true
            setMessages((prev) => [
              ...prev,
              userMsg,
              noteMsg('第 1 轮是对话起点，之前没有可回溯的位置。'),
            ])
            return
          }
          await rewindTo(pt.index).then((err) => {
            if (err) {
              // 追加70: 目标轮已是最后一轮（无可移除内容）等提示不静默丢弃。
              dirtyRef.current = true
              setMessages((prev) => [...prev, noteMsg(err)])
            }
          })
          return
        } else if (name === 'branch') {
          // Branch inherits the parent's title (no naming modal — 用户指示).
          // null only when a run is active → nothing happens (no /branch echo).
          const result = await branchChild()
          if (result === null) return
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          dirtyRef.current = true
          setMessages((prev) => {
            if (result === 'empty') {
              return [
                ...prev,
                userMsg,
                noteMsg('当前没有可分支的对话——先聊点什么，再用 /branch。'),
              ]
            }
            const depth =
              conversationDepth(convList, convRef.current.parentId ?? '') + 1
            return [
              ...prev,
              userMsg,
              noteMsg(
                `已开出子对话「${result}」（第 ${depth} 层，继承 ${
                  convRef.current.parentMessageCount
                } 条上下文）。发 /chats 查看整棵对话树。`,
              ),
            ]
          })
          return
        } else if (name === 'btw') {
          // Ephemeral "by the way" aside: answered from the CURRENT context,
          // but the exchange never enters it — ephemeral flag keeps it out of
          // persistence and turn counting, the history passed in skips it,
          // and no tools are offered (a side question talks, doesn't mutate).
          if (!arg) {
            const userMsg: UiMessage = {
              id: genId(),
              role: 'user',
              content: text,
            }
            dirtyRef.current = true
            setMessages((prev) => [
              ...prev,
              userMsg,
              noteMsg(
                '用法：/btw <问题> —— 基于当前上下文顺便问个小问题；这一问一答不会记入对话历史。',
              ),
            ])
            return
          }
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
            ephemeral: true,
          }
          await runCore(
            arg,
            llm,
            messagesRef.current.filter((m) => !m.ephemeral),
            (assistantMsg) =>
              setMessages((prev) => [...prev, userMsg, assistantMsg]),
            { ephemeral: true, noTools: true, command: 'btw' },
          )
          return
        } else if (name === 'hermes') {
          // /hermes <任务>：把复杂任务分发给本机 Hermes 执行（桌面专属）。
          // 非 ephemeral——任务与 hermes 结果都进入对话历史，主 agent 可
          // 基于结果继续。runCore 的 hermes 分支按 opts.command === 'hermes'
          // 接管（绑定会话 + 带对话上下文窗口）。
          if (!arg) {
            const userMsg: UiMessage = {
              id: genId(),
              role: 'user',
              content: text,
            }
            dirtyRef.current = true
            setMessages((prev) => [
              ...prev,
              userMsg,
              noteMsg(
                '用法：/hermes <任务> —— 把复杂任务分发给本机 Hermes 执行（桌面专属）；结果进入对话历史，可继续跟进。',
              ),
            ])
            return
          }
          const userMsg: UiMessage = {
            id: genId(),
            role: 'user',
            content: text,
          }
          await runCore(
            arg,
            llm,
            messagesRef.current.filter((m) => !m.ephemeral),
            (assistantMsg) =>
              setMessages((prev) => [...prev, userMsg, assistantMsg]),
            { command: 'hermes' },
          )
          return
        } else {
          const { echo } = applyCommand(name, arg)
          if (echo.length > 0) {
            dirtyRef.current = true
            setMessages((prev) => [...prev, ...echo])
          }
          return
        }
      }

      const userMsg: UiMessage = { id: genId(), role: 'user', content: text }
      await runCore(
        sendText,
        llm,
        // Aside (ephemeral) exchanges are display-only — never part of the
        // context handed to the LLM.
        messages.filter((m) => !m.ephemeral),
        (assistantMsg) => setMessages((prev) => [...prev, userMsg, assistantMsg]),
        runCommand
          ? { command: runCommand, turnNo: turnPoints(messagesRef.current).length + 1 }
          : { turnNo: turnPoints(messagesRef.current).length + 1 },
      )
    },
    [messages, runCore, applyCommand, newConversation, toggleHermesMode, branchChild, rewindTo, compactContext, convList, setMessages, plugin, openAgentConversation],
  )

  // 进化 B 案 —— 建议确认：面板点 ✓ 的唯一入口。记忆/画像走 save_memory
  // 同款 addMemoryEntry（注入防护 + 额度由 store 兜底）；技能建议转成
  // /learn 结晶轮（用户可见的正常对话轮，与手打 /learn 完全同款契约）。
  // 先把建议移出面板再执行——防连点双写。
  const approveSuggestion = useCallback(
    async (s: ReflectSuggestion, llm: LLMSettings): Promise<void> => {
      setPendingSuggestions((prev) => prev.filter((x) => x.id !== s.id))
      if (s.type === 'skill') {
        await send(`/learn ${s.content}`, llm)
        return
      }
      const target = s.type === 'user' ? 'user' : 'memory'
      const res = await addMemoryEntry(
        plugin.app,
        s.content,
        plugin.settings.general.aiFolder,
        target,
      )
      if (!res.ok) {
        new Notice(`建议未保存：${res.error}`)
        return
      }
      new Notice(
        res.duplicate
          ? '这条已经记过了，未重复保存。'
          : `已记入${target === 'user' ? '用户画像' : '长期记忆'}（下次新对话起生效）`,
      )
    },
    [plugin, send],
  )

  // Dismiss the whole panel (× button / conversation switch) — suggestions
  // are ephemeral by design: never persisted, never auto-applied.
  const dismissSuggestions = useCallback(() => {
    setPendingSuggestions([])
  }, [])

  // Re-run the last user message after a failed assistant turn, replacing the
  // error bubble instead of duplicating the user message.
  const retry = useCallback(
    async (llm: LLMSettings) => {
      if (abortRef.current || messages.length === 0) return
      // Aside (ephemeral) exchanges are display-only — retry operates on the
      // real conversation. Drop the trailing failed assistant message (if any).
      const msgs = messages.filter((m) => !m.ephemeral)
      if (msgs.length === 0) return
      const trimmed =
        msgs[msgs.length - 1].role === 'assistant'
          ? msgs.slice(0, -1)
          : [...msgs]
      const lastUser = [...trimmed].reverse().find((m) => m.role === 'user')
      if (!lastUser?.content) return
      const historyBase =
        trimmed[trimmed.length - 1]?.role === 'user'
          ? trimmed.slice(0, -1)
          : trimmed
      await runCore(lastUser.content, llm, historyBase, (assistantMsg) =>
        setMessages((prev) => {
          const base =
            prev[prev.length - 1]?.role === 'assistant'
              ? prev.slice(0, -1)
              : prev
          return [...base, assistantMsg]
        }),
        { turnNo: turnPoints(trimmed).length },
      )
    },
    [messages, runCore, setMessages],
  )

  const abort = useCallback(() => {
    abortRef.current?.abort()
    // 追加63: 停止生成时若 AI 提问面板还挂着（用户没答），一并关闭并视为取消。
    askResolveRef.current?.({ answer: '', cancelled: true })
    askResolveRef.current = null
    askSessionRef.current = null
    setAskSession(null)
    // 补刀·五十六：hermes 在途权限请求一并拒绝（停止 = 不再执行任何工具，
    // 审批面板不悬挂等 55s 兜底；hermes 侧立即收到 cancelled 停止等待）。
    getHermesHub().denyPendingPermissions()
    setPendingHermesPermission(null)
    // M2-T8：主 agent 审批面板同款清场——停止 = 拒绝挂起中的工具确认。
    confirmResolveRef.current?.(false)
    confirmResolveRef.current = null
    setPendingConfirm(null)
  }, [])

  // 追加63: 面板交互 —— 提交回答（预设按钮或自由输入）→ resolve 给工具；
  // 取消 → cancelled；停止生成时若面板还挂着也一并关闭。追加76: 多问题批
  // 答完一题自动切下一题，全部答完才 resolve（answers 全量）；中途关闭则
  // 把已收集的 answers 一并带回（partial），没答过任何题才是纯取消。
  const answerAsk = useCallback((answer: string) => {
    const s = askSessionRef.current
    if (!s) return
    const answers = [...s.answers, answer]
    if (s.index + 1 < s.questions.length) {
      const next: AskSession = { ...s, index: s.index + 1, answers }
      askSessionRef.current = next
      setAskSession(next)
    } else {
      askResolveRef.current?.({
        answer: answers[0] ?? '',
        answers,
        cancelled: false,
      })
      askResolveRef.current = null
      askSessionRef.current = null
      setAskSession(null)
    }
  }, [])
  const cancelAsk = useCallback(() => {
    const s = askSessionRef.current
    askResolveRef.current?.({
      answer: '',
      ...(s && s.answers.length > 0 ? { answers: s.answers } : {}),
      cancelled: true,
    })
    askResolveRef.current = null
    askSessionRef.current = null
    setAskSession(null)
  }, [])

  // Regenerate one specific assistant answer in place (追加46 修正; 追加51 修正;
  // 追加52 版本化): the user is unhappy with THIS answer — keep the turn's own
  // user message, re-ask it, and generate a NEW VERSION of the answer. The old
  // one is NOT deleted and later turns are NOT wiped: both stay on screen and
  // the ◀ N/M ▶ switcher under the answer flips between versions.
  const regenerate = useCallback(
    async (msgId: string, llm: LLMSettings) => {
      if (abortRef.current) return
      const msgs = messagesRef.current
      const idx = msgs.findIndex((m) => m.id === msgId)
      if (idx < 0 || msgs[idx].role !== 'assistant' || msgs[idx].ephemeral)
        return
      // The turn this answer belongs to = the last real user message before it.
      let userIdx = -1
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && !msgs[i].ephemeral) {
          userIdx = i
          break
        }
      }
      const userMsg = msgs[userIdx]
      if (userIdx < 0 || !userMsg?.content) return
      const historyBase = msgs.slice(0, userIdx)
      const old = msgs[idx]
      // 评审修复说明：此处不清 lastPromptTokens——重发一轮后 done 事件会立刻
      // 用真实 usage 刷新（见 rewindTo 注释）。
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isStreaming: true } : m)),
      )
      dirtyRef.current = true
      await runCore(userMsg.content, llm, historyBase, (assistantMsg) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? withNewVersion(old, assistantMsg) : m,
          ),
        ),
        { turnNo: turnPoints(msgs).find((p) => p.index === userIdx)?.turn },
      )
    },
    [runCore, setMessages],
  )

  // Flip which answer version a message shows (追加52): ◀ N/M ▶ under the
  // answer. Pure list math; only messages with 2+ versions can move.
  const switchVersion = useCallback(
    (msgId: string, dir: -1 | 1) => {
      setMessages((prev) => switchMessageVersion(prev, msgId, dir))
    },
    [setMessages],
  )


  // Edit-and-resend (追加46; 追加52 修正): replace a past USER message's text,
  // KEEP everything after it (the old answer becomes a switchable version
  // instead of being cut — later turns are NOT wiped), and re-run the agent
  // from that point. Same context contract as send/retry: `historyBase` is
  // everything before the edited message, runCore mounts the fresh reply.
  const editUserMessage = useCallback(
    async (msgId: string, newText: string, llm: LLMSettings) => {
      if (abortRef.current || !newText.trim()) return
      const msgs = messagesRef.current
      const idx = msgs.findIndex((m) => m.id === msgId)
      if (idx < 0 || msgs[idx].role !== 'user' || msgs[idx].ephemeral) return
      const text = newText.trim()
      const historyBase = msgs.slice(0, idx)
      const oldAnswer = msgs[idx + 1]
      // 评审修复说明：此处不清 lastPromptTokens——重发一轮后 done 事件会立刻
      // 用真实 usage 刷新（见 rewindTo 注释）。
      setMessages((prev) => [
        ...prev.slice(0, idx),
        { ...prev[idx], content: text },
        ...prev.slice(idx + 1),
      ])
      dirtyRef.current = true
      await runCore(text, llm, historyBase, (assistantMsg) =>
        setMessages((prev) => {
          const next = [...prev]
          const oldIdx = next.findIndex((m) => m.id === oldAnswer?.id)
          if (oldIdx >= 0) {
            // The answer right after the edited message becomes a version.
            next[oldIdx] = withNewVersion(oldAnswer, assistantMsg)
          } else {
            next.splice(idx + 1, 0, assistantMsg)
          }
          return next
        }),
        { turnNo: turnPoints(msgs).find((p) => p.index === idx)?.turn },
      )
    },
    [runCore, setMessages],
  )

  // Chip clearing (session state resets without touching messages).
  const clearPickerRequest = useCallback(() => setPickerRequest(null), [])
  // 追加86: Chat 消费完 /edit 请求后清场（与 clearPickerRequest 同构）。
  const clearEditRequest = useCallback(() => setEditRequest(null), [])

  // Picker data (recomputed as the conversation list / messages change).
  // 会话管理按模式过滤（用户要求：切换 Hermes 时左上角会话管理只显示
  // Hermes 会话）：Hermes 会话 = 内置 Hermes 代理（agentId）或绑定了 hermes
  // ACP 会话（/hermes 任务分发，hermesSessionId 非空）；主模式下反之隐藏。
  const isHermesMeta = useCallback(
    (m: ConversationMeta): boolean =>
      m.agentId === HERMES_AGENT_NAME || m.hermesSessionId != null,
    [],
  )
  const currentHermes = useMemo(() => {
    const cur = convList.find((m) => m.id === convId)
    return cur
      ? isHermesMeta(cur)
      : convAgentId === HERMES_AGENT_NAME
  }, [convList, convId, convAgentId, isHermesMeta])

  const conversations = useMemo<ConversationListItem[]>(() => {
    const items = flattenConversationTree(convList)
      .filter((n) => (currentHermes ? isHermesMeta(n.meta) : !isHermesMeta(n.meta)))
      .map((n) => ({
        meta: n.meta,
        depth: n.depth,
        current: n.meta.id === convId,
      }))
    return items
  }, [convList, convId, currentHermes, isHermesMeta])
  // The /model picker rows: every configured vendor-model, flagged with
  // whether it's the global default and whether THIS conversation overrides
  // to it. Falls back to legacy profiles when no vendors exist yet.
  const models = useMemo<ModelListItem[]>(() => {
    const llm = plugin.settings.llm
    const def = activeModel(llm)
    const items: ModelListItem[] = []
    for (const v of llm.vendors) {
      const vendorName = v.name.trim() || v.provider
      for (const m of v.models) {
        const name = m.name.trim()
        if (!name) continue
        // 追加㊳（用户指示）：/model 只列能对话的模型——生图模型不
        // 参与对话切换。
        if (resolveCapabilities(v, m)?.imageGen) continue
        items.push({
          id: m.id,
          name: vendorName ? `${vendorName} · ${name}` : name,
          description:
            `${v.provider}` +
            (v.baseUrl.trim()
              ? ` · ${v.baseUrl.trim().replace(/^https?:\/\//, '')}`
              : ''),
          isDefault: def !== null && def.model.id === m.id,
          current: modelOverride === m.id,
        })
      }
    }
    if (items.length === 0) {
      const defProfile = activeProfile(llm)
      for (const p of llm.profiles) {
        items.push({
          id: p.id,
          name: p.name.trim() || p.model.trim() || p.provider,
          description:
            `${p.model.trim() || '(未填模型名)'} · ${p.provider}`,
          isDefault: defProfile !== null && defProfile.id === p.id,
          current: modelOverride === p.id,
        })
      }
    }
    return items
    // plugin.settings is replaced wholesale on load/save — read through the
    // plugin ref so vendor edits re-derive the list.
  }, [plugin.settings, modelOverride])

  // 能力门控（capability gating）：当前对话是否跑在 hermes 上——两条路径：
  // ① agent def 有 engine: 'hermes'（内置 Hermes 代理或用户自建的 hermes
  // 引擎子代理）；② 对话绑定了 hermes ACP 会话（/hermes 任务分发：agentId
  // 为空但 hermesSessionId 非空）。是则云专属能力（/think /learn /compact
  // /btw）在 UI 上隐藏，因为 hermes 用自己的思考/记忆，插件这些状态对它
  // 无效。/model 自 M2-T1 起例外：hermes 路径上它弹 hermes 自己的模型清单
  // （绝不回落插件档案列表）。convId/hermesStatesTick 驱动重算：切换对话
  // 或会话绑定时都要重新判定（agentId 同为 null 的 core↔hermes 对话切换
  // 靠 convId；首轮绑定靠 hub 缓存通知）。
  const hermesPath = useMemo(() => {
    const def = convAgentId ? plugin.agents.getByName(convAgentId) : undefined
    return (
      def?.engine === 'hermes' || convRef.current.hermesSessionId != null
    )
  }, [convAgentId, plugin.agents, convId, hermesStatesTick])

  // M2-T4: 当前会话引擎（面板合并处唯一允许的引擎判断；命令级可见性全走
  // capability/清单机制）。
  const panelEngine: EngineId = hermesPath ? 'hermes' : 'core'

  // The /agent picker rows: the main-agent entry ('') plus every enabled
  // sub-agent (master toggle + disabled list, same discipline as skills).
  // Hermes 模式（纯壳）agent 独立：只保留「主对话」出口，插件子代理全部
  // 隐藏——/// 面板、/agent 子菜单、头部 agent pill 同步生效（数据驱动）。
  const agents = useMemo<AgentListItem[]>(() => {
    if (hermesPath) {
      return [
        {
          id: '',
          name: '主对话',
          description: '回到主 AI，开始一段新对话',
          current: false,
        },
      ]
    }
    const items: AgentListItem[] = [
      {
        id: '',
        name: '主对话',
        description: '回到主 AI，开始一段新对话',
        current: convAgentId === null,
      },
    ]
    if (plugin.settings.agents.enabled) {
      for (const def of plugin.agents.getAll()) {
        if (plugin.settings.agents.disabled.includes(def.name)) continue
        items.push({
          id: def.name,
          name: def.name,
          emoji: def.emoji,
          description: def.description,
          path: def.path,
          current: convAgentId === def.name,
        })
      }
    }
    return items
    // dataTick: 注册表热重载原地换内容、引用不变，靠 tick 触发重算（追加89）。
  }, [plugin.settings, plugin.agents, convAgentId, dataTick, hermesPath])

  // M2-T4: 当前对话绑定的 hermes 会话通告的命令注册表（hub 缓存，断连作
  // 废）。hermesStatesTick 在缓存写入/清空时 bump；convId/convAgentId 变化
  // 时换会话重读。
  const hermesAdvertised = useMemo(() => {
    if (panelEngine !== 'hermes') return []
    const sid = convRef.current.hermesSessionId
    return sid ? getHermesHub().getAdvertisedCommands(sid) : []
    // hermesStatesTick: 缓存变更通知的重渲染键。
  }, [panelEngine, hermesStatesTick, convId, convAgentId])

  // 用户隐藏名单（设置项，按引擎）——老 data.json 无此键时按块合并取缺省，
  // 这里再防一手畸形值。
  const hiddenCommands = useMemo(() => {
    const raw = plugin.settings.general.hiddenCommands
    return {
      core: Array.isArray(raw?.core) ? raw.core : [],
      hermes: Array.isArray(raw?.hermes) ? raw.hermes : [],
    }
  }, [plugin.settings.general])

  // M2-T4: 命令面板视图——插件命令按引擎能力/清单过滤，hermes 引擎再并入
  // 通告命令（用户隐藏名单 + Hermes 来源标注 + model 去重）。Composer 的 / 面板直接吃它。
  const panelCommands = useMemo(
    () => buildPanelCommands(panelEngine, hermesAdvertised, hiddenCommands),
    [panelEngine, hermesAdvertised, hiddenCommands],
  )

  // Pick a row from the /agent list; '' switch to the main agent.
  // 追加⑧: 直接在当前对话中切换 agent（不再新开 agent 专属对话）。
  // 清空 brainRef 让下次发送时重新加载新 agent 的 persona 快照。
  const pickAgent = useCallback(
    (id: string) => {
      if (abortRef.current) return
      const name = id.trim()
      brainRef.current = null // refresh persona snapshot on next send
      if (!name) {
        // '' = main agent: clear the agentId, keep the conversation.
        convRef.current = { ...convRef.current, agentId: null }
        setConvAgentId(null)
      } else {
        convRef.current = { ...convRef.current, agentId: name }
        setConvAgentId(name)
      }
      // 空对话时把标题设为 agent 名（方便识别）。
      if (convRef.current.title === '') {
        convRef.current.title = name || '主代理'
        setConvTitle(name || '主代理')
      }
      dirtyRef.current = true
    },
    [],
  )

  // 返回按钮 (追加44): restore the conversation the user was in BEFORE
  // entering the current sub-agent — the exact conversation, not a fresh
  // main-agent one. No entry recorded (e.g. reload) falls back to a new
  // main conversation. The entry is consumed on return, so a second agent
  // hop records a fresh origin.
  const backFromAgent = useCallback(async (): Promise<void> => {
    if (abortRef.current) return
    const entry = entryConvRef.current
    entryConvRef.current = null
    if (!entry) {
      await newConversation()
      return
    }
    if (entry.id === null) {
      await newConversation()
      return
    }
    await openConversation(entry.id)
  }, [newConversation, openConversation])

  // Pick a profile from the /model list; '' restores the global default.
  const pickModel = useCallback((id: string) => {
    setModelOverride(id === '' ? null : id)
  }, [])

  /* ── M2-T1/T2: hermes 模型 / 审批模式清单选择面 ─────────────────────
   * 清单由 hermes 在 session/new、session/load 响应里下发，hub 按 sessionId
   * 缓存。未就绪（还没建/恢复过会话，或进程刚崩溃）时 states = null，选择窗
   * 显示「hermes 清单加载中」并禁用——**禁止回落插件档案列表**（档案 id ≠
   * hermes encoded choice id）。普通引擎（core）路径完全不碰这套。 */

  /** 当前对话绑定的 hermes 会话的清单缓存；null = 未就绪。 */
  const hermesSessionStates = useMemo(() => {
    void hermesStatesTick // 订阅通知驱动重算
    const sid = convRef.current.hermesSessionId
    return sid ? getHermesHub().getSessionStates(sid) : null
  }, [hermesStatesTick, convId])

  const buildHermesHubConfig = useCallback(() => {
    const cfg = plugin.settings.localAgent
    const adapter = plugin.app.vault.adapter
    if (!cfg?.enabled || !(adapter instanceof FileSystemAdapter)) return null
    return {
      command: cfg.command.trim() || DEFAULT_HERMES_COMMAND,
      cwd: adapter.getBasePath(),
    }
  }, [plugin])

  // 补刀·五十七: hermes 技能清单（// 选择器数据面）——进入 hermes 模式或
  // // 面板打开时经 hermes CLI 拉取（listHermesSkills，COLUMNS=300 防截断）。
  // 失败静默：清单空 → // 面板不弹出（与技能禁用同效果）；发送转换不依赖
  // 清单（//x 一律转 /x，hermes 原生形态）。2s 节流防连打连刷。
  // 补刀·五十八: 描述用原生 Category（表格无 description 列，不手编占位），
  // Source=local 的自装技能标 hermes-local（面板徽章「用户」，与内置区分）。
  const hermesSkillsRef = useRef(0)
  const [hermesSkills, setHermesSkills] = useState<Skill[]>([])
  const refreshHermesSkills = useCallback((): void => {
    // 同步守卫：adapter 缺 getBasePath（测试 fake / 非标准 adapter）时
    // buildHermesHubConfig 会 throw——effect 里抛错会挂起 React 渲染。
    let cfg: { command: string; cwd: string } | null = null
    try {
      cfg = buildHermesHubConfig()
    } catch {
      return
    }
    if (!cfg) return
    const now = Date.now()
    if (now - hermesSkillsRef.current < 2000) return
    hermesSkillsRef.current = now
    void listHermesSkills({ command: cfg.command, cwd: cfg.cwd }).then((r) => {
      if (!r.ok) return
      setHermesSkills(
        r.skills.map((s) => ({
          metadata: {
            name: s.name,
            // 原生表格无 description 列——Category 是唯一真实差异信息
            // （local 技能常无分类 → 空描述，面板不渲染 sub 行）。
            description: s.category,
            mode: 'lazy' as const,
          },
          body: '',
          source:
            s.source === 'local'
              ? ('hermes-local' as const)
              : ('hermes' as const),
        })),
      )
    })
  }, [buildHermesHubConfig])

  // 补刀·五十七: hermes 模式进入/切换时刷新技能清单（// 面板数据面）；
  // core 对话不拉取（// 面板用插件技能，互不干扰）。
  useEffect(() => {
    if (currentHermes) refreshHermesSkills()
  }, [currentHermes, refreshHermesSkills])
  /** /model 选择窗选中 → hub.setModel(model_id)（hermes encoded choice id）。 */
  const pickHermesModel = useCallback(
    async (modelId: string): Promise<void> => {
      if (!modelId) return
      const sid = convRef.current.hermesSessionId
      const hubCfg = buildHermesHubConfig()
      if (!sid || !hubCfg) return
      try {
        await getHermesHub().setModel(hubCfg, sid, modelId)
        const ov = hermesOverridesRef.current.get(sid) ?? {}
        ov.model = modelId
        hermesOverridesRef.current.set(sid, ov)
      } catch (err) {
        new Notice(
          `Hermes 模型切换失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [buildHermesHubConfig],
  )

  /** 任务一 §1.2: 确保当前对话有可用 hermes 会话（/mode 选择面用）——
   *  已绑定且可恢复就用，否则按 runCore hermes 轮同款语义新建：项目会话
   *  （vault 级，settings.localAgent.projectSessionId）→ fork 子会话（对话
   *  级）。override 与 set_mode 必须作用在 fork 子会话上——轮次幂等查询
   *  getOverrides(activeSessionId) 用的就是子会话 id，记到项目会话上会
   *  永远查不到（/mode 切的模式一轮即回落设置默认值）。 */
  const ensureHermesSession = useCallback(async (): Promise<string | null> => {
    const hubCfg = buildHermesHubConfig()
    if (!hubCfg) return null
    const hub = getHermesHub()
    let sid = convRef.current.hermesSessionId
    if (sid) {
      const loaded = await hub.loadSession(hubCfg, sid).catch(() => false)
      if (!loaded) sid = null
    }
    if (!sid) {
      const projectId = await getOrCreateProjectSession(
        hub,
        hubCfg,
        plugin.settings.localAgent.projectSessionId ?? null,
      )
      if (plugin.settings.localAgent.projectSessionId !== projectId) {
        plugin.settings.localAgent.projectSessionId = projectId
        plugin.saveSettings()
      }
      const forked = await hub.forkSession(hubCfg, projectId)
      sid = forked.sessionId
      convRef.current.hermesSessionId = sid
      dirtyRef.current = true
    }
    return sid
  }, [buildHermesHubConfig, plugin])
  /** 审批模式选择入口选中 → hub.set_mode（清单内 id）。任务一 §1.2：
   *  返回 boolean 供 /mode 路由决定状态徽章；会话未建立时先建（模式选择窗
   *  需要清单就绪，清单由 session/new 响应下发）。 */
  const pickHermesMode = useCallback(
    async (modeId: string): Promise<boolean> => {
      if (!modeId) return false
      const hubCfg = buildHermesHubConfig()
      if (!hubCfg) return false
      try {
        const sid = await ensureHermesSession()
        if (!sid) return false
        await getHermesHub().setMode(hubCfg, sid, modeId as HermesModeId)
        const ov = hermesOverridesRef.current.get(sid) ?? {}
        ov.mode = modeId as HermesModeId
        hermesOverridesRef.current.set(sid, ov)
        return true
      } catch (err) {
        new Notice(
          `Hermes 审批模式切换失败：${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      }
    },
    [buildHermesHubConfig, ensureHermesSession],
  )

  /** M2-T8 主 agent 审批模式：core 引擎的 /mode 选择窗选中 → 写
   *  SafetySettings.approvalMode（全局设置，与 hermes 同套语义；下一轮
   *  工具确认即生效）。返回 boolean 供 /mode 路由决定状态徽章。 */
  const pickCoreApprovalMode = useCallback(
    async (modeId: string): Promise<boolean> => {
      const parsed = parseHermesModeArg(modeId)
      if (!parsed) return false
      plugin.settings.safety.approvalMode = parsed
      await plugin.saveSettings()
      return true
    },
    [plugin],
  )

  return {
    messages,
    isStreaming,
    send,
    retry,
    abort,
    // conversation management
    newConversation,
    toggleHermesMode,
    openConversation,
    openAgentConversation,
    branchFrom,
    branchChild,
    editUserMessage,
    regenerate,
    switchVersion,
    deleteConversation,
    renameConversation,
    rewindTo,
    // attachments added from outside the vault, bound to the conversation
    onAttachmentSaved,
    convId,
    convTitle,
    convAgentId,
    hermesPath,
    conversations,
    models,
    pickModel,
    agents,
    pickAgent,
    // M2-T4: 命令面板数据驱动视图——panelCommands = 引擎过滤后的插件命令
    // +（hermes 引擎）通告命令并入（HermesComposer 独立窗口已删，主视图
    // Composer 的 / 面板统一吃这一份）。
    panelCommands,
    // M2-T1/T2: hermes 模型/审批模式清单缓存与清单内选择（选择窗专用）。
    hermesSessionStates,
    pickHermesModel,
    pickHermesMode,
    pickerRequest,
    clearPickerRequest,
    // 追加86: /edit 命令——目标用户消息 id（Chat 载入输入框后清场）。
    editRequest,
    clearEditRequest,
    // session state (shown in the composer placeholder / think+model pickers)
    thinking,
    modelOverride,
    // Task #8: 最近一轮 prompt token 用量（实际值，供 Chat 头部用量 chip）。
    lastPromptTokens,
    // 追加 63: AI 主动提问面板（ask_user 工具）——正在等待回答的批次
    // （当前题 + 已收集答案）+ 提交/取消。
    askSession,
    answerAsk,
    cancelAsk,
    // 补刀·五十六: hermes ACP 权限审批面板——待决请求 + 批准/拒绝回包。
    pendingHermesPermission,
    answerHermesPermission,
    // M2-T8: 主 agent 审批面板（ConfirmApprovalPanel）——待决确认 + 回包。
    pendingConfirm,
    answerConfirm,
    // M2-T8: core 引擎的 /mode 选择窗选中回调（写 SafetySettings）。
    pickCoreApprovalMode,
    // 进化 B 案: AI 反思建议确认面板——待确认建议 + 逐条确认/整体忽略。
    pendingSuggestions,
    approveSuggestion,
    dismissSuggestions,
    // Hermes 性能：后台预热连接+项目会话（幂等）——Composer 输入时触发。
    warmupHermes: warmupNow,
    // 补刀·五十七: hermes 技能清单与刷新入口（// 面板数据面）。
    hermesSkills,
    refreshHermesSkills,
  }
}

/** The full agent API surface — what AgentBridge publishes (追加⑰). */
export type AgentApi = ReturnType<typeof useAgent>
