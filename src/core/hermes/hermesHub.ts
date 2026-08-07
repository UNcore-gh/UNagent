// HermesHub (补刀·五十六): one long-lived `hermes acp` process shared by
// every hermes conversation of the plugin (sessions are multiplexed by
// sessionId; hermes persists them in its own state.db). Owns the ACP
// connection lifecycle, session creation/resume, prompt turns with live
// update routing, cancel, mode/model switching, and permission-request
// fan-out to the UI (which must answer — fail-closed auto-cancel after 55s
// stays ahead of hermes' own 60s deny).

import { AcpConnection, type ServerRequestEvent } from './acpConnection'
import type { SpawnLike } from '../desktop/localAgent'
import {
  parseAvailableCommandsUpdate,
  type HermesAdvertisedCommand,
} from './advertisedCommands'
import {
  parseSessionStates,
  type HermesSessionStates,
} from './sessionStates'
import type {
  AcpAuthMethod,
  ForkSessionResult,
  HermesModeId,
  HermesPermissionRequest,
  HermesSessionUpdate,
  ListSessionsResult,
  NewSessionResult,
  PromptResult,
} from './types'

/** Auto-cancel a permission request this long before hermes' 60s fail-closed
 *  deadline, so the user's no-answer reads as an explicit cancel. */
const PERMISSION_AUTO_CANCEL_MS = 55_000

/** listSessions 翻页合并的硬上限：服务端页大小 50（hermes
 *  acp_adapter/server.py _LIST_SESSIONS_PAGE_SIZE，客户端不可调）下约 4 页，
 *  防服务端 cursor 异常时失控。 */
const LIST_SESSIONS_MAX = 200

export interface PermissionRequestEvent {
  /** JSON-RPC id — pass back to answerPermission. */
  requestId: number
  request: HermesPermissionRequest
}

export interface HermesHubConfig {
  /** hermes CLI command or path (settings). */
  command: string
  /** Vault root — cwd for the process + session/new. */
  cwd: string
  /** 测试接缝：注入 fake spawn（生产路径走 getDesktopSpawn，移动端不可达）。 */
  spawnImpl?: SpawnLike
}

/** 连接状态灯语义（补刀·五十九）：idle/connecting 灰、ready 绿、failed 红。
 *  idle——尚未尝试连接（或已主动断开）；connecting——spawn+initialize 进行中；
 *  ready——ACP 握手完成（服务可用）；failed——启动/握手失败或进程退出。
 *  状态变化经 notifyStates 广播（UI 订阅重渲染）；failed 后下一次调用
 *  （ensureConnected）自动重试。 */
export type HermesConnState = 'idle' | 'connecting' | 'ready' | 'failed'

interface ActiveRouter {
  sessionId: string
  onUpdate: (update: HermesSessionUpdate) => void
}

export class HermesHub {
  private conn: AcpConnection | null = null
  private connCommand = ''
  private connecting: Promise<AcpConnection> | null = null
  /** 连接状态灯（补刀·五十九）：ensureConnected 生命周期驱动，变更广播。 */
  private connStateValue: HermesConnState = 'idle'
  private activeRouter: ActiveRouter | null = null
  /** 预热预备的 fork 子会话（warmup 后台 fork 好，首次发送直接消费省 ~2s）。 */
  private readyForkSessionId: string | null = null
  /**
   * 本连接代际内已确认存在的会话（load/new/fork 成功过）。连接重建
   * （进程死亡/主动 dispose）时清空——同代际内会话在 hermes 内存中必然
   * 存在，runHermesTurn 据此跳过每轮 session/load（hermes 侧 load 会重建
   * 模型清单，每次网络拉取 ~1s，实测 0.97s）。
   */
  private confirmedSessions = new Set<string>()
  /** 全局兜底权限 handler（主视图不传 sessionId 的既有调用挂这里）。 */
  private permissionHandler: ((ev: PermissionRequestEvent) => void) | null = null
  /** 会话级权限 handler（任务三：Hermes 独立视图与主视图共存，权限请求按
   *  sessionId 各归其 UI，互不顶替）。路由时先查此表，缺失回落全局槽。 */
  private sessionPermissionHandlers = new Map<
    string,
    (ev: PermissionRequestEvent) => void
  >()
  private permissionTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /** 55s 兜底 deny 到期通知（评审修复 11）：UI 据此清掉仍在展示的 pending
   *  审批（全局槽——权限请求本就经 handler 路由到所属 UI，到期清场只需一个
   *  全局通知点）。随 disposeConnection 置空。 */
  private permissionExpiryHandler: ((requestId: number) => void) | null = null
  /** M2-T1/T2: session/new、session/load 响应里的 models/modes 清单按
   *  sessionId 缓存——选择窗（/model、审批模式）只吃这份清单，未就绪显示
   *  「hermes 清单加载中」并禁用选择，绝不回落插件档案列表。缓存随会话
   *  恢复（load）重建；进程断连即作废（handleConnectionLost）。 */
  private sessionStates = new Map<string, HermesSessionStates>()
  /** M2-T4: hermes 经 available_commands_update 通告的命令注册表，按
   *  sessionId 缓存（name/description/input hint）。生命周期与
   *  sessionStates 同款：随进程断连作废（重连后由新的通告帧重建）。
   *  注意帧在 session/new|load 响应之后、首轮 prompt 之前就可能到达——
   *  缓存独立于在途轮路由（activeRouter），到达即落缓存。 */
  private advertisedCommands = new Map<string, HermesAdvertisedCommand[]>()
  /** 状态变更订阅（UI 重渲染选择窗）。 */
  private stateListeners = new Set<() => void>()

