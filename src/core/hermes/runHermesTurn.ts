// 任务二：hermes 轮编排（原 useAgent runCore 的 hermes 分支整体下沉）。
//
// 纯编排函数：不碰 React、不碰持久化——会话解析（load→失败降级 new）、
// 每轮幂等 set_mode/set_model（set_mode 失败显式 Notice、不阻断轮次，
// 任务一 §1.1 语义）、墙钟超时 cancel→8s 强制 dispose、abort→session/cancel、
// 新建会话首轮 buildHermesChatPrompt 包裹（人设+记忆快照+窗口实录）、
// 轮末 flushHermesThinking 思考兜底、T3 凭据指引（authGuide）全部在此。
//
// 帧交付契约（为 Hermes 独立视图做地基）：onBlocks 只收到「最新块列表
// 快照」。流式帧经 rAF 合并队列交付（对齐 core 路径 queuePatch 的做法，
// 移动端高频帧不再逐帧触发渲染），轮末同步冲刷残留——调用方拿到的最后
// 一次 onBlocks 即本轮终态（成功=完整块列表；失败/超时=整段替换文案）。
//
// 边界：只用 HermesHub 现有公开 API（结构接口 HermesTurnHub 便于 scripted
// fake 单测），不给 hub 加新调用；blockMapper/sessionStates/replayMapper
// 零改动。

import { Notice } from 'obsidian'

import {
  HERMES_CONTEXT_MAX_CHARS,
  HERMES_CONTEXT_MAX_MESSAGES,
  HERMES_MEMORY_MAX_CHARS,
  buildHermesChatPrompt,
} from '../desktop/localAgent'
import { buildCompactTranscript } from '../../utils/compact'
import { dlog } from '../../utils/diagnosticLog'
import type { UiBlock, UiMessage } from '../../components/chat-view/types'
import { failureAuthHint } from './authGuide'
import {
  applyHermesUpdate,
  flushHermesThinking,
  type HermesTurnState,
} from './blockMapper'
import type { HermesHubConfig } from './hermesHub'
import type {
  ForkSessionResult,
  HermesModeId,
  HermesSessionUpdate,
  NewSessionResult,
  PromptResult,
} from './types'

/** runHermesTurn 消费的 hub 面（= HermesHub 现有公开 API 的结构子集，
 *  单测用 scripted fake 实现）。 */
export interface HermesTurnHub {
  newSession(config: HermesHubConfig): Promise<NewSessionResult>
  loadSession(config: HermesHubConfig, sessionId: string): Promise<boolean>
  forkSession(config: HermesHubConfig, sessionId: string): Promise<ForkSessionResult>
  setMode(
    config: HermesHubConfig,
    sessionId: string,
    modeId: HermesModeId,
  ): Promise<void>
  setModel(
    config: HermesHubConfig,
    sessionId: string,
    modelId: string,
  ): Promise<void>
  prompt(
    config: HermesHubConfig,
    sessionId: string,
    text: string,
    onUpdate: (update: HermesSessionUpdate) => void,
  ): Promise<PromptResult>
  cancel(sessionId: string): void
  dispose(): void
  /** 原子取走预热预备的 fork 子会话（无则 null，走正常 fork 路径）。 */
  takeReadyFork(): string | null
  /**
   * 本连接代际内已确认存在的会话（load/new/fork 成功过）→ true。调用方
   * 跳过每轮 session/load——hermes 侧 load 重建模型清单会网络拉取 ~1s；
   * 连接重建/本轮 prompt 失败都会摘除确认标记，恢复完整 load 语义。
   */
  shouldSkipLoad(sessionId: string): boolean
  readonly noCredentials: boolean
}

/** 编排所需的设置切片（settings.localAgent 结构兼容，直接可传）。 */
export interface HermesTurnConfig {
  approvalMode: HermesModeId
  model: string
  timeoutMs: number
  /** T3 凭据指引入口（唯一合法来源=设置项，禁止硬编码 URL）。 */
  guidedEndpoint?: string
}

