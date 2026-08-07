import { Plugin, Platform, TAbstractFile, WorkspaceLeaf, addIcon, normalizePath, Notice } from 'obsidian'
import type { Root } from 'react-dom/client'
import { AgentBridge } from './components/chat-view/agentBridge'
import { mountAgentHost } from './components/chat-view/AgentHost'
import { ChatView } from './components/chat-view/ChatView'
import { ConfirmRequest } from './core/agent/types'
import { createConfirm } from './core/agent/ConfirmModal'
import { ToolRegistry } from './core/agent/ToolRegistry'
import { UndoStack } from './core/agent/UndoStack'
import { BUILTIN_SKILLS } from './core/skills/builtin'
import { SkillRegistry } from './core/skills/SkillRegistry'
import { loadUserSkills, skillsFolder } from './core/skills/skillLoader'
import { seedSetCoverSkill } from './core/skills/set-cover-skill'
import { AgentRegistry, HERMES_AGENT_NAME } from './core/agents/agentDef'
import { agentsFolder, loadAgentDefs } from './core/agents/agentLoader'
import { SettingTab } from './settings/SettingTab'
import {
  DEFAULT_SETTINGS,
  ObsidianAISettings,
  OFFICIAL_MCP_SERVICES,
  adoptOfficialMcpServices,
  cloneSettings,
  mergeSettingsForSave,
  migrateLlmBlock,
  migrateLlmVendors,
  migrateImageVendors,
  mergeImageVendorsIntoLlm,
  migrateRetrievalEmbeddingIntoLlm,
  migrateSafetyApprovalMode,
  resolveEmbeddingModel,
} from './settings/settings'
import { registerAllTools } from './tools'
import { syncMcpTools } from './core/mcp/mcpManager'
import { disposeHermesHub } from './core/hermes/hermesHub'
import { warmupHermesNow } from './core/hermes/warmup'
import { getRetrievalIndexer, initRetrievalIndexer } from './core/retrieval/indexer'
import { effectiveExclusions } from './utils/exclusions'
import { normalizeAiFolder } from './utils/conversationStore'
import {
  applyLimits,
  loadUndoStore,
  saveUndoStore,
} from './utils/undoStore'
import type { UndoData } from './utils/undoStore'
import { revertSnapshot } from './tools/util'
import {
  LEGACY_AI_FOLDER,
  ensureBrainFiles,
  evolveAgentsLayout,
  migrateLegacyFolder,
} from './utils/evolutionSetup'
import { DEFAULT_AI_FOLDER } from './utils/memoryStore'
import { buildSelectionRef } from './utils/selectionRef'
import type { SelectionFallback } from './utils/selectionRef'
import { pathExists, writeText } from './utils/vaultIO'
import { bootLog, lastUnloadMark, markUnload, readBootLog } from './utils/bootLog'
import {
  clearDiagnosticLog as clearDiagLog,
  diagnosticsEnabled,
  dlog,
  flushDiagBuffer,
  readDiagnosticLog,
  setDiagnostics,
} from './utils/diagnosticLog'
import { ICON_NAME, ICON_SVG, PLUGIN_NAME, VIEW_TYPE_CHAT } from './constants'

// Module-level references to the global safety-net handlers (注册于 onload,
// 清理于 this.register). Obsidian caches the plugin module across a
// disable→enable cycle, so a SECOND onload must remove the previous
// instance's handlers before adding fresh ones — otherwise the listeners
// stack (and a stale closure can outlive its plugin instance). Keeping the
// references here (instead of on the plugin instance) makes the pair
// idempotent across reloads: exactly one `error` + one `unhandledrejection`
// listener is ever live, no matter how many times the plugin is reloaded.
let globalErrorHandler: ((e: ErrorEvent) => void) | null = null
let rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null
// Same module-caching rationale as the handler refs above: the heartbeat
// interval, the console.error hook and the heartbeat-cleanup registration
// must be singleton-per-webview. A cached module would otherwise stack one
// more of each per reload.
let heartbeatTimer: number | null = null
let consoleHookInstalled = false

// True when an error's stack traces back into THIS plugin's bundled code
// (source-mapped location "plugin:UNagent:NNN"). The safety-net
// listeners only intercept OUR OWN errors: a window-level listener sees
// EVERY plugin's and Obsidian core's errors too, and blanket
// preventDefault/console noise there would both mislead debugging (the
// [UNagent] prefix on foreign errors) and disturb Obsidian's own
// global error handling. Foreign errors are passed through untouched.
function errorIsOurs(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const stack = (err as Error).stack ?? ''
  return (
    stack.includes('plugin:UNagent') || stack.includes('UNagent:')
  )
}

/** Starter content for the "new skill template" command. */
const SKILL_TEMPLATE = `---
name: my-skill
description: 一句话说清何时使用这个技能（AI 靠这句话决定是否载入）
mode: lazy
emoji: 🧩
tools: [search_notes, read_note]
---

# 我的技能

【何时使用】
- 当用户要求……时

【步骤】
1. ……
2. ……

【注意】
- 技能文件是给 AI 看的纯文本操作指南，不含任何可执行代码。
`

export default class ObsidianAI extends Plugin {
  settings: ObsidianAISettings = DEFAULT_SETTINGS

  // Agent subsystems (initialized in onload).
  registry: ToolRegistry = ToolRegistry.getInstance()
  undoStack: UndoStack = new UndoStack()
  confirm: (request: ConfirmRequest) => Promise<boolean> = async () => false

  /** Builtin + user skills by name (user skills reload on vault changes). */
  skills: SkillRegistry = new SkillRegistry()

  /** Sub-agent persona defs by name (多 Agent 体系; reload on vault changes).
   *  Plain class like SkillRegistry — never the ToolRegistry singleton. */
  agents: AgentRegistry = new AgentRegistry()

  /**
   * The shared conversation agent's cross-root bridge (追加⑰). A hidden
   * React root owns useAgent() and publishes here; the chat panel AND the
   * editor inline box both bind to it, so inline chat continues the most
   * recent conversation instead of starting a new one.
   */
  agentBridge = new AgentBridge()
  private agentHostRoot: Root | null = null

  /** Focus-the-composer plumbing for the Alt+Z command (补刀·五十一). Each
   *  mounted Chat instance registers a handler under ITS OWN leaf — on iPad
   *  the drawer and a main-area tab coexist, and a single "last mount wins"
   *  handler focused the wrong instance. The command resolves the target
   *  leaf first and dispatches to that instance's handler. */
  private composerFocusHandlers = new Map<
    WorkspaceLeaf | null,
    (opts: { reference?: string }) => void
  >()
  private pendingComposerFocus: { reference?: string } | null = null

  /** 最近一次非空选区的缓存（追加70）。canvas 编辑节点里按 Option+Z 时，
   *  画布会在快捷键回调前把选区清掉——selectionchange 监听持续缓存最近
   *  选区，引用构建拿不到活选区时用它兜底。10s 内有效（防止引到陈年旧选）。 */
  private lastSelection: SelectionFallback | null = null

