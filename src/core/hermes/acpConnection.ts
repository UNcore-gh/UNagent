// ACP transport (补刀·五十六): spawns `hermes acp` and speaks
// newline-delimited JSON-RPC 2.0 over stdio. Three inbound frame classes —
// responses to our requests, notifications (session/update…), and REVERSE
// requests from the server (session/request_permission) that we must answer
// or hermes fail-closed-denies after 60s. stdout is protocol-only (hermes
// logs go to stderr), so line-splitting stdout is safe. Launch reuses the
// desktop spawn helpers incl. the macOS GUI PATH fallback chain (补刀·五十四).

import {
  buildDesktopEnv,
  commandFallbacks,
  getDesktopSpawn,
  type SpawnLike,
} from '../desktop/localAgent'
import { parseAuthMethods, needsCredentialSetup } from './authGuide'
import type {
  AcpAuthMethod,
  InitializeResult,
  JsonRpcFrame,
  PermissionDecision,
} from './types'

/* ── 错误三分类（M2-T6 生命周期韧性）────────────────────────────────── */

/** 本插件讲的 ACP 协议版本（initialize 握手用；hermes 侧见 acp_adapter/server.py）。 */
export const ACP_PROTOCOL_VERSION = 1

/** 连接失败三分类：未安装/PATH 找不到 · 启动失败（握手前退出）· 运行中崩溃。 */
export type HermesFailureKind = 'not_installed' | 'launch_failed' | 'runtime_crash'

/** 连接层错误：kind 为三分类之一，message 即面向用户的中文排查指引。 */
export class AcpConnectionError extends Error {
  constructor(
    readonly kind: HermesFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'AcpConnectionError'
  }
}

export interface ConnectionFailureInput {
  /** launch=PATH 回退链全部失败；handshake=initialize 完成前进程退出；
   *  running=运行中（prompt 期间）stdio 关闭/进程退出。 */
  phase: 'launch' | 'handshake' | 'running'
  /** 原始错误信息（附加展示，便于排查）。 */
  detail?: string
  /** 进程退出码（null/undefined = 未知或被信号杀死）。 */
  exitCode?: number | null
}

function exitHint(exitCode: number | null | undefined): string {
  if (exitCode === undefined || exitCode === null) return '（退出码未知，可能被信号杀死）'
  if (exitCode === 0) return ''
  return `（退出码 ${exitCode}）`
}

/** 纯映射：失败场景 → 三分类错误（message 为用户可读排查指引）。M2-T6。 */
export function classifyConnectionFailure(
  input: ConnectionFailureInput,
): AcpConnectionError {
  const detail = input.detail ? `\n原始错误：${input.detail}` : ''
  switch (input.phase) {
    case 'launch':
      return new AcpConnectionError(
        'not_installed',
        '未找到 Hermes 命令：所有常见安装路径都尝试失败。' +
          '请确认 hermes 已安装且在终端可正常运行；或在「设置 → Hermes」的「命令」中填写完整安装路径，再点「检测」验证。' +
          detail,
      )
    case 'handshake':
      return new AcpConnectionError(
        'launch_failed',
        `Hermes 进程在 ACP 握手完成前就退出了${exitHint(input.exitCode)}。` +
          '常见原因：hermes 自身尚未完成配置（缺少模型/接口密钥）、Python 环境损坏、或 acp 子命令启动失败。' +
          '请在终端手动运行 `hermes acp` 查看报错输出。' +
          detail,
      )
    case 'running':
      return new AcpConnectionError(
        'runtime_crash',
        `Hermes 进程在运行中崩溃${exitHint(input.exitCode)}，连接已断开；本轮回复无法完成，请重新发送（插件会自动重连）。` +
          '若反复崩溃，请升级 hermes 到最新版本，或在终端手动运行 `hermes acp` 复现排查。' +
          detail,
      )
  }
}