  /** 订阅会话状态（清单缓存）变更；返回退订函数。 */
  subscribe(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  private notifyStates(): void {
    for (const fn of this.stateListeners) fn()
  }

  /** 连接状态（供状态灯 UI 读取）；变更经 subscribe 广播。 */
  get connState(): HermesConnState {
    return this.connStateValue
  }

  private setConnState(next: HermesConnState): void {
    if (this.connStateValue === next) return
    this.connStateValue = next
    this.notifyStates()
  }

  /** 某会话的模型/模式清单缓存；null = 尚未建立（清单未就绪）。 */
  getSessionStates(sessionId: string): HermesSessionStates | null {
    return this.sessionStates.get(sessionId) ?? null
  }

  /** M2-T4: 某会话通告的命令注册表缓存；空数组 = 尚未收到通告帧。 */
  getAdvertisedCommands(sessionId: string): HermesAdvertisedCommand[] {
    return this.advertisedCommands.get(sessionId) ?? []
  }

  private cacheSessionStates(sessionId: string, res: unknown): void {
    if (!sessionId) return
    this.sessionStates.set(sessionId, parseSessionStates(res))
    this.notifyStates()
  }

  /** Where the UI sends permission decisions. 不传 sessionId = 全局兜底槽
   *  （主视图现有调用，行为不变）；传 sessionId = 该会话专属槽（独立视图
   *  与主视图共存时权限各归其 UI）。handler=null 为注销：全局槽置空 /
   *  会话槽从 Map 移除。 */
  setPermissionHandler(
    handler: ((ev: PermissionRequestEvent) => void) | null,
    sessionId?: string,
  ): void {
    if (sessionId) {
      if (handler) this.sessionPermissionHandlers.set(sessionId, handler)
      else this.sessionPermissionHandlers.delete(sessionId)
      return
    }
    this.permissionHandler = handler
  }

  /** 55s 无答复兜底 deny 到期后的通知钩子（评审修复 11）——UI 清 pending
   *  审批展示；handler=null 注销。 */
  setPermissionExpiryHandler(
    handler: ((requestId: number) => void) | null,
  ): void {
    this.permissionExpiryHandler = handler
  }

  /** 丢弃某会话的内存缓存（任务三：管理面板删除会话后调用）——
   *  sessionStates/advertisedCommands/会话级权限 handler 一并清，并通知
   *  订阅者重渲染。不影响 hermes 侧会话本体（state.db 持久）。 */
  forgetSession(sessionId: string): void {
    const hadStates = this.sessionStates.delete(sessionId)
    const hadCommands = this.advertisedCommands.delete(sessionId)
    const hadHandler = this.sessionPermissionHandlers.delete(sessionId)
    if (hadStates || hadCommands || hadHandler) this.notifyStates()
  }

  /** Connect (or reuse). Reconnects when the configured command changed. */
  async ensureConnected(config: HermesHubConfig): Promise<AcpConnection> {
    if (this.conn?.alive && this.connCommand === config.command) return this.conn
    if (this.connecting) return this.connecting
    this.disposeConnection()
    this.setConnState('connecting')
    const connectingPromise = AcpConnection.connect({
      command: config.command,
      cwd: config.cwd,
      ...(config.spawnImpl ? { spawnImpl: config.spawnImpl } : {}),
      handlers: {
        onNotification: (method, params) => this.routeNotification(method, params),
        onServerRequest: (req) => this.routeServerRequest(req),
        // 进程退出/stdio 断连（M2-T6 自愈）：标记连接失效并清理挂在该进程上
        // 的全部会话状态。conn 置空后，下一次 newSession/loadSession/prompt
        // 经 ensureConnected 自动重连；会话本体持久在 hermes 自己的 state.db，
        // 重连后按现有路径 session/load 恢复，load 失败降级 session/new。
        onExit: () => this.handleConnectionLost(),
      },
    })
      .then((conn) => {
        this.conn = conn
        this.connCommand = config.command
        // 新连接 = 新 hermes 进程（或连接代际变化）：进程内存里的会话全部
        // 作废，清空确认集——后续 load 语义恢复（state.db 持久会话可恢复）。
        this.confirmedSessions.clear()
        this.setConnState('ready')
        return conn
      })
      .catch((err) => {
        // 启动/握手失败 → 状态灯红；调用方（newSession/prompt 等）照旧拿
        // 到 reject 给用户可读错误，下一次调用自动重试（failed 不阻塞）。
        this.setConnState('failed')
        throw err
      })
      .finally(() => {
        // 只清自己这一份 promise——disposeConnection 可能已在本 promise
        // settle 前接管并置空（评审修复 6），不能误清后继的新连接。
        if (this.connecting === connectingPromise) this.connecting = null
      })
    this.connecting = connectingPromise
    return connectingPromise
  }

  get connected(): boolean {
    return this.conn?.alive === true
  }

  /** 预热完成时存入预备 fork 子会话（幂等覆盖——后一次预热覆盖前一次）。 */
  setReadyFork(sessionId: string): void {
    this.readyForkSessionId = sessionId
  }

  /**
   * 本连接代际内已确认存在的会话（load/new/fork 成功过）→ true。调用方
   * 据此跳过每轮 session/load：同代际内会话在 hermes 内存中必然存在，而
   * hermes 侧 load 要重建模型清单（每次网络拉取 ~1s）。连接重建/本轮
   * prompt 失败都会摘除确认标记，恢复完整 load 语义。
   */
  shouldSkipLoad(sessionId: string): boolean {
    return this.confirmedSessions.has(sessionId)
  }

  /** 原子取走预备 fork 子会话（每个对话消费一次；无则 null 走正常 fork）。 */
  takeReadyFork(): string | null {
    const id = this.readyForkSessionId
    this.readyForkSessionId = null
    return id
  }

  get agentVersion(): string {
    return this.conn?.agentVersion ?? ''
  }

  /** initialize 协议版本不匹配告警文案（'' = 正常）。M2-T6。 */
  get protocolWarning(): string {
    return this.conn?.protocolWarning ?? ''
  }

  /** initialize 通告的 auth methods（M2-T3；空数组 = 未连接或老版 hermes
   *  未通告该字段）。 */
  get authMethods(): AcpAuthMethod[] {
    return this.conn?.authMethods ?? []
  }

  /** initialize 明确告知 hermes 未配置任何 provider 凭据——设置页与
   *  首次连接失败提示据此展示配置指引（M2-T3）。 */
  get noCredentials(): boolean {
    return this.conn?.noCredentials ?? false
  }

  /** New session bound to cwd. */
  async newSession(config: HermesHubConfig): Promise<NewSessionResult> {
    const conn = await this.ensureConnected(config)
    const res = await conn.request('session/new', {
      cwd: config.cwd,
      mcpServers: [],
    })
    const result = res as NewSessionResult
    // M2-T1/T2: 响应携带 models/modes 清单 → 按 sessionId 缓存。
    if (result?.sessionId) {
      this.cacheSessionStates(result.sessionId, result)
      this.confirmedSessions.add(result.sessionId)
    }
    return result
  }

  /**
   * Resume a persisted hermes session (its own state.db). History replays as
   * notifications BEFORE the response — routed to `onReplay` when given (the
   * plugin renders from its own store, so callers usually pass a noop).
   * Returns false when hermes no longer knows the session.
   */
  async loadSession(
    config: HermesHubConfig,
    sessionId: string,
    onReplay?: (update: HermesSessionUpdate) => void,
  ): Promise<boolean> {
    const conn = await this.ensureConnected(config)
    this.activeRouter = onReplay
      ? { sessionId, onUpdate: onReplay }
      : null
    try {
      const res = await conn.request('session/load', {
        cwd: config.cwd,
        sessionId,
        mcpServers: [],
      })
      const ok = res !== null && res !== undefined
      // M2-T1/T2: 缓存随会话恢复重建（load 响应同款携带 models/modes）。
      if (ok) {
        this.cacheSessionStates(sessionId, res)
        this.confirmedSessions.add(sessionId)
      }
      return ok
    } finally {
      this.activeRouter = null
    }
  }

  /** Send one turn; routes session/update events until the turn completes.
   *  `timeoutMs <= 0` waits forever (the caller owns wall-clock via cancel). */
  async prompt(
    config: HermesHubConfig,
    sessionId: string,
    text: string,
    onUpdate: (update: HermesSessionUpdate) => void,
    timeoutMs = 0,
  ): Promise<PromptResult> {
    const conn = await this.ensureConnected(config)
    this.activeRouter = { sessionId, onUpdate }
    try {
      const res = await conn.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        timeoutMs,
      )
      return (res ?? {}) as PromptResult
    } catch (err) {
      // 保险丝：本轮失败不认定会话已死（可能只是模型/网络错误），但保守
      // 摘掉「已确认」标记——下一轮恢复 load 语义自愈（load 失败降级 new）。
      this.confirmedSessions.delete(sessionId)
      throw err
    } finally {
      if (this.activeRouter?.sessionId === sessionId) this.activeRouter = null
    }
  }