  /** Chat registers this so `focusAiComposer()` can focus + prefill the box.
   *  fn=null deregisters (on unmount). */
  setComposerFocusHandler(
    leaf: WorkspaceLeaf | null,
    fn: ((opts: { reference?: string }) => void) | null,
  ): void {
    if (fn) {
      this.composerFocusHandlers.set(leaf, fn)
      if (this.pendingComposerFocus) {
        const pending = this.pendingComposerFocus
        this.pendingComposerFocus = null
        fn(pending)
      }
    } else {
      this.composerFocusHandlers.delete(leaf)
    }
  }

  private settingsListeners = new Set<
    (settings: ObsidianAISettings) => void
  >()

  /** 追加㊹：loadSettings 完成时的深拷贝——saveSettings 按块合并的基准。 */
  private settingsSnapshot: ObsidianAISettings | null = null

  /** Register a listener notified on every settings change; returns unsub. */
  addSettingsChangeListener(
    listener: (settings: ObsidianAISettings) => void,
  ): () => void {
    this.settingsListeners.add(listener)
    return () => {
      this.settingsListeners.delete(listener)
    }
  }

  /** 追加89: 数据层（技能 / 子代理注册表）热重载通知。注册表是原地替换
   *  内容、引用不变——依赖它的 React memo 不会自己重算；订阅方拿到通知
   *  后用自己的 tick state 驱动重算（useAgent 的 agents 列表、Composer 的
   *  // 技能列表、ReferenceText 的技能名门控）。 */
  private dataListeners = new Set<() => void>()

  /** Register a listener notified after skills/agents reload; returns unsub. */
  addDataChangeListener(listener: () => void): () => void {
    this.dataListeners.add(listener)
    return () => {
      this.dataListeners.delete(listener)
    }
  }

  private notifyDataChange(): void {
    for (const listener of this.dataListeners) listener()
  }

  /** 追加89: 按需重扫节流闸——picker 打开时 poke，2s 内最多一次。 */
  private lastDataPoke = 0

  /**
   * 追加89: 按需重扫技能 / 子代理文件夹（节流 2s）。兜底 vault 事件盲区：
   * 点开头数据文件夹内的改动不发事件、外部静默改动（同步工具直写磁盘）。
   * 复用 schedule* 的 400ms 防抖，与事件驱动路径合流，不会重复扫描。
   */
  pokeDataReload(): void {
    const now = Date.now()
    if (now - this.lastDataPoke < 2000) return
    this.lastDataPoke = now
    this.scheduleUserSkillsReload()
    this.scheduleUserAgentsReload()
  }