/** 每会话覆盖（/model /mode 清单内选择产生）；无则回落设置值。 */
export interface HermesTurnOverrides {
  mode?: HermesModeId
  model?: string
}

export interface RunHermesTurnInput {
  hub: HermesTurnHub
  hubConfig: HermesHubConfig
  cfg: HermesTurnConfig
  /** 对话已绑定的 hermes 会话；null = 本轮新建。 */
  sessionId: string | null
  /** 分支源的主干 hermes 会话（补刀·六十）：有值且本轮无绑定会话时，优先从
   *  它 fork——hermes 侧 session/fork 复制主干完整对话上下文（分支的同时
   *  保留主干；hermes 桌面端呈分支关系而非并列空会话）。失败（源会话已被
   *  hermes 清理/进程异常）静默降级项目 fork 路径（首轮带窗口实录重建连续性）。
   *  null/缺省 = 普通新建会话。 */
  forkSourceSessionId?: string | null
  /** fork 源标记一次性消费（首轮解析后无论成败都调用）——调用方据此清掉
   *  对话上的 forkSourceHermesSessionId，避免后续轮次重复 fork。 */
  onForkSourceConsumed?: () => void
  /** 项目会话 ID（来自 settings.localAgent.projectSessionId），用于
   *  从项目 fork 出子会话。null = 首次使用，自动创建项目。 */
  projectSessionId: string | null
  /** 覆盖按「解析后的会话 id」取——load 失败降级 new 时旧 id 的覆盖不跟迁。 */
  getOverrides: (sessionId: string) => HermesTurnOverrides
  /** 已做 @file:/@folder: 引用展开的用户输入。 */
  userContent: string
  /** 首轮包裹用的对话实录窗口（调用方已排除 ephemeral）。 */
  historyWindow: UiMessage[]
  /** 人设正文（engine:hermes 代理的 subagent.md body）；/hermes 分发不传。 */
  persona?: string
  /** 插件侧 user.md/memory.md 冻结快照；null = 本轮未加载（不注入）。 */
  memory: { user: string[]; memory: string[] } | null
  abortSignal: AbortSignal
  /** 块快照交付（rAF 合并后每帧至多一次；轮末同步冲刷终态）。 */
  onBlocks: (blocks: UiBlock[]) => void
  /** 新建会话绑定成功——调用方写回对话并标脏（绑定随对话持久化）。 */
  onSessionBound?: (sessionId: string) => void
  /** 项目会话绑定成功——调用方写回 settings（项目会话是 vault 级，非对话级）。 */
  onProjectSessionBound?: (projectSessionId: string) => void
  /** 模式 id 的展示文案（Notice 用）；缺省回落到 id 本身。 */
  modeLabel?: (modeId: string) => string
  /** dlog 用的代理名（'' / undefined = 主代理或 /hermes 分发）。 */
  agentLabel?: string
  /** 帧合并调度器注入（测试接缝）；缺省 = requestAnimationFrame，
   *  无 rAF 环境回落 setTimeout(16ms)。 */
  scheduleFrame?: (fn: () => void) => () => void
}

export interface RunHermesTurnResult {
  /** 本轮实际使用的会话 id（new/load 解析后的终值；失败前未解析 = ''）。 */
  sessionId: string
  gotContent: boolean
  timedOut: boolean
  stopReason: string
  /** 出错时的原始错误文案；null = 正常结束。 */
  error: string | null
}

const DEFAULT_WALL_TIMEOUT_MS = 600000
/** 超时 cancel 后强制断连的宽限（hermes 不响应 cancel 时兜底）。 */
const DISPOSE_AFTER_CANCEL_MS = 8000

const defaultScheduleFrame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const t = setTimeout(fn, 16)
  return () => clearTimeout(t)
}