  /** Cancel the in-flight turn (notification — no response). */
  cancel(sessionId: string): void {
    this.conn?.notify('session/cancel', { sessionId })
  }

  async setMode(config: HermesHubConfig, sessionId: string, modeId: HermesModeId): Promise<void> {
    const conn = await this.ensureConnected(config)
    await conn.request('session/set_mode', { sessionId, modeId })
    // M2-T2: 成功后同步缓存里的 currentModeId → 选择窗「当前」徽章即时更新。
    const states = this.sessionStates.get(sessionId)
    if (states?.modes) {
      states.modes = { ...states.modes, currentModeId: modeId }
      this.notifyStates()
    }
  }

  async setModel(config: HermesHubConfig, sessionId: string, modelId: string): Promise<void> {
    const conn = await this.ensureConnected(config)
    await conn.request('session/set_model', { sessionId, modelId })
    // M2-T1: 成功后同步缓存里的 currentModelId → 选择窗「当前」徽章即时更新。
    const states = this.sessionStates.get(sessionId)
    if (states?.models) {
      states.models = { ...states.models, currentModelId: modelId }
      this.notifyStates()
    }
  }

  /** Fork a child session from an existing project session (项目会话 #94). */
  async forkSession(
    config: HermesHubConfig,
    sessionId: string,
  ): Promise<ForkSessionResult> {
    const conn = await this.ensureConnected(config)
    const res = await conn.request('session/fork', {
      cwd: config.cwd,
      sessionId,
      mcpServers: [],
    })
    const result = res as ForkSessionResult
    if (result?.sessionId) {
      this.cacheSessionStates(result.sessionId, result)
      this.confirmedSessions.add(result.sessionId)
    }
    return result
  }