/** 纯映射：initialize 返回的协议版本与期望比对，匹配返回 ''。
 *  hermes 升级导致协议不兼容是最常见真机事故，故只告警不断连（M2-T6）。 */
export function protocolVersionWarning(serverVersion: unknown): string {
  if (serverVersion === ACP_PROTOCOL_VERSION) return ''
  const shown =
    typeof serverVersion === 'number' ? `v${serverVersion}` : '未知版本'
  return (
    `Hermes ACP 协议版本不匹配（插件期望 v${ACP_PROTOCOL_VERSION}，hermes 返回 ${shown}）。` +
    '最常见原因是 hermes 升级到了插件尚不支持的新版协议，部分功能可能异常；可尝试降级 hermes 或等待插件更新。'
  )
}

/** Reverse request the UI layer must decide on (permission prompts). */
export interface ServerRequestEvent {
  id: number
  method: string
  params: unknown
}

export interface AcpConnectionHandlers {
  /** Notifications (session/update, usage, commands…). */
  onNotification: (method: string, params: unknown) => void
  /** Reverse requests — answer with respondToServerRequest (or fail-closed). */
  onServerRequest: (req: ServerRequestEvent) => void
  /** Process died (code null = signal/unknown). */
  onExit: (code: number | null) => void
  /** Collected stderr lines (diagnostics only). */
  onStderr?: (chunk: string) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 20_000
const STDERR_CAP = 64 * 1024

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** 最近一次启动成功的命令（PATH 回退探测缓存）。
 *  Finder 启动的 Obsidian 不带 shell PATH——裸命令常 ENOENT，首次连接要试
 *  完整回退链（每次失败尝试都有进程启动开销）。记住成功的那一个，进程
 *  崩溃自愈重连时直接命中，不再重复探测。失败即清空，避免死缓存。 */
let lastGoodCommand: string | null = null

/** 仅供测试：重置命令缓存。 */
export function resetAcpCommandCache(): void {
  lastGoodCommand = null
}

export class AcpConnection {
  private child: unknown = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuf = ''
  private stderrBuf = ''
  private exited = false
  private exitCode: number | null = null

  private constructor(
    private readonly handlers: AcpConnectionHandlers,
  ) {}

  /**
   * Spawn + initialize handshake. Tries `command`, then the PATH-fallback
   * candidates, but ONLY for launch-level failures (ENOENT/EACCES) — an
   * initialize error from a running process is a real error, not a reason to
   * try another binary.
   */
  static async connect(opts: {
    command: string
    cwd: string
    handlers: AcpConnectionHandlers
    spawnImpl?: SpawnLike
    args?: string[]
  }): Promise<AcpConnection> {
    const spawnFn = opts.spawnImpl ?? getDesktopSpawn()
    if (!spawnFn) throw new Error('spawn_unavailable')
    // 上次成功命令优先（与当前配置命令不同才插入；相同则本就在首位）。
    const base = [opts.command, ...commandFallbacks(opts.command)]
    const candidates =
      lastGoodCommand && lastGoodCommand !== opts.command
        ? [lastGoodCommand, ...base]
        : base
    const seen = new Set<string>()
    let lastLaunchError = ''
    for (const cand of candidates) {
      if (!cand || seen.has(cand)) continue
      seen.add(cand)
      try {
        const conn = await AcpConnection.tryConnect(spawnFn, cand, opts)
        lastGoodCommand = cand
        return conn
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/ENOENT|EACCES|not found/i.test(msg)) throw err
        if (cand === lastGoodCommand) lastGoodCommand = null
        lastLaunchError = msg
      }
    }
    // PATH 回退链（commandFallbacks）全部失败 = 未安装/找不到（M2-T6 三分类①）。
    // 回退机制本身不动，仅给最终报错挂上分类与排查指引。
    throw classifyConnectionFailure({
      phase: 'launch',
      ...(lastLaunchError ? { detail: lastLaunchError } : {}),
    })
  }