  async onload(): Promise<void> {
    // The entire onload is wrapped in try-catch: if ANY initialization step
    // throws, Obsidian would otherwise reject the onload promise and mark
    // the plugin as disabled in community-plugins.json. On mobile (iOS
    // WKWebView), iCloud sync corruption, React root creation failures, and
    // resource pressure can all cause intermittent crashes. We log the error
    // but NEVER rethrow — a degraded plugin is always better than a disabled
    // one. The user can still open settings and reconfigure.
    try {
      // The previous instance's lastUnloadMark tells us whether its onunload
      // actually ran (the async boot-log line can lose the race when the
      // webview is hard-killed; localStorage is synchronous and survives).
      await bootLog(
        this.app,
        `onload:start prev-unload-mark=${lastUnloadMark() || 'none'}`,
      )
      // Android-only auto-disable hunt: the WebView flavor matters (missing
      // APIs behave per Chromium version), so record it once per boot.
      await bootLog(
        this.app,
        `diag:ua ${navigator.userAgent.slice(0, 140)}`,
      )
      // Global safety net: catch THIS plugin's errors that escape the
      // try-catch below — primarily unhandled promise rejections from React
      // 18's async render and from fire-and-forget async operations. Only
      // errors whose stack traces into our bundle are intercepted (see
      // errorIsOurs); errors from Obsidian core or other plugins pass
      // through untouched so Obsidian's own error detection keeps working.
      // Idempotent registration: on a module-cached reload the previous
      // instance's handlers may still be attached (their unload cleanup is
      // what sets the module-level refs back to null) — remove first, then
      // add, so exactly ONE pair is ever live and no stale closure survives.
      // DIAGNOSTIC ROUND: log EVERY error/rejection, not just ours. The
      // Android-only auto-disable showed zero diag lines, almost certainly
      // because errorIsOurs() matches on 'plugin:UNagent' in the stack —
      // a URL scheme the Android WebView likely never produces, so real
      // crashes were misfiled as foreign and skipped. preventDefault still
      // applies only to confirmed-ours errors.
      const stackHint = (err: unknown): string => {
        const stack = (err as Error)?.stack ?? ''
        const line = stack.split('\n').slice(1, 3).join(' | ')
        return line.slice(0, 140)
      }
      const errorListener = (e: ErrorEvent): void => {
        const msg = String((e.error as Error)?.message ?? e.message)
        void bootLog(
          this.app,
          `diag:uncaught-error ${msg.slice(0, 240)} :: ${stackHint(e.error)}`,
        )
        dlog('error', 'uncaught', `${msg.slice(0, 240)} :: ${stackHint(e.error)}`)
        if (!errorIsOurs(e.error ?? e.message)) return
        console.error('[UNagent] Uncaught error:', e.error ?? e.message)
        e.preventDefault()
      }
      const rejectionListener = (e: PromiseRejectionEvent): void => {
        const msg = String((e.reason as Error)?.message ?? e.reason)
        void bootLog(
          this.app,
          `diag:unhandled-rejection ${msg.slice(0, 240)} :: ${stackHint(e.reason)}`,
        )
        dlog('error', 'rejection', `${msg.slice(0, 240)} :: ${stackHint(e.reason)}`)
        if (!errorIsOurs(e.reason)) return
        console.error('[UNagent] Unhandled rejection:', e.reason)
        e.preventDefault()
      }
      // beforeunload fires SYNCHRONOUSLY when the webview goes down — the
      // reliable proof of teardown (async boot-log writes and even the
      // localStorage mark can be cut off; this lands in the same tick).
      const beforeUnloadListener = (): void => {
        void bootLog(this.app, 'diag:beforeunload')
      }
      window.addEventListener('beforeunload', beforeUnloadListener)
      // React render errors never reach the window 'error' event (the
      // ErrorBoundary catches them and React logs via console.error), so hook
      // console.error too: any [UNagent] line gets a durable copy on
      // disk. Module-level singleton — survives disable→enable cycles.
      if (!consoleHookInstalled) {
        consoleHookInstalled = true
        const origConsoleError = console.error.bind(console)
        console.error = (...args: unknown[]) => {
          origConsoleError(...args)
          try {
            const text = args
              .map((a) => (a instanceof Error ? a.message : String(a)))
              .join(' ')
            if (text.includes('[UNagent]')) {
              void bootLog(this.app, `diag:console ${text.slice(0, 300)}`)
              // Same convention flows into the opt-in diagnostic log, so
              // every console.error('[UNagent] ...') — present or future
              // code — is captured without per-site changes.
              dlog('error', 'console', text.slice(0, 300))
            }
          } catch {
            // Never break logging.
          }
        }
      }
      if (globalErrorHandler) {
        window.removeEventListener('error', globalErrorHandler)
      }
      if (rejectionHandler) {
        window.removeEventListener('unhandledrejection', rejectionHandler)
      }
      globalErrorHandler = errorListener
      rejectionHandler = rejectionListener
      window.addEventListener('error', errorListener)
      window.addEventListener('unhandledrejection', rejectionListener)
      this.register(() => {
        window.removeEventListener('error', errorListener)
        window.removeEventListener('unhandledrejection', rejectionListener)
        window.removeEventListener('beforeunload', beforeUnloadListener)
        // Only clear the module refs if they still point at THIS instance's
        // handlers (a newer load may have replaced them already).
        if (globalErrorHandler === errorListener) globalErrorHandler = null
        if (rejectionHandler === rejectionListener) rejectionHandler = null
        markUnload() // synchronous flag: did onunload actually run?
      })
      this.register(() => {
        // The heartbeat is module-level (single interval per webview); the
        // first instance to unload clears it, and any later onload restarts
        // it via startHeartbeat().
        if (heartbeatTimer !== null) {
          window.clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
      })

      await bootLog(this.app, 'onload:before-loadSettings')
      await this.loadSettings()
      await bootLog(this.app, 'onload:after-loadSettings')

      // Opt-in diagnostic log (诊断日志): starts DISABLED (complete no-op) and
      // only records when the user flips the settings switch. The listener
      // covers every source of settings changes (settings tab now, any future
      // entry point later); flipping ON writes a session header line.
      setDiagnostics(this.app, this.settings.general.diagnostics)
      if (diagnosticsEnabled()) this.diagSessionHeader()
      this.addSettingsChangeListener((settings) => {
        const on = settings.general.diagnostics
        if (on !== diagnosticsEnabled()) {
          setDiagnostics(this.app, on)
          if (on) this.diagSessionHeader()
        }
      })

      // 追加89: 数据文件夹改动即时生效——技能 / 子代理的路径都派生自
      // aiFolder，旧实现只在 onload 扫一次，设置页只好写「重新打开对话
      // 视图后生效」。现在设置一提交就重扫两个注册表（对话列表那半边由
      // useAgent 自己的 settings 监听刷新）。
      let lastAiFolder = normalizeAiFolder(this.settings.general.aiFolder)
      this.addSettingsChangeListener((settings) => {
        const next = normalizeAiFolder(settings.general.aiFolder)
        if (next === lastAiFolder) return
        lastAiFolder = next
        void this.reloadUserSkills()
        void this.reloadUserAgents()
      })

      // Storage evolution (追加⑲): move legacy hidden `.obsidian-ai/` data into
    // the visible AI 助手 folder and seed the brain files. Awaited so the
    // chat view's boot-time conversation restore always sees the final
    // locations. Best-effort — a failure never blocks the plugin.
    await bootLog(this.app, 'onload:before-evolveStorage')
    await this.evolveStorage()
    await bootLog(this.app, 'onload:after-evolveStorage')
    
    // Undo stack persistence (Task #8): hydrate AFTER evolveStorage (the
    // undo.json store may have just moved with the data-folder migration)
    // and BEFORE registerView (a boot-restored conversation can immediately
    // use the undo stack). Both steps are best-effort — wrapped in
    // try/catch so a failure NEVER blocks plugin startup.
    await bootLog(this.app, 'onload:before-undoHydrate')
    try {
      const entries = await loadUndoStore(
        this.app,
        normalizeAiFolder(this.settings.general.aiFolder),
      )
      this.undoStack.hydrate(entries, (data) => this.rebuildUndoRevert(data))
    } catch {
      // Best-effort: undo is optional; a failed hydrate must not block boot.
    }
    try {
      this.undoStack.setPersist(async (entries) => {
        // aiFolder is read LIVE from settings — the user may change the
        // data folder at any time, and the store must follow.
        await saveUndoStore(
          this.app,
          normalizeAiFolder(this.settings.general.aiFolder),
          applyLimits(entries),
        )
      })
    } catch {
      // Same as above: silent degradation.
    }
    await bootLog(this.app, 'onload:after-undoHydrate')
    
    // Register the custom ribbon icon. ICON_SVG is a full <svg> carrying its
    // own viewBox="0 0 24 24" — the version-proof fix for the top-left
    // collapse. The size arg is belt-and-suspenders for builds that honor
    // addIcon's third parameter; the installed typings predate it, hence the
    // cast (same lag pattern as the vault config access, HANDOFF 坑⑦).
    ;(
      addIcon as (iconId: string, svgContent: string, size?: number) => void
    )(ICON_NAME, ICON_SVG, 24)

    // Agent subsystems: register the v1 note tools and wire confirmations.
    this.registry = registerAllTools()
    this.confirm = createConfirm(this.app)
    // Remote MCP tools (streamableHttp only): register from the CACHED tool
    // metadata persisted in settings — zero network at boot; a failure never
    // blocks startup. Refresh happens explicitly from the settings UI.
    try {
      syncMcpTools(this.registry, this.settings.mcp.services)
    } catch (err) {
      console.error('[UNagent] syncMcpTools failed:', err)
    }
    // Retrieval (混合检索): wire the indexer singleton to live settings.
    // ZERO network at boot — the first incremental sync is deferred 5s below
    // and re-checks the channel switch, so an unconfigured install costs
    // nothing. The AI data folder is ALWAYS excluded from indexing.
    initRetrievalIndexer({
      app: this.app,
      getEmbedConfig: () => {
        // embedding 模型并入统一厂商体系（与视觉/生图同款）：从 llm.vendors
        // 解析「默认检索模型」；retrieval 块只剩总开关。
        const emb = resolveEmbeddingModel(this.settings.llm)
        if (!emb) {
          return {
            enabled: false,
            baseUrl: '',
            apiKey: '',
            model: '',
          }
        }
        return {
          enabled: this.settings.retrieval.semanticEnabled,
          baseUrl: emb.baseUrl,
          apiKey: emb.apiKey,
          model: emb.model,
        }
      },
      getAiFolder: () => normalizeAiFolder(this.settings.general.aiFolder),
      getExcludedFolders: () =>
        effectiveExclusions(
          this.app,
          this.settings.general.excludedFolders,
          [normalizeAiFolder(this.settings.general.aiFolder)],
        ),
    })
    this.retrievalBootTimer = window.setTimeout(() => {
      this.retrievalBootTimer = null
      const indexer = getRetrievalIndexer()
      if (indexer?.channelReady()) {
        void indexer.syncNow().catch((err) => {
          console.error('[UNagent] retrieval boot sync failed:', err)
        })
      }
    }, 5000)
    await bootLog(this.app, 'onload:tools-registered')

    // Skills: official builtins register synchronously; user skills load
    // asynchronously from the vault and hot-reload on file changes (#29).
    this.skills.registerAll(BUILTIN_SKILLS)
    void this.reloadUserSkills()

    // Sub-agents (多 Agent 体系): persona notes under <aiFolder>/agents/ —
    // same hot-reload discipline as user skills (no builtin seeding: the
    // agent-creator skill / manual notes are the only writers, 追加76).
    void this.reloadUserAgents()

    const scheduleIfDataFile = (file: TAbstractFile): void => {
      if (this.isUnderSkillsFolder(file)) this.scheduleUserSkillsReload()
      if (this.isUnderAgentsFolder(file)) this.scheduleUserAgentsReload()
    }
    // Retrieval: any markdown change may invalidate the vector index. Just
    // mark dirty + schedule a debounced incremental sync (single-flight
    // inside the indexer); the actual embedding work checks the channel
    // switch and API key before spending anything.
    const scheduleRetrievalResync = (file: TAbstractFile): void => {
      if (!file.path.endsWith('.md')) return
      getRetrievalIndexer()?.markDirty()
      if (this.retrievalResyncTimer !== null) {
        window.clearTimeout(this.retrievalResyncTimer)
      }
      this.retrievalResyncTimer = window.setTimeout(() => {
        this.retrievalResyncTimer = null
        const indexer = getRetrievalIndexer()
        if (indexer?.channelReady()) {
          void indexer.syncNow().catch((err) => {
            console.error('[UNagent] retrieval resync failed:', err)
          })
        }
      }, 2000)
    }
    this.registerEvent(this.app.vault.on('create', scheduleIfDataFile))
    this.registerEvent(this.app.vault.on('modify', scheduleIfDataFile))
    this.registerEvent(this.app.vault.on('delete', scheduleIfDataFile))
    this.registerEvent(this.app.vault.on('rename', scheduleIfDataFile))
    this.registerEvent(this.app.vault.on('create', scheduleRetrievalResync))
    this.registerEvent(this.app.vault.on('modify', scheduleRetrievalResync))
    this.registerEvent(this.app.vault.on('delete', scheduleRetrievalResync))
    this.registerEvent(this.app.vault.on('rename', scheduleRetrievalResync))

    // Unload the debounced reload timers with the plugin. Without this, a
    // pending timer fires after unload and touches a torn-down instance
    // (harmless today, but it keeps the reload path leak-free on the mobile
    // repeated-reload cycle — one less accumulated async task per reload).
    this.register(() => {
      if (this.userSkillsReloadTimer !== null) {
        window.clearTimeout(this.userSkillsReloadTimer)
        this.userSkillsReloadTimer = null
      }
      if (this.userAgentsReloadTimer !== null) {
        window.clearTimeout(this.userAgentsReloadTimer)
        this.userAgentsReloadTimer = null
      }
      if (this.retrievalResyncTimer !== null) {
        window.clearTimeout(this.retrievalResyncTimer)
        this.retrievalResyncTimer = null
      }
      if (this.retrievalBootTimer !== null) {
        window.clearTimeout(this.retrievalBootTimer)
        this.retrievalBootTimer = null
      }
    })

    await bootLog(this.app, 'onload:before-registerView')
    this.registerView(
      VIEW_TYPE_CHAT,
      (leaf: WorkspaceLeaf) => new ChatView(leaf, this),
    )
    await bootLog(this.app, 'onload:view-registered')

    // 追加84: 把「UNagent」注册为 Page Preview 的 hover-link 源
    // （defaultMod: false）。不注册时 source 查无此名，官方处理器落回
    // h=true 的「等修饰键」分支——悬停后挂一圈 keydown/mouseover 监视，
    // 鼠标一挪进弹窗就当作离开把窗杀掉（用户报的「command 下预览渲染
    // 崩溃」）。注册后普通悬停直接弹、按住 Cmd 立即弹，语义与聊天外笔记
    // 一致；也允许用户在 设置→核心插件→页面预览 里单独为我们调修饰键。
    // 老构建没有此 API 时 optional call 静默降级（坑⑦模式）。
    ;(
      this.app.workspace as unknown as {
        registerHoverLinkSource?: (
          id: string,
          info: { display: string; defaultMod: boolean },
        ) => void
      }
    ).registerHoverLinkSource?.('UNagent', {
      display: PLUGIN_NAME,
      defaultMod: false,
    })

    // Hidden agent host (追加⑰): one React root, never displayed, owning the
    // single conversation agent so the inline editor box and the chat panel
    // share it. Unmounts with the plugin (this.register).
    // Wrapped in try-catch: on mobile WKWebView, createRoot or the initial
    // render can fail intermittently (resource pressure, timing). Without
    // this guard the error propagates to Obsidian's onload handler, which
    // disables the plugin. A failed host means the chat shows "加载中…"
    // indefinitely — degraded but not dead.
    await bootLog(this.app, 'onload:before-agentHost')
    try {
      this.agentHostRoot = mountAgentHost(this, this.agentBridge)
    } catch (err) {
      console.error('[UNagent] Agent host mount failed:', err)
    }
    await bootLog(this.app, 'onload:after-agentHost')
    this.register(() => {
      this.agentHostRoot?.unmount()
      this.agentHostRoot = null
    })

    // Hermes 连接预热（性能优化 2026-08-07）：重启后立即在后台拉起 hermes
    // 进程 + 项目会话 + 预备 fork（hermes 侧 session/new 固有 3.7-9.9s +
    // fork 2.2s，插件侧无法缩短）——首次发送时直接命中预备子会话，不再干
    // 等。fire-and-forget：失败静默（正式发送路径会再试并给出用户可见错
    // 误）；门控内置：localAgent 未启用 / 移动端 / 无本地路径零成本跳过。
    // 补刀·六十：启动预热受 autoWarmup 开关控制（设置 → Hermes）——关闭后
    // 重启不再自动连接（状态灯保持灰色），切入 Hermes 模式/打开 hermes 会话/
    // Composer 输入等交互触发的预热不受影响（按需连接）。旧 data.json 无此键
    // （undefined）按开处理，保持既有行为。
    if (this.settings.localAgent.autoWarmup !== false) {
      warmupHermesNow(this)
    }

    this.addRibbonIcon(ICON_NAME, `Open ${PLUGIN_NAME}`, () => {
      void this.activateChatView()
    })

    this.addCommand({
      id: 'open-chat',
      name: `Open ${PLUGIN_NAME} chat`,
      callback: () => {
        void this.activateChatView()
      },
    })

    this.addCommand({
      id: 'open-chat-main',
      name: `Open ${PLUGIN_NAME} chat in main window (在主窗口打开)`,
      // The regular open-chat command opens in the sidebar (right leaf).
      // This one opens the chat as a tab in the main editor area instead —
      // for users who want it alongside their notes, not pinned to a side.
      callback: () => {
        void this.activateChatInMain()
      },
    })

    this.addCommand({
      id: 'undo-last-tool',
      name: 'Undo last note change',
      callback: () => {
        void this.undoStack.undoLast()
      },
    })

    this.addCommand({
      id: 'create-skill-template',
      name: 'Create skill template (新建技能模板)',
      callback: () => {
        void this.createSkillTemplate()
      },
    })

    this.addCommand({
      id: 'export-boot-log',
      name: 'Export startup diagnostics (导出启动诊断日志)',
      // Diagnostic aid for the mobile auto-disable bug: dumps the on-disk
      // boot breadcrumb log to a VISIBLE note so it can be read on a phone
      // (where a debugger is impractical). Run it after re-enabling the
      // plugin post-disable — the last phase in the log is the crash point.
      callback: () => {
        void this.exportBootLog()
      },
    })

    this.addCommand({
      id: 'quote-selection',
      name: '引用选中文字到 AI 输入框 (Quote selection to AI input)',
      // 引用功能的官方命令（追加69）：默认 Option+Z，用户可在 设置 →
      // 快捷键 里搜「引用」自定义或移除。行为 = 聚焦 AI 输入框，有选中
      // 文字时一并插入 [[来源]]「…」引用（画布节点/表格行/memos 均支持）。
      hotkeys: [{ modifiers: ['Alt'], key: 'Z' }],
      callback: () => {
        this.focusAiComposer()
      },
    })

    // 选区缓存（追加70）：canvas 编辑节点里按快捷键时活选区已被画布清掉，
    // 靠 selectionchange 滚动缓存最近一次非空选区兜底。registerDomEvent
    // 自动随插件卸载清理。
    this.registerDomEvent(document, 'selectionchange', () => {
      const sel = window.getSelection?.()
      if (!sel || sel.isCollapsed) return
      const raw = sel.toString()
      if (!raw.trim()) return
      const node = sel.anchorNode
      const el =
        node && node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node?.parentElement ?? null
      this.lastSelection = { raw, el, at: Date.now() }
    })

    this.addCommand({
      id: 'focus-ai-editor',
      name: '聚焦 AI 输入框 (Focus AI input)',
      // 历史命令，保留兼容旧绑定；默认快捷键已移交给 quote-selection
      // （追加69）——行为完全一致：无选中纯聚焦，有选中带引用。
      callback: () => {
        this.focusAiComposer()
      },
    })

    // 补刀·五十七: 命令面板同效命令——主对话 ⇄ Hermes 模式一键切换，
    // 与聊天里的 /hermes-mode 斜杠命令、头部模式 pill 同效果，可绑快捷键。
    // 切换 = 新建该模式的全新会话（/new 语义，两套上下文彻底分离）。
    this.addCommand({
      id: 'toggle-hermes-mode',
      name: '切换 Hermes 模式 (Toggle Hermes mode)',
      callback: () => {
        if (Platform.isMobile) return
        const api = this.agentBridge.getSnapshot()
        if (api?.toggleHermesMode) api.toggleHermesMode()
      },
    })

      this.addSettingTab(new SettingTab(this.app, this))
      await bootLog(this.app, 'onload:complete')
      dlog('info', 'lifecycle', `onload complete · plugin=${this.manifest.version}`)
      this.startHeartbeat()
    } catch (err) {
      // Last-resort safety net: log but never rethrow. If onload rejects,
      // Obsidian disables the plugin — the exact bug we're fixing.
      console.error('[UNagent] onload crashed (plugin stays enabled):', err)
      void bootLog(
        this.app,
        `onload:CRASH ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async onunload(): Promise<void> {
    // Views are detached automatically by Obsidian.
    markUnload()
    void bootLog(this.app, 'onunload')
    dlog('info', 'lifecycle', 'onunload')
    // 补刀·五十六: kill the hermes acp process (if any).
    disposeHermesHub()
    // Land whatever is buffered so an app quit loses no recorded lines.
    void flushDiagBuffer()
  }

  /** Post-onload heartbeat: one 'alive:NNs' line every 5s after a clean
   *  boot. The mobile auto-disable crash happens AFTER onload:complete (the
   *  exported log proved every phase succeeded), so the LAST heartbeat +
   *  any diag:* lines locate the moment and cause of death. 5s interval
   *  (tighter than 10s) because the Android log showed death inside the
   *  first 10s. Module-level singleton: exactly one interval per webview. */
  private startHeartbeat(): void {
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
    let seconds = 0
    heartbeatTimer = window.setInterval(() => {
      seconds += 5
      void bootLog(this.app, `alive:${seconds}s`)
    }, 5000)
  }

  /**
   * Focus the AI chat's input box (补刀·五十一). Option+Z now jumps to the
   * chat composer — the inline editor box is gone (it fought Obsidian's
   * rendered blocks — callouts/tables/math — and was never reliable, so it was
   * removed entirely). With an active selection a `[[note]]「选中」` reference is
   * inserted into the input too (用户指示: 有选中则带引用并聚焦). MAIN-area
   * instance wins over the sidebar one (用户指示: 有主窗口的聚焦主窗口，没有
   * 主窗口才落侧边栏) — the old sidebar-first order made Option+Z jump to the
   * drawer on iPad even when a main-area chat tab was open.
   */
  private focusAiComposer(): void {
    // The ref build is async now (追加68: memos/canvas 反查要读画布 JSON)——
    // await it BEFORE resolving the target leaf so the reference is ready
    // when the composer receives the focus request.
    const cached = this.lastSelection
    const fallback =
      cached && Date.now() - cached.at < 10_000 ? cached : undefined
    void buildSelectionRef(this.app, fallback)
      .then((reference) => {
        const request = { reference: reference || undefined }
        // Resolve the target leaf FIRST, then dispatch the focus request to
        // exactly that instance — otherwise the coexisting drawer/main-tab
        // instance steals the focus (the iPad "跳进侧边栏" second half).
        return this.activateChatViewForFocus().then((target) => {
          const handler =
            (target ? this.composerFocusHandlers.get(target) : undefined) ??
            this.composerFocusHandlers.values().next().value
          if (handler) {
            handler(request)
          } else {
            // The view is still mounting — Chat consumes this on registration.
            this.pendingComposerFocus = request
          }
        })
      })
      .catch((err) => {
        // 追加69: 之前 promise 一 reject 整条链静默死掉——canvas/表格引用失败
        // 时用户看到的就是"按了没反应"。追加70: 失败直接 Notice，看得见。
        console.error('[UNagent] 引用选中文字失败:', err)
        new Notice(
          `引用失败：${err instanceof Error ? err.message : String(err)}`,
        )
      })
  }

  /** Reveal the chat view — preferring the sidebar instance over one open on
   *  another page (用户指示). Used by the ribbon icon / open-chat command. */
  private async activateChatView(): Promise<void> {
    try {
      const { workspace } = this.app
      const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT)
      const rightSplit = (
        workspace as unknown as { rightSplit?: unknown }
      ).rightSplit
      const inSidebar = (l: WorkspaceLeaf) =>
        rightSplit != null && l.getRoot() === rightSplit
      const target =
        leaves.find(inSidebar) ?? leaves.find((l) => !inSidebar(l))
      if (target) {
        await workspace.revealLeaf(target)
        return
      }
      const leaf = workspace.getRightLeaf(false)
      if (!leaf) return
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true })
      await workspace.revealLeaf(leaf)
    } catch (err) {
      // Workspace can be mid-layout on mobile, or the leaf closes between the
      // get and the await. Callers fire-and-forget (void), so a rejection
      // here becomes an UNHANDLED rejection — Obsidian's own listeners still
      // see it (preventDefault only stops the default action) and it can get
      // the plugin disabled on mobile. Swallow and log instead.
      console.error('[UNagent] activateChatView failed:', err)
    }
  }

  /**
   * Reveal the chat view for Option+Z focus — MAIN-area instance first, then
   * sidebar, then create in the sidebar (用户指示: 有主窗口聚焦主窗口，没有
   * 主窗口才用侧边栏). On iPad the drawer sidebar instance usually exists
   * alongside a main-area tab, and the old sidebar-first order always won —
   * hence the shortcut appeared to "跳进侧边栏".
   */
  private async activateChatViewForFocus(): Promise<WorkspaceLeaf | null> {
    try {
      const { workspace } = this.app
      const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT)
      const leftSplit = (workspace as unknown as { leftSplit?: unknown })
        .leftSplit
      const rightSplit = (workspace as unknown as { rightSplit?: unknown })
        .rightSplit
      const inSidebar = (l: WorkspaceLeaf): boolean =>
        (leftSplit != null && l.getRoot() === leftSplit) ||
        (rightSplit != null && l.getRoot() === rightSplit)
      const target =
        leaves.find((l) => !inSidebar(l)) ?? leaves.find(inSidebar)
      if (target) {
        await workspace.revealLeaf(target)
        return target
      }
      const leaf = workspace.getRightLeaf(false)
      if (!leaf) return null
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true })
      await workspace.revealLeaf(leaf)
      return leaf
    } catch (err) {
      // Same rationale as activateChatView: fire-and-forget from a command
      // handler — never let a rejection escape to Obsidian's loader.
      console.error('[UNagent] activateChatViewForFocus failed:', err)
      return null
    }
  }

  /** Open the chat in the MAIN editor area (a real tab alongside notes),
   *  instead of the sidebar. Reuses an existing main-area chat leaf if there
   *  is one; otherwise opens a fresh tab via getLeaf(true). */
  private async activateChatInMain(): Promise<void> {
    try {
      const { workspace } = this.app
      const leftSplit = (workspace as unknown as { leftSplit?: unknown })
        .leftSplit
      const rightSplit = (workspace as unknown as { rightSplit?: unknown })
        .rightSplit
      const inSidebar = (l: WorkspaceLeaf): boolean =>
        (leftSplit != null && l.getRoot() === leftSplit) ||
        (rightSplit != null && l.getRoot() === rightSplit)
      // Reuse an existing chat leaf that's already in the main area (or a
      // popout/floating window — anything that isn't a sidebar).
      const existing = workspace
        .getLeavesOfType(VIEW_TYPE_CHAT)
        .find((l) => !inSidebar(l))
      if (existing) {
        await workspace.revealLeaf(existing)
        return
      }
      // No main-area instance yet — open a new tab in the main editor area.
      const leaf = workspace.getLeaf(true)
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true })
      await workspace.revealLeaf(leaf)
    } catch (err) {
      // Same rationale as activateChatView: this is fire-and-forget from the
      // command handler — never let a rejection escape to Obsidian's loader.
      console.error('[UNagent] activateChatInMain failed:', err)
    }
  }

  /**
   * Jump to this plugin's settings tab. Backed by the plugin's own /settings
   * command (not an Obsidian palette command, 追加⑪ 补刀).
   *
   * Two-step, order matters:
   *   1. Open the Settings modal via the built-in `app:open-settings` command.
   *      This is the proven-reliable way to open + initialize the modal on
   *      every platform (it's a no-op if already open). Crucially, on this
   *      user's Obsidian build `app.setting.openTabById` exists but does NOT
   *      open the modal by itself — calling it on a closed modal is a silent
   *      no-op (the regression where /settings opened nothing).
   *   2. Switch to this plugin's tab with `app.setting.openTabById(pluginId)`
   *      — the same internal call Obsidian makes when you click a plugin's nav
   *      item. The modal's tabs are registered synchronously during open(), so
   *      this is safe to call immediately after step 1. No DOM scraping, works
   *      on desktop + mobile.
   * Falls back to a DOM nav-item click only for builds lacking openTabById.
   */
  openSettingsTab(): void {
    const app = this.app as unknown as {
      setting?: { openTabById?: (id: string) => void }
      commands?: { executeCommandById?: (id: string) => boolean | void }
    }
    // Step 1: open the Settings modal (no-op if already open). The modal's
    // content + tab registry are built synchronously inside open().
    app.commands?.executeCommandById?.('app:open-settings')
    // Step 2: switch to this plugin's tab by id.
    if (app.setting?.openTabById) {
      app.setting.openTabById(this.manifest.id)
      return
    }
    // Fallback (builds without openTabById): the modal is already open from
    // step 1 — click this plugin's nav item once it renders.
    this.navigateToPluginSettingsNav()
  }

  /** Click this plugin's settings sidebar item once the modal renders (poll up
   *  to ~800 ms, then give up). Same-tab re-click is harmless. */
  private navigateToPluginSettingsNav(): void {
    let attempts = 0
    const tryClick = (): void => {
      attempts++
      // Desktop → .vertical-tab-nav-item; mobile (tab-style) → .tree-item
      const items = document.querySelectorAll<HTMLElement>(
        '.vertical-tab-nav-item, .tree-item',
      )
      for (const el of items) {
        if (el.textContent?.includes(PLUGIN_NAME)) {
          el.click()
          return
        }
      }
      if (attempts < 10) window.setTimeout(tryClick, 80)
    }
    window.setTimeout(tryClick, 60)
  }

  private userSkillsReloadTimer: number | null = null
  /** Debounced vector-index resync after vault markdown changes (2s). */
  private retrievalResyncTimer: number | null = null
  /** Deferred first incremental index sync after boot (5s). */
  private retrievalBootTimer: number | null = null

  /** Re-scan the vault's skill folder; replaces all user-source skills. */
  async reloadUserSkills(): Promise<void> {
    try {
      this.skills.removeBySource('user')
      const folder = skillsFolder(this.settings.general.aiFolder)
      if (!folder) {
        this.notifyDataChange()
        return
      }
      this.skills.registerAll(await loadUserSkills(this.app, folder))
      this.notifyDataChange()
    } catch {
      // Folder missing or unreadable — user skills are optional; stay quiet.
    }
  }

  /** Debounced reload — vault events fire in bursts (e.g. sync pulls). */
  private scheduleUserSkillsReload(): void {
    if (this.userSkillsReloadTimer !== null) {
      window.clearTimeout(this.userSkillsReloadTimer)
    }
    this.userSkillsReloadTimer = window.setTimeout(() => {
      this.userSkillsReloadTimer = null
      void this.reloadUserSkills()
    }, 400)
  }

  private isUnderSkillsFolder(file: TAbstractFile | null): boolean {
    const root = skillsFolder(this.settings.general.aiFolder)
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase()
    if (!root || !file) return false
    const path = file.path.toLowerCase()
    return path === root || path.startsWith(root + '/')
  }

  private userAgentsReloadTimer: number | null = null

  /** Re-scan <aiFolder>/agents/; replaces every sub-agent def (多 Agent 体系).
   *  Exposed on the plugin so the settings panel's 「重新载入」 can force it
   *  (the known fallback when folder events misbehave, skills 同款). */
  async reloadUserAgents(): Promise<void> {
    try {
      this.agents.clear()
      // 补刀·五十七: 内置 Hermes 代理先注册（「Hermes 模式」的切换目标）；
      // 用户自建同名代理随后覆盖它（user 优先）。
      this.registerBuiltinAgents()
      const folder = agentsFolder(this.settings.general.aiFolder)
      this.agents.registerAll(await loadAgentDefs(this.app, folder))
      this.notifyDataChange()
    } catch {
      // Folder missing or unreadable — sub-agents are optional; stay quiet.
    }
  }

  /** 补刀·五十七: 内置代理。Hermes = engine:hermes 的现成入口，桌面专属
   *  体验（移动端运行时会被友好拒绝）。人设随 hermes 交互会话首轮注入。 */
  private registerBuiltinAgents(): void {
    this.agents.register({
      name: HERMES_AGENT_NAME,
      emoji: '⚡',
      description: '对话直接由本机 Hermes 代理驱动（桌面专属）',
      engine: 'hermes',
      body:
        '你是 Hermes——运行在用户本机上的全能代理，当前工作目录是用户的 Obsidian 笔记库，你可以用自带的文件/终端/网络等工具直接操作。' +
        '用用户所用的语言回答；涉及库内笔记时先查看再动手。',
      source: 'builtin',
    })
  }

  /** Debounced reload — vault events fire in bursts (e.g. sync pulls). */
  private scheduleUserAgentsReload(): void {
    if (this.userAgentsReloadTimer !== null) {
      window.clearTimeout(this.userAgentsReloadTimer)
    }
    this.userAgentsReloadTimer = window.setTimeout(() => {
      this.userAgentsReloadTimer = null
      void this.reloadUserAgents()
    }, 400)
  }

  private isUnderAgentsFolder(file: TAbstractFile | null): boolean {
    const root = agentsFolder(this.settings.general.aiFolder).toLowerCase()
    if (!file) return false
    const path = file.path.toLowerCase()
    return path === root || path.startsWith(root + '/')
  }

  /** Write the on-disk boot breadcrumb log to a VISIBLE note and open it, so
   *  the startup-crash phase can be inspected on mobile (a debugger is
   *  impractical on a phone). The LAST line is the last phase reached before
   *  the crash — i.e. the crashing phase. See utils/bootLog.ts. */
  private async exportBootLog(): Promise<void> {
    try {
      const log = await readBootLog(this.app)
      const folder = normalizeAiFolder(this.settings.general.aiFolder)
      const path = normalizePath(`${folder}/启动诊断日志.md`)
      const body =
        '# 启动诊断日志\n\n最后一行 = 崩溃前最后到达的阶段（即崩溃点）。\n\n```\n' +
        (log || '（暂无记录）') +
        '\n```\n'
      await writeText(this.app, path, body)
      new Notice(`启动诊断日志已导出：${path}`)
      if (this.app.vault.getAbstractFileByPath(path)) {
        await this.app.workspace.openLinkText(path, '')
      }
    } catch (err) {
      new Notice(
        `导出启动诊断日志失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** One header line per enable-session: version/environment fingerprint so
   *  an exported log is self-describing (metadata only, never credentials). */
  private diagSessionHeader(): void {
    const obsidianVersion = (this.app as unknown as { version?: string })
      .version
    dlog(
      'info',
      'lifecycle',
      `diagnostics enabled · plugin=${this.manifest.version}` +
        ` obsidian=${obsidianVersion ?? '?'}` +
        ` ua=${navigator.userAgent.slice(0, 120)}`,
    )
  }

  /**
   * Export the opt-in diagnostic log: flush pending lines, write a VISIBLE
   * note under the data folder (self-describing header + privacy contract),
   * best-effort copy the same text to the clipboard, and open the note.
   * Public: the 通用 settings panel 「导出日志」 button calls this.
   */
  async exportDiagnosticLog(): Promise<void> {
    try {
      await flushDiagBuffer()
      const log = await readDiagnosticLog(this.app)
      const folder = normalizeAiFolder(this.settings.general.aiFolder)
      const path = normalizePath(`${folder}/诊断日志.md`)
      const body =
        '# 诊断日志\n\n' +
        `- 导出时间：${new Date().toLocaleString()}\n` +
        `- 插件版本：${this.manifest.version}\n` +
        `- 环境：${navigator.userAgent}\n\n` +
        '> 日志只记录插件运行活动（启动阶段、模型请求状态、工具调用结果、错误信息），' +
        '不包含 API 密钥、请求正文或笔记内容。请把整篇内容发给开发者排查问题。\n\n' +
        '```\n' +
        (log || '（暂无记录——请先开启「记录诊断日志」，复现问题后再导出）') +
        '\n```\n'
      await writeText(this.app, path, body)
      // Best-effort clipboard: some mobile webviews reject the write — the
      // visible note is the guaranteed path, the copy is a convenience.
      let copied = ''
      try {
        await navigator.clipboard.writeText(body)
        copied = '，已复制到剪贴板'
      } catch {
        // Clipboard unavailable — the note alone is sufficient.
      }
      new Notice(`诊断日志已导出：${path}${copied}`)
      if (this.app.vault.getAbstractFileByPath(path)) {
        await this.app.workspace.openLinkText(path, '')
      }
    } catch (err) {
      new Notice(
        `导出诊断日志失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Delete the on-disk diagnostic log (settings 「清空日志」 button). */
  async clearDiagnosticLog(): Promise<void> {
    await clearDiagLog(this.app)
  }

  /** Create <folder>/my-skill/SKILL.md from the template and open it.
   *  Public: the settings 「第三方技能」 sub-page calls it from its
   *  「＋ 新建技能模板」 button (same entry as the command palette command). */
  async createSkillTemplate(): Promise<void> {
    const folder = skillsFolder(this.settings.general.aiFolder).replace(
      /\/+$/,
      '',
    )
    const base = `${folder}/my-skill`
    let dir = base
    let i = 1
    // Adapter-level exists: the default skill folder is dot-prefixed and
    // invisible to vault.getAbstractFileByPath.
    while (await pathExists(this.app, `${dir}/SKILL.md`)) {
      dir = `${base}-${i}`
      i++
    }
    const path = normalizePath(`${dir}/SKILL.md`)
    try {
      await writeText(this.app, path, SKILL_TEMPLATE)
      new Notice(`已创建技能模板：${path}`)
      // Dot-folder files are not indexed, so they cannot be opened by
      // link text — only auto-open when the file is visible to the vault.
      if (this.app.vault.getAbstractFileByPath(path)) {
        await this.app.workspace.openLinkText(path, '')
      }
      this.scheduleUserSkillsReload()
    } catch (err) {
      new Notice(`创建技能模板失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * One-time storage evolution (追加⑲): legacy installs kept everything in
   * the HIDDEN `.obsidian-ai/` folder; the data now lives in the VISIBLE
   * `AI 助手/` folder so the user can browse and edit the three brain files
   * (agent.md / user.md / memory.md) directly in Obsidian.
   *
   * Rules:
   * - Only migrates when the settings still point at a DEFAULT location
   *   (the legacy ".obsidian-ai" saved by old builds, or the new default
   *   when data.json predates the setting entirely). A user-customized
   *   folder is never touched.
   * - Name conflicts: the destination wins; the source file stays put.
   * - After a migration (or when the folder is brand new) the missing
   *   brain-file templates are seeded. Files the user deleted on purpose are
   *   never re-created (seeding only happens on these two paths).
   */
  private async evolveStorage(): Promise<void> {
    try {
      const current = normalizeAiFolder(this.settings.general.aiFolder)
      const legacyExists = await pathExists(this.app, LEGACY_AI_FOLDER)
      let didMigrate = false
      if (
        legacyExists &&
        (current === LEGACY_AI_FOLDER || current === DEFAULT_AI_FOLDER)
      ) {
        const res = await migrateLegacyFolder(this.app, DEFAULT_AI_FOLDER)
        if (res && res.moved > 0) {
          didMigrate = true
          // Repoint default-path settings at the new visible folder.
          if (current === LEGACY_AI_FOLDER) {
            this.settings.general.aiFolder = DEFAULT_AI_FOLDER
          }
          await this.saveSettings()
          new Notice(
            `AI 助手：已把 ${res.moved} 个数据文件从 .obsidian-ai 迁移到「${DEFAULT_AI_FOLDER}」文件夹`,
          )
        }
      }
      // Seed the evolution files for a fresh or just-migrated folder only.
      const folder = normalizeAiFolder(this.settings.general.aiFolder)
      const folderExists = await pathExists(this.app, folder)
      if (didMigrate || !folderExists) {
        await ensureBrainFiles(this.app, folder)
      }
      // Seed the set-cover custom skill (idempotent — only when missing).
      await seedSetCoverSkill(this.app, folder)
      // 追加75: one-time layout migration — loose agents/<名>.md notes →
      // agents/<名>/subagent.md folders (skills-style). Idempotent; silent
      // when there is nothing to move.
      await evolveAgentsLayout(this.app, agentsFolder(folder))
    } catch {
      // Best-effort: the plugin must still load even if storage I/O fails.
    }
  }

  /**
   * Undo-stack hydration rebuild factory (Task #8). The persisted store keeps
   * only SERIALIZABLE data (path + pre-change content); the revert closure
   * cannot be serialized, so this reconstructs one from each entry. The
   * write-back mirrors the tool-layer reverts exactly (deleteNote.ts) via the
   * shared revertSnapshot helper: EXACT path only — hit → overwrite with the
   * snapshot; miss → re-create (ensuring the parent folder). Returns null for
   * an entry that cannot be rebuilt (unknown kind), which hydrate() skips.
   */
  private rebuildUndoRevert(data: UndoData): (() => Promise<void>) | null {
    if (data.kind !== 'modify' && data.kind !== 'delete') return null
    const app = this.app
    const { path, before } = data
    return () => revertSnapshot(app, path, before)
  }

  async loadSettings(): Promise<void> {
    try {
      const loaded: Partial<ObsidianAISettings> = (await this.loadData()) ?? {}
      const llmMigrated = migrateLlmVendors(
        migrateLlmBlock({
          ...DEFAULT_SETTINGS.llm,
          ...(loaded.llm ?? {}),
        }),
      )
      const imageMigrated = migrateImageVendors({
        ...DEFAULT_SETTINGS.image,
        ...(loaded.image ?? {}),
      })
      // 追加㉗：生图厂商并入统一厂商列表（幂等迁移）。
      const merged = mergeImageVendorsIntoLlm(llmMigrated, imageMigrated)
      // 检索 embedding 同款融合：旧扁平三字段搬进统一厂商列表（幂等）。
      const embMerged = migrateRetrievalEmbeddingIntoLlm(merged.llm, {
        ...DEFAULT_SETTINGS.retrieval,
        ...(loaded.retrieval ?? {}),
      })
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...loaded,
        llm: embMerged.llm,
        image: merged.image,
        safety: migrateSafetyApprovalMode({
          ...DEFAULT_SETTINGS.safety,
          ...(loaded.safety ?? {}),
        }),
        skills: { ...DEFAULT_SETTINGS.skills, ...(loaded.skills ?? {}) },
        agents: { ...DEFAULT_SETTINGS.agents, ...(loaded.agents ?? {}) },
        general: { ...DEFAULT_SETTINGS.general, ...(loaded.general ?? {}) },
        // MCP services: FIRST launch (data.json has no mcp block) seeds the
        // official services; afterwards the block is user-owned — adoption
        // only marks hand-added copies of official endpoints, it never
        // resurrects a deletion (same discipline as brain-file seeding).
        // Fresh array copies — never alias module constants (追加㊹ 同款纪律).
        mcp: adoptOfficialMcpServices(
          loaded.mcp
            ? { services: [...loaded.mcp.services] }
            : { services: cloneSettings(OFFICIAL_MCP_SERVICES) },
        ),
        retrieval: embMerged.retrieval,
        localAgent: {
          ...DEFAULT_SETTINGS.localAgent,
          ...(loaded.localAgent ?? {}),
        },
      }
    } catch (err) {
      // data.json may be corrupt (iCloud sync conflict, partial write).
      // Fall back to defaults so the plugin still loads — a settings reset
      // is far better than the plugin being disabled on every restart.
      // 追加㊹：深拷贝——旧写法 `{...DEFAULT_SETTINGS}` 是浅拷贝，回落
      // 后的任何修改会污染 DEFAULT_SETTINGS 模块常量本身。
      console.error('[UNagent] loadSettings failed, using defaults:', err)
      this.settings = cloneSettings(DEFAULT_SETTINGS)
    }
    // 追加㊹：保存按块合并的基准快照（saveSettings 用它判断哪些块被本
    // 实例动过）。
    this.settingsSnapshot = cloneSettings(this.settings)
  }

  async saveSettings(): Promise<void> {
    try {
      // 追加㊹：不再把内存整体盖写——先读磁盘最新值，本实例没动过的块
      // 取磁盘版本（别的窗口/同步设备的写入不被覆盖），动过的块以内存
      // 为准。「默认生图模型自动失效」的根因就是旧快照实例的整体盖写。
      let toSave = this.settings
      if (this.settingsSnapshot) {
        const disk = await this.loadData().catch(() => null)
        toSave = mergeSettingsForSave(
          this.settingsSnapshot,
          this.settings,
          disk as Partial<ObsidianAISettings> | null,
        )
      }
      await this.saveData(toSave)
      // 合并结果回写内存：采纳的磁盘新值（别的实例的改动）立即对本实例
      // 生效，并把快照对齐到刚保存的状态。
      this.settings = toSave
      this.settingsSnapshot = cloneSettings(toSave)
      for (const listener of this.settingsListeners) {
        listener(this.settings)
      }
    } catch (err) {
      // Settings persistence must NEVER throw into callers: the settings UI
      // fires saveSettings fire-and-forget (void), and a rejection there
      // becomes an UNHANDLED rejection — Obsidian's own listeners still see
      // it (preventDefault only stops the default action) and it can get
      // the plugin disabled on mobile (the repeated-reload bug). A failed
      // write just means the change is not persisted; the user retries by
      // changing the setting again.
      console.error('[UNagent] saveSettings failed:', err)
    }
  }
}