  /** 列出 hermes 会话（管理面板用）。服务端分页 50/页——此处循环 cursor
   *  翻页合并成一份完整列表：无 nextCursor 即到底；合并达硬上限
   *  （LIST_SESSIONS_MAX）即停（截断时带回当时的 nextCursor 供调用方
   *  感知未取完）。opts.cursor = 起始续拉锚点（评审修复 1：面板「加载更多」
   *  从上次的 nextCursor 续拉；缺省 = 从头拉全量）。单页无 cursor 的老调用
   *  行为完全兼容。 */
  async listSessions(
    config: HermesHubConfig,
    opts?: { cursor?: string },
  ): Promise<ListSessionsResult> {
    const conn = await this.ensureConnected(config)
    const sessions: ListSessionsResult['sessions'] = []
    let cursor: string | undefined = opts?.cursor || undefined
    let hitCap = false
    // 页数护栏：正常 200/50 = 4 页封顶；放宽到 16 页兜底 cursor 异常。
    for (let page = 0; page < 16; page++) {
      const params: { cwd: string; cursor?: string } = { cwd: config.cwd }
      if (cursor) params.cursor = cursor
      const res = (await conn.request('session/list', params) ?? {
        sessions: [],
      }) as ListSessionsResult
      const batch = Array.isArray(res.sessions) ? res.sessions : []
      sessions.push(...batch)
      cursor = typeof res.nextCursor === 'string' ? res.nextCursor : undefined
      // 停止条件：无 cursor（到底）/ 空页（未知 cursor 服务端回空）。
      if (!cursor || batch.length === 0) break
      // 达硬上限即停（防失控）。
      if (sessions.length >= LIST_SESSIONS_MAX) {
        hitCap = true
        break
      }
    }
    const merged: ListSessionsResult = {
      // 单页超大 batch 的防御性裁剪（正常服务端每页 ≤50 不会触发）。
      sessions:
        sessions.length > LIST_SESSIONS_MAX
          ? sessions.slice(0, LIST_SESSIONS_MAX)
          : sessions,
    }
    // 因上限截断且服务端仍有余量 → 带回 cursor，管理面板可据此继续拉。
    if ((hitCap || sessions.length > LIST_SESSIONS_MAX) && cursor) {
      merged.nextCursor = cursor
    }
    return merged
  }