/** 获取或创建项目会话。返回会话 ID。
 *  如果 projectSessionId 存在且 hermes 侧仍认得它（load 成功），直接复用；
 *  否则调用 newSession 创建新项目会话。
 *  并发安全：按 cwd 去重——预热与正式发送可能同时到达（都是 fire-and-forget
 *  或用户操作触发），双 newSession 会产生孤儿空会话；同一 cwd 的并发调用
 *  共享同一个 pending promise，拿到同一 projectId。 */
const projectSessionLocks = new Map<string, Promise<string>>()

export async function getOrCreateProjectSession(
  hub: HermesTurnHub,
  config: HermesHubConfig,
  projectSessionId: string | null,
): Promise<string> {
  const existing = projectSessionLocks.get(config.cwd)
  if (existing) return existing
  const pending = (async (): Promise<string> => {
    if (projectSessionId) {
      const loaded = await hub
        .loadSession(config, projectSessionId)
        .catch(() => false)
      if (loaded) return projectSessionId
    }
    const created = await hub.newSession(config)
    return created.sessionId
  })().finally(() => {
    // 只清自己这一份——并发调用各自持有同一 promise 引用，
    // 下一个新调用（不同 cwd 或锁已释放后）重新加锁。
    if (projectSessionLocks.get(config.cwd) === pending) {
      projectSessionLocks.delete(config.cwd)
    }
  })
  projectSessionLocks.set(config.cwd, pending)
  return pending
}

/**
 * 执行一轮 hermes ACP 交互。永不 reject——一切失败都经 onBlocks 落成整段
 * 替换的错误文案（附 T3 凭据指引），返回值带 error 标记。
 */