  private static async tryConnect(
    spawnFn: SpawnLike,
    command: string,
    opts: {
      cwd: string
      handlers: AcpConnectionHandlers
      args?: string[]
    },
  ): Promise<AcpConnection> {
    const conn = new AcpConnection(opts.handlers)
    const child = spawnFn(command, opts.args ?? ['acp'], {
      cwd: opts.cwd,
      env: {
        ...buildDesktopEnv(),
        // Hermes 官方建议：跳过启动时加载全局 MCP，加快 initialize。
        HERMES_ACP_SKIP_CONFIGURED_MCP: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    conn.child = child

    const proc = child as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): unknown
      kill(signal?: NodeJS.Signals): boolean
    }
    const stdout = (child as unknown as {
      stdout: { on(event: string, listener: (c: Buffer) => void): unknown } | null
    }).stdout
    const stderr = (child as unknown as {
      stderr: { on(event: string, listener: (c: Buffer) => void): unknown } | null
    }).stderr

    stdout?.on('data', (chunk: Buffer) => conn.onStdoutChunk(chunk))
    stderr?.on('data', (chunk: Buffer) => conn.onStderrChunk(chunk))
    proc.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!conn.handshakeDone && /ENOENT|EACCES|not found/i.test(message)) {
        // Pre-handshake launch failure: fail the pending initialize with the
        // RAW message so connect() can try the next fallback candidate.
        conn.failAllPending(new Error(message))
      } else {
        // 握手后的 error（stdio/进程级）= 运行中崩溃；握手中非 ENOENT = 启动失败。
        conn.failAllPending(
          classifyConnectionFailure({
            phase: conn.handshakeDone ? 'running' : 'handshake',
            detail: message,
          }),
        )
      }
      conn.markExited(null)
    })
    proc.on('close', (code: unknown) => {
      const exit = typeof code === 'number' ? code : null
      // 握手完成前退出 = 启动失败（三分类②）；之后 = 运行中崩溃（三分类③）。
      conn.failAllPending(
        conn.handshakeDone
          ? classifyConnectionFailure({ phase: 'running', exitCode: exit })
          : classifyConnectionFailure({ phase: 'handshake', exitCode: exit }),
      )
      conn.markExited(exit)
    })

    // Handshake: hermes does no version negotiation (it always answers with
    // its own PROTOCOL_VERSION); clientInfo is for its logs.
    const result = (await conn.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'UNagent', version: '0.2.0' },
      },
      INITIALIZE_TIMEOUT_MS,
    )) as InitializeResult
    conn.handshakeDone = true
    conn.agentVersion = result?.agentInfo?.version ?? ''
    // protocolVersion 比对（M2-T6）：hermes 返回的是它自己的协议版本，
    // 不匹配 = hermes 升级/版本不兼容的最常见信号——只告警不断连。
    const warning = protocolVersionWarning(result?.protocolVersion)
    if (warning) {
      conn.protocolWarning = warning
      console.warn(`[UNagent] ${warning}`)
    }
    // M2-T3: 接住 initialize 通告的 auth_methods——只剩 'hermes-setup'
    // 终端入口 = hermes 未配置任何 provider 凭据（noCredentials=true，
    // 设置页与失败提示据此展示配置指引）。叠加在 T6 三分类之上，
    // 不改变连接结果与任何既有回退。老版 hermes 不带该字段 → 空数组，
    // noCredentials 保持 false（未知 ≠ 无凭据）。
    conn.authMethods = parseAuthMethods(result?.authMethods)
    conn.noCredentials = needsCredentialSetup(conn.authMethods)
    return conn
  }

  /** hermes version reported by initialize ('' until connected). */
  agentVersion = ''

  /** initialize 协议版本不匹配告警文案（'' = 正常）。只告警不断连（M2-T6）。 */
  protocolWarning = ''

  /** initialize 通告的 auth methods（M2-T3；空数组 = 老版 hermes 未通告）。 */
  authMethods: AcpAuthMethod[] = []

  /** initialize 明确告知无可用 provider 凭据（auth_methods 只剩
   *  'hermes-setup' 终端配置入口）。M2-T3。 */
  noCredentials = false

  /** initialize 握手是否已完成——区分「启动失败」与「运行中崩溃」的界标。 */
  private handshakeDone = false

  /** Send a request; resolves with `result`, rejects on JSON-RPC error or
   *  timeout. `timeoutMs <= 0` = wait forever (session/prompt does). */
  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('hermes acp 进程已退出'))
    const id = this.nextId++
    this.writeFrame({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject, timer: null }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`))
          }
        }, timeoutMs)
      }
      this.pending.set(id, entry)
    })
  }

  /** Fire-and-forget notification (session/cancel has no response). */
  notify(method: string, params: unknown): void {
    if (this.exited) return
    this.writeFrame({ jsonrpc: '2.0', method, params })
  }

  /** Answer a server→client request (permission decisions). */
  respondToServerRequest(id: number, decision: PermissionDecision): void {
    if (this.exited) return
    const result = decision.optionId
      ? { outcome: { outcome: 'selected', optionId: decision.optionId } }
      : { outcome: { outcome: 'cancelled' } }
    this.writeFrame({ jsonrpc: '2.0', id, result })
  }

  get alive(): boolean {
    return !this.exited
  }

  get stderrTail(): string {
    return this.stderrBuf.slice(-4000)
  }

  dispose(): void {
    if (this.exited) return
    const proc = this.child as unknown as {
      kill?: (signal?: NodeJS.Signals) => boolean
    } | null
    try {
      proc?.kill?.('SIGTERM')
    } catch {
      /* already dead */
    }
    const killTimer = setTimeout(() => {
      try {
        proc?.kill?.('SIGKILL')
      } catch {
        /* already dead */
      }
    }, 3000)
    // Never let the grace timer pin the process open.
    try {
      ;(killTimer as unknown as { unref?: () => void }).unref?.()
    } catch {
      /* browser env without unref */
    }
    this.failAllPending(new Error('连接已关闭'))
    this.markExited(this.exitCode)
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private markExited(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    this.handlers.onExit(code)
  }

  private failAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(err)
      void id
    }
  }

  private writeFrame(frame: unknown): void {
    const stdin = (this.child as unknown as {
      stdin: { write(data: string): unknown } | null
    } | null)?.stdin
    if (!stdin) return
    try {
      stdin.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // The pipe broke; the close handler will settle everything.
    }
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString('utf8')
    let nl = this.stdoutBuf.indexOf('\n')
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line) this.dispatchLine(line)
      nl = this.stdoutBuf.indexOf('\n')
    }
  }

  private onStderrChunk(chunk: Buffer): void {
    const text = chunk.toString('utf8')
    this.stderrBuf = (this.stderrBuf + text).slice(-STDERR_CAP)
    this.handlers.onStderr?.(text)
  }

  private dispatchLine(line: string): void {
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(line) as JsonRpcFrame
    } catch {
      return // hermes guarantees protocol purity; ignore stray noise
    }
    const hasId = typeof (frame as { id?: unknown }).id === 'number'
    const method = (frame as { method?: unknown }).method
    if (typeof method === 'string' && hasId) {
      // Reverse request from the server (session/request_permission…).
      this.handlers.onServerRequest({
        id: (frame as { id: number }).id,
        method,
        params: (frame as { params?: unknown }).params,
      })
      return
    }
    if (typeof method === 'string') {
      this.handlers.onNotification(method, (frame as { params?: unknown }).params)
      return
    }
    if (hasId) {
      const id = (frame as { id: number }).id
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      const error = (frame as { error?: { code: number; message: string } }).error
      if (error) {
        entry.reject(new Error(`${error.message}（code ${error.code}）`))
      } else {
        entry.resolve((frame as { result?: unknown }).result)
      }
    }
  }
}