  /** UI decision for a permission request. 评审修复 11：permissionTimers 里
   *  查无此 requestId（已被 55s 兜底应答过/断连清场/从未路由到 UI）→ 直接
   *  忽略，绝不写第二帧应答（重复应答会破坏 JSON-RPC 一问一答契约）。 */
  answerPermission(requestId: number, optionId: string | null): void {
    const timer = this.permissionTimers.get(requestId)
    if (!timer) return
    clearTimeout(timer)
    this.permissionTimers.delete(requestId)
    this.conn?.respondToServerRequest(requestId, { optionId })
  }

  /** 停止生成语义：拒绝全部在途权限请求——hermes 在等插件应答的
   *  request_permission 不能悬挂等 55s 兜底，否则点停止后审批面板还挂着，
   *  hermes 侧也一直等。逐个清定时器 + 回 cancelled + 通知 UI 清 pending。 */
  denyPendingPermissions(): void {
    for (const [requestId, timer] of this.permissionTimers) {
      clearTimeout(timer)
      this.permissionTimers.delete(requestId)
      this.conn?.respondToServerRequest(requestId, { optionId: null })
      this.permissionExpiryHandler?.(requestId)
    }
  }

  dispose(): void {
    this.disposeConnection()
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  /**
   * 进程死亡时的清场（M2-T6 自愈）：清掉挂在旧进程上的一切会话映射——
   * 在途轮次的 update 路由、未决审批的 55s 兜底定时器（不清的话重连后旧
   * 定时器会把过期 requestId 回给新连接）。进程本身已死无需 kill；conn 置空
   * 使 ensureConnected 下次自动重连。55s fail-closed / session/cancel / 墙钟
   * cancel→dispose 三个既有机制的语义不变（超时 dispose 走 disposeConnection）。
   */
  private handleConnectionLost(): void {
    for (const timer of this.permissionTimers.values()) clearTimeout(timer)
    this.permissionTimers.clear()
    // 任务三：会话级权限 handler 挂在旧进程的会话上，进程死即作废（与
    // sessionStates/advertisedCommands 同款生命周期）；全局槽是 UI 挂载级
    // 生命周期，不在此清（与既有行为一致）。
    this.sessionPermissionHandlers.clear()
    this.activeRouter = null
    this.conn = null
    // 补刀·五十九：进程退出 = 服务不可用 → 状态灯红（连接已死，下一次
    // 调用经 ensureConnected 自动重连）。
    this.setConnState('failed')
    // M2-T1/T2: 清单缓存挂在该进程上，进程死即作废——重连后经 session/load
    // / session/new 重建（选择窗在此期间回到「清单加载中」禁用态）。
    // M2-T4: 通告命令缓存同款作废（/ 面板回到静态兜底清单）。
    if (this.sessionStates.size > 0 || this.advertisedCommands.size > 0) {
      this.sessionStates.clear()
      this.advertisedCommands.clear()
      this.notifyStates()
    }
  }

  private disposeConnection(): void {
    // 评审修复 6：接管悬挂中的 connecting——onunload/dispose 落在 spawn 与
    // initialize 完成之间时，不接管的话该进程成孤儿（this.conn 尚未赋值，
    // conn?.dispose() 够不着它）。promise settle 后立即 dispose 拿到的连接。
    const pending = this.connecting
    if (pending) {
      void pending
        .then((c) => c.dispose())
        .catch(() => {})
        // 接管链终局：settle→dispose→onExit→failed 之后强制回未连接，
        // 避免卸载路径把状态灯留在红（连接已不再存在）。
        .then(() => this.setConnState('idle'))
      this.connecting = null
    }
    for (const timer of this.permissionTimers.values()) clearTimeout(timer)
    this.permissionTimers.clear()
    this.sessionPermissionHandlers.clear()
    this.permissionExpiryHandler = null
    this.activeRouter = null
    this.conn?.dispose()
    this.conn = null
    this.connCommand = ''
    // 主动断开/接管后状态灯回未连接（先于 dispose 同步触发的 onExit→failed
    // 覆盖——最终态是 idle）。
    this.setConnState('idle')
    if (this.sessionStates.size > 0 || this.advertisedCommands.size > 0) {
      this.sessionStates.clear()
      this.advertisedCommands.clear()
      this.notifyStates()
    }
  }

  private routeNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const p = params as { sessionId?: string; update?: HermesSessionUpdate } | undefined
    const update = p?.update
    if (!update || typeof update !== 'object') return
    // M2-T4: 通告命令注册表按 sessionId 落缓存——独立于在途轮路由：帧常在
    // session/new|load 响应之后、首轮 prompt 之前到达（此刻没有
    // activeRouter），只有 hub 级缓存接得住。
    const advertised = parseAvailableCommandsUpdate(update)
    if (advertised !== null && p?.sessionId) {
      this.advertisedCommands.set(p.sessionId, advertised)
      this.notifyStates()
    }
    const router = this.activeRouter
    if (!router) return
    // Updates for OTHER sessions (rare) are dropped — one active turn at a time.
    if (p?.sessionId && router.sessionId && p.sessionId !== router.sessionId) return
    router.onUpdate(update)
  }