export async function runHermesTurn(
  input: RunHermesTurnInput,
): Promise<RunHermesTurnResult> {
  const { hub, hubConfig, cfg, scheduleFrame = defaultScheduleFrame } = input
  const label = (modeId: string): string =>
    input.modeLabel ? input.modeLabel(modeId) : modeId

  // ── rAF 合并交付队列：流式帧攒到下一帧一次交付；轮末 finishWith 同步冲刷 ──
  let currentBlocks: UiBlock[] = []
  let deliveryPending = false
  let cancelDelivery: (() => void) | null = null
  const scheduleDelivery = (): void => {
    if (deliveryPending) return
    deliveryPending = true
    cancelDelivery = scheduleFrame(() => {
      deliveryPending = false
      cancelDelivery = null
      input.onBlocks(currentBlocks)
    })
  }
  const finishWith = (blocks: UiBlock[]): void => {
    if (cancelDelivery) {
      cancelDelivery()
      cancelDelivery = null
    }
    deliveryPending = false
    input.onBlocks(blocks)
  }

  const failBlock = (text: string): UiBlock[] => [{ kind: 'text', text }]

  let activeSessionId = ''
  let gotContent = false
  let timedOut = false
  let stopReason = ''
  let wallTimer: ReturnType<typeof setTimeout> | null = null
  // 评审修复 2：cancel 后挂的 8s dispose 定时器——prompt 已正常 settle
  // （连接健康）时不应再 dispose（共享 hub 会误杀其他会话的在途轮）。
  let disposeTimer: ReturnType<typeof setTimeout> | null = null
  let promptSettled = false
  // 停止按钮语义：用户主动 abort 后置位——各 await 之后检查短路，prompt
  // 绝不照发。abort 落在会话解析/模式应用挂起中时（activeSessionId 还没
  // 值，cancel 通知无处发），没有这个标记「停止」会被静默吞掉。
  let aborted = false

  // 评审修复 3：abort 监听入口即挂（首个 await 前）——原实现要等
  // loadSession/newSession/setMode/setModel 全部 settle 后才注册，窗口内
  // 的「停止」被静默丢弃。activeSessionId 为空（会话还没解析出来）时
  // cancel 无从发，守卫掉。
  const onAbort = (): void => {
    aborted = true
    if (activeSessionId) hub.cancel(activeSessionId)
    // abort 后 hermes 对 cancel 通知无响应时 prompt 会一直挂着（通知是
    // fire-and-forget 无回执）——挂同款 8s 强制断连兜底（prompt 已 settle
    // 则作废）。停止必须「点一下就能停」，不能干等墙钟（最长 10 分钟）。
    if (disposeTimer === null) {
      disposeTimer = setTimeout(() => {
        if (!promptSettled) hub.dispose()
      }, DISPOSE_AFTER_CANCEL_MS)
    }
  }

  /** abort 后的统一短路收尾：清定时器/监听，保留已生成内容（如有）。
   *  try 与 catch 共用——强断导致的连接错误也是「已停止」不是故障。 */
  const stopEarly = (): RunHermesTurnResult => {
    if (wallTimer !== null) clearTimeout(wallTimer)
    if (disposeTimer !== null) clearTimeout(disposeTimer)
    wallTimer = null
    disposeTimer = null
    input.abortSignal.removeEventListener('abort', onAbort)
    finishWith(gotContent ? currentBlocks : failBlock('（已停止）'))
    return {
      sessionId: activeSessionId,
      gotContent,
      timedOut,
      stopReason: 'cancelled',
      error: null,
    }
  }
  if (input.abortSignal.aborted) {
    finishWith(failBlock('（已停止）'))
    return {
      sessionId: '',
      gotContent,
      timedOut,
      stopReason: 'cancelled',
      error: null,
    }
  }
  input.abortSignal.addEventListener('abort', onAbort, { once: true })
  try {
    // ── 会话解析：已有绑定 → session/load 恢复；否则新建 ──
    let sessionId = input.sessionId
    let isNewSession = false
    if (sessionId) {
      // 同连接代际内已确认的会话（load/new/fork 成功过）跳过每轮 load：
      // hermes 侧 load 要重建模型清单（每次网络拉取 ~1s，实测 0.97s），
      // 而同一 hermes 进程内内存会话必然存在。连接重建（进程死亡/主动
      // dispose）后确认集清空恢复 load；本轮 prompt 失败也会摘除标记。
      const skipLoad = hub.shouldSkipLoad(sessionId)
      if (!skipLoad) {
        const loaded = await hub
          .loadSession(hubConfig, sessionId)
          .catch(() => false)
        if (aborted) return stopEarly()
        if (!loaded) sessionId = null // hermes 忘了它（如清了 state.db）
      }
    }
    if (!sessionId) {
      // 分支对话（补刀·六十）：优先从主干会话 fork——hermes 侧 fork 复制
      // 完整对话上下文（分支的同时保留主干），不再是并列空会话。一次性
      // 消费标记（失败也消费，降级路径重建连续性）；失败静默降级项目 fork。
      // fork 成功不设 isNewSession：上下文已由 fork 携带，首轮直接发用户输入，
      // 不包 transcript（避免主干历史重复注入）。
      const forkSource = input.forkSourceSessionId
      if (forkSource) {
        input.onForkSourceConsumed?.()
        try {
          const forked = await hub.forkSession(hubConfig, forkSource)
          if (aborted) return stopEarly()
          sessionId = forked.sessionId
          input.onSessionBound?.(sessionId)
        } catch {
          /* 源会话失效 → 降级下方项目 fork 路径 */
        }
      }
    }
    if (!sessionId) {
      // 预热预备的 fork 子会话（warmup 后台已 fork 好）——直接绑定，
      // 省去项目会话 fork 的 ~2s（hermes 侧 fork 也要重建 AIAgent）。
      const readyFork = hub.takeReadyFork()
      if (readyFork) {
        sessionId = readyFork
        isNewSession = true
        input.onSessionBound?.(sessionId)
      } else {
        // 获取或创建项目会话（vault 级，持久化在 settings 中），
        // 再从项目 fork 出子会话用于本对话。
        const projectId = await getOrCreateProjectSession(
          hub, hubConfig, input.projectSessionId,
        )
        if (aborted) return stopEarly()
        input.onProjectSessionBound?.(projectId)

        const forked = await hub.forkSession(hubConfig, projectId)
        if (aborted) return stopEarly()
        sessionId = forked.sessionId
        isNewSession = true
        input.onSessionBound?.(sessionId)
      }
    }
    activeSessionId = sessionId

    // 审批模式与模型覆盖：每次幂等应用（设置改了立即生效）。
    // id 来源 = 该会话清单内选择（如有）> 设置值兜底——清单未就绪/未选
    // 过时行为与旧版完全一致（不阻断）。
    // 任务一 §1.1：set_mode 失败绝不静默吞掉——hermes state.db 按会话持久
    // 化模式，失败即沿旧模式跑（default 审批不弹的真机症状候选 b），必须
    // 显式 Notice 让用户知情；轮次本身不阻断。
    const overrides = input.getOverrides(activeSessionId)
    const modeToApply = overrides.mode ?? cfg.approvalMode
    try {
      await hub.setMode(hubConfig, activeSessionId, modeToApply)
    } catch (err) {
      new Notice(
        `Hermes 审批模式「${label(modeToApply)}」应用失败：${
          err instanceof Error ? err.message : String(err)
        }（本会话将沿用 hermes 侧当前模式，可用 /mode 重试）`,
      )
    }
    if (aborted) return stopEarly()
    const modelToApply = overrides.model ?? cfg.model.trim()
    if (modelToApply) {
      try {
        await hub.setModel(hubConfig, activeSessionId, modelToApply)
      } catch {
        /* 模型覆盖失败不致命，hermes 用自身默认 */
      }
    }
    if (aborted) return stopEarly()

    // ── 墙钟兜底：超时先 cancel，8s 后强制断连（仅限 prompt 未 settle）──
    const timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_WALL_TIMEOUT_MS
    wallTimer = setTimeout(() => {
      timedOut = true
      if (activeSessionId) hub.cancel(activeSessionId)
      disposeTimer = setTimeout(() => {
        // prompt 已 settle（连接健康）则不再 dispose——共享 hub 上可能
        // 还有其他会话的在途轮（评审修复 2）。
        if (timedOut && !promptSettled) hub.dispose()
      }, DISPOSE_AFTER_CANCEL_MS)
    }, timeoutMs)

    // ── prompt 文本：全新会话带人设+记忆+窗口保连续；续会话直接发。
    // 以 `/` 开头的 hermes 原生命令（/model /reset /compress…）跳过包裹原样
    // 发送——hermes ACP 的 _handle_slash_command 才能在会话上真正执行，
    // 而不是把命令当普通 prompt 混进人设+transcript。
    let promptText = input.userContent
    if (isNewSession && !input.userContent.trim().startsWith('/')) {
      let transcript = buildCompactTranscript(
        input.historyWindow.slice(-HERMES_CONTEXT_MAX_MESSAGES),
      )
      if (transcript.length > HERMES_CONTEXT_MAX_CHARS) {
        transcript = `…（更早内容省略）\n${transcript.slice(-HERMES_CONTEXT_MAX_CHARS)}`
      }
      // 记忆互通（「只打通不归并」）：插件侧 user.md/memory.md 冻结快照单向
      // 注入 hermes 首轮——hermes 自己的记忆体系不动。
      const memoryParts: string[] = []
      if (input.memory) {
        if (input.memory.user.length > 0) {
          memoryParts.push(`【用户画像】\n${input.memory.user.join('\n')}`)
        }
        if (input.memory.memory.length > 0) {
          memoryParts.push(`【长期记忆】\n${input.memory.memory.join('\n')}`)
        }
      }
      let memory = memoryParts.join('\n\n')
      if (memory.length > HERMES_MEMORY_MAX_CHARS) {
        memory = `${memory.slice(0, HERMES_MEMORY_MAX_CHARS)}\n…（更多条目省略）`
      }
      promptText = buildHermesChatPrompt({
        persona: input.persona,
        memory: memory || undefined,
        transcript: transcript || undefined,
        task: input.userContent,
      })
    }

    // ── 消费本轮：session/update → 消息块（rAF 合并交付） ──
    const turnState: HermesTurnState = { thinking: '' }
    const applyUpdate = (update: HermesSessionUpdate): void => {
      // M2-T4: available_commands_update 由 hub 的 routeNotification 按
      // sessionId 落缓存（到达即存，不依赖在途轮路由），这里无需再处理；
      // blockMapper 对未知帧类型走兜底忽略。
      const res = applyHermesUpdate(
        gotContent ? currentBlocks : [],
        turnState,
        update,
      )
      gotContent = true
      currentBlocks = res.blocks
      scheduleDelivery()
    }
    // abort 落在 prompt 发送前（解析/模式应用刚完成）→ 直接停止，本轮
    // 请求不再发起（onAbort 的 cancel 对未开始的 prompt 无意义）。
    if (aborted) return stopEarly()
    finishWith(failBlock('正在连接本机 Hermes…'))
    dlog(
      'info',
      'chat',
      `hermes acp turn agent=${input.agentLabel ?? '-'} session=${activeSessionId.slice(0, 8)}`,
    )
    try {
      const result = await hub.prompt(
        hubConfig,
        activeSessionId,
        promptText,
        applyUpdate,
      )
      stopReason = result.stopReason ?? ''
    } finally {
      // prompt 已 settle（评审修复 2）：挂着的 8s dispose 定时器作废。
      promptSettled = true
      if (wallTimer !== null) clearTimeout(wallTimer)
      if (disposeTimer !== null) clearTimeout(disposeTimer)
    }

    // 轮末思考兜底（M2-T8 接线）：帧流结束时仍有未归属任何工具的 thinking，
    // 固化成一张「思考」卡而不是无声丢弃。flush 本身幂等（固定 callId 原位
    // upsert）；未收到内容或超时的分支下面会整段替换，无需 flush。
    if (gotContent && !timedOut) {
      const flushed = flushHermesThinking(currentBlocks, turnState)
      if (flushed !== currentBlocks) {
        currentBlocks = flushed
      }
    }

    if (timedOut) {
      finishWith(
        failBlock(
          `Hermes 本轮超时（上限 ${Math.round(timeoutMs / 60000)} 分钟），已终止。`,
        ),
      )
    } else if (stopReason === 'cancelled') {
      if (!gotContent) {
        finishWith(failBlock('（已停止）'))
      } else {
        finishWith(currentBlocks)
      }
    } else if (!gotContent) {
      finishWith(failBlock('（Hermes 未返回内容）'))
    } else {
      finishWith(currentBlocks)
    }
    input.abortSignal.removeEventListener('abort', onAbort)
    return {
      sessionId: activeSessionId,
      gotContent,
      timedOut,
      stopReason,
      error: null,
    }
  } catch (err) {
    if (aborted) {
      // abort 后强断（8s 兜底 dispose）导致的连接错误：用户主动停止不是
      // 故障——以「已停止」收尾（保留已生成内容），不弹错误文案。
      return stopEarly()
    }
    if (wallTimer !== null) clearTimeout(wallTimer)
    const msg = err instanceof Error ? err.message : String(err)
    // M2-T3: initialize 明确无凭据或报错闻起来像缺凭据 → 报错后附配置指引
    // （端点走设置项 localAgent.guidedEndpoint，无硬编码 URL；叠加在 T6
    // 三分类文案之上，不替换原报错）。
    const guideHint = failureAuthHint({
      errorMessage: msg,
      noCredentials: hub.noCredentials,
      guidedEndpoint: cfg.guidedEndpoint ?? '',
    })
    finishWith(
      failBlock(
        `Hermes 会话出错：${msg}\n请确认 hermes 已安装并完成其模型配置（设置 → Hermes → 检测）。${guideHint}`,
      ),
    )
    input.abortSignal.removeEventListener('abort', onAbort)
    return {
      sessionId: activeSessionId,
      gotContent,
      timedOut,
      stopReason,
      error: msg,
    }
  }
}