  private routeServerRequest(req: ServerRequestEvent): void {
    if (req.method === 'session/request_permission') {
      const request = req.params as HermesPermissionRequest
      // 任务三：先按请求所属 sessionId 查会话级 handler，缺失回落全局槽；
      // 主视图不注册会话级 handler 时路由结果与既有行为逐字节一致。
      const handler =
        (request?.sessionId
          ? this.sessionPermissionHandlers.get(request.sessionId)
          : undefined) ?? this.permissionHandler
      if (!handler) {
        // No UI attached (should not happen mid-turn): cancel = deny.
        this.conn?.respondToServerRequest(req.id, { optionId: null })
        return
      }
      handler({ requestId: req.id, request })
      // Fail-closed guard: stay ahead of hermes' 60s auto-deny.
      const timer = setTimeout(() => {
        this.permissionTimers.delete(req.id)
        this.conn?.respondToServerRequest(req.id, { optionId: null })
        // 评审修复 11：到期自动 deny 后通知 UI 清 pending 展示。
        this.permissionExpiryHandler?.(req.id)
      }, PERMISSION_AUTO_CANCEL_MS)
      this.permissionTimers.set(req.id, timer)
      return
    }
    // fs/read_text_file, terminal/*… — hermes never calls them; method-not-found.
    this.conn?.respondToServerRequest(req.id, { optionId: null })
  }
}

/** Plugin-wide hub (one hermes process shared by all hermes conversations). */
let hubInstance: HermesHub | null = null

export function getHermesHub(): HermesHub {
  if (!hubInstance) hubInstance = new HermesHub()
  return hubInstance
}

/** Called from the plugin's onunload. */
export function disposeHermesHub(): void {
  hubInstance?.dispose()
  hubInstance = null
}
