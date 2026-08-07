// 本地 agent 子进程层（共享桌面工具）。
//
// 提供给 hermes ACP 会话（core/hermes/acpConnection）与设置「检测 Hermes」
// 按钮用的通用 spawn 执行器（runLocalAgent，含 macOS GUI PATH 兜底）以及
// 对话提示词拼接（buildHermesChatPrompt）。跑 `hermes -z` one-shot 的
// run_local_agent 工具已在能力门控收口时移除（/hermes 任务分发取代它）。
//
// macOS GUI PATH 坑：Finder 启动的 Obsidian 不继承用户 shell 的 PATH
// （launchctl getenv PATH 通常为空 → 进程只拿系统最小 PATH），裸命令
// `hermes` 装在 ~/.local/bin / homebrew 时直接 ENOENT。两层保险：spawn 的
// env.PATH 前置常见 bin 目录；裸命令启动失败（ENOENT/EACCES）时按
// commandFallbacks 顺序重试常见安装路径。
//
// 移动端铁律：本模块是唯一允许触碰本地进程的地方，且只在桌面端可达——
// ACP 连接层经 getDesktopSpawn 懒加载守卫，移动端代码路径永远走不到
// require('child_process')。

import { Platform } from 'obsidian'

/** Default hermes command when the setting is left blank. Shared by the ACP
 *  session path and the settings "检测 Hermes" button. */
export const DEFAULT_HERMES_COMMAND = 'hermes'

/** Tool-output cap (与 MCP 结果截断同款 2 万字符)。 */
export const MAX_OUTPUT_CHARS = 20000
/** Per-stream capture ceiling — protect webview memory from chatty agents. */
const MAX_CAPTURE_BYTES = 1_000_000
/** stderr tail kept for error surfacing. */
const STDERR_TAIL_CHARS = 2000
/** SIGTERM → SIGKILL grace period on timeout/abort. */
const KILL_GRACE_MS = 3000

export interface LocalAgentResult {
  ok: boolean
  /** stdout (final answer), capped at MAX_OUTPUT_CHARS. */
  output: string
  /** Last chunk of stderr — only meaningful on failure. */
  stderrTail: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  durationMs: number
  /** Spawn-level failure detail (e.g. "spawn hermes ENOENT"). */
  error?: string
}

export interface RunLocalAgentOptions {
  command: string
  /** Tried in order after `command` when it fails to LAUNCH (ENOENT/EACCES)
   *  — the macOS GUI PATH pitfall. Never used for exit-level failures. */
  fallbackCommands?: string[]
  args: string[]
  /** Working directory for the child (the vault root). */
  cwd: string
  /** Wall-clock timeout in ms; <=0 disables (not recommended). */
  timeoutMs: number
  /** Caller abort (the chat stop button) kills the child. */
  signal?: AbortSignal
  /** Extra env vars merged over the desktop base env (e.g. COLUMNS to widen
   *  Rich-table CLI output so long skill names aren't truncated). */
  env?: Record<string, string>
}

/** Narrow structural view of a spawned child — the DI seam tests fake. */
export interface LocalAgentChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', listener: (err: Error) => void): unknown
  on(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => LocalAgentChild

/** Parse the first line of `hermes --version` output ("Hermes Agent v0.19.1 (...)"). */
export function parseHermesVersion(stdout: string): string | null {
  const first = (stdout ?? '').split('\n')[0]?.trim()
  if (!first) return null
  return /^Hermes Agent v/i.test(first) ? first : null
}

/** Cap an output string; reports whether it was cut. */
export function truncateOutput(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `${text.slice(0, max)}\n…（输出过长已截断）`,
    truncated: true,
  }
}

function homeDir(): string {
  try {
    return process.env.HOME ?? ''
  } catch {
    return ''
  }
}

/**
 * Candidate absolute paths for a BARE command (no path separator) — the
 * launch fallbacks for the macOS GUI PATH pitfall. Absolute commands are
 * returned as-is ([] = nothing to fall back to). Pure & testable.
 */
export function commandFallbacks(command: string): string[] {
  const cmd = command.trim()
  if (!cmd || cmd.includes('/')) return []
  const home = homeDir()
  const out: string[] = []
  if (home) {
    // hermes 官方安装器（git/脚本）的 shim 位置 + 实际 venv 入口。
    out.push(`${home}/.local/bin/${cmd}`)
    out.push(`${home}/.hermes/hermes-agent/venv/bin/${cmd}`)
  }
  out.push(`/opt/homebrew/bin/${cmd}`, `/usr/local/bin/${cmd}`)
  return out
}

/** Context window caps for the conversational mode (补刀·五十五: hermes
 *  引擎代理轮）。hermes -z 是无状态 one-shot，连续性靠把最近的对话实录拼
 *  进任务描述——窗口要有界，长对话不能无限膨胀提示词。 */
export const HERMES_CONTEXT_MAX_MESSAGES = 20
export const HERMES_CONTEXT_MAX_CHARS = 12000
/** 记忆互通（HERMES_GATING_PLAN 后续③，「只打通不归并」）：插件侧
 *  user.md/memory.md 快照注入 hermes 新会话首轮的字符上限——记忆是
 *  辅助背景，不能挤掉对话实录的预算。 */
export const HERMES_MEMORY_MAX_CHARS = 4000

export interface HermesChatPromptOptions {
  /** 人设正文（hermes 引擎代理的 subagent.md body）；/hermes 任务分发不传。 */
  persona?: string
  /** 插件侧记忆/画像快照（已格式化、已截窗）；新建会话首轮传入。 */
  memory?: string
  /** 最近对话实录（用户：/助手： 行，已截窗）；新建会话首轮传入。 */
  transcript?: string
  /** 用户本轮输入。 */
  task: string
}

/**
 * 对话式委托的提示词：人设 + 记忆 + 最近实录 + 最新输入。纯拼接、可测。
 * /hermes 任务分发与 engine:hermes 会话共用（追加90：/hermes 不再是
 * 一次性旁问，新建会话首轮同样带对话实录）。
 */
export function buildHermesChatPrompt(opts: HermesChatPromptOptions): string {
  const parts: string[] = []
  const persona = (opts.persona ?? '').trim()
  const memory = (opts.memory ?? '').trim()
  const transcript = (opts.transcript ?? '').trim()
  if (persona) {
    parts.push(`以下是你的人格设定，请按此人设行事：\n${persona}`)
  }
  if (memory) {
    parts.push(
      `以下是 Obsidian 插件侧积累的用户画像与长期记忆（供背景参考，不必逐条回应）：\n${memory}`,
    )
  }
  if (transcript) {
    parts.push(`以下是你与用户最近的对话实录（供上下文参考）：\n${transcript}`)
  }
  parts.push(`用户的最新输入：\n${opts.task.trim()}`)
  parts.push(
    '请直接回应用户的最新输入。若任务涉及笔记库，当前工作目录就是库根，你可以自行查看笔记。',
  )
  return parts.join('\n\n')
}

/** process.env + 常见 bin 目录前置——GUI 进程的最小 PATH 补全，子进程自己
 *  再找 git/python 等也受益。导出供 ACP 连接层复用（补刀·五十六）。 */
export function buildDesktopEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
  } catch {
    // process.env 不可用时给最小有用集。
  }
  const home = env.HOME ?? ''
  const extras = [
    home ? `${home}/.local/bin` : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((s) => s !== '')
  env.PATH = [...extras, env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':')
  return env
}

// Lazy, cached, desktop-only resolution of Node's spawn. Bundler keeps this
// as a runtime require (esbuild external 已含全部 node 内置模块)；桌面版
// Obsidian 的 CJS 运行时提供 require。
let cachedSpawn: SpawnLike | null | undefined

export function getDesktopSpawn(): SpawnLike | null {
  if (cachedSpawn !== undefined) return cachedSpawn
  if (Platform.isMobile) {
    cachedSpawn = null
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = require('child_process') as { spawn?: unknown }
    cachedSpawn =
      typeof cp?.spawn === 'function'
        ? (cp.spawn as unknown as SpawnLike)
        : null
  } catch {
    cachedSpawn = null
  }
  return cachedSpawn
}

/**
 * Detach-spawn one local command and return immediately (fire-and-forget).
 *
 * runLocalAgent waits for exit and kills the tree on timeout — launching a
 * long-lived GUI app (`hermes desktop` is a blocking subprocess.run until
 * the Electron app quits) through it would freeze the plugin for the app's
 * lifetime and SIGTERM the app when the wall clock expires. This spawns the
 * child fully detached (detached: true + stdio ignore + unref) so it
 * outlives the plugin process and nobody waits on it. Spawn errors are
 * swallowed (a detached child has no reporting channel); returns false only
 * when spawn is unavailable or throws synchronously.
 */
export function spawnDetachedLocal(
  command: string,
  args: string[],
  opts: { cwd: string },
  spawnImpl?: SpawnLike,
  /** 附加环境变量，合并到 buildDesktopEnv() 之上——用于向桌面应用传递会话 ID 等上下文。 */
  extraEnv?: Record<string, string>,
): boolean {
  const spawnFn = spawnImpl ?? getDesktopSpawn()
  if (!spawnFn) return false
  try {
    const child = spawnFn(command, args, {
      cwd: opts.cwd,
      env: { ...buildDesktopEnv(), ...extraEnv },
      stdio: 'ignore',
      detached: true,
    })
    // Swallow async spawn failures ('error' on an EventEmitter without a
    // listener throws) — the detached child has no reporting channel.
    child.on('error', () => {
      /* fire-and-forget: nothing to report */
    })
    // Nobody waits on this child — keep the event loop clear.
    const withUnref = child as LocalAgentChild & { unref?: () => void }
    if (typeof withUnref.unref === 'function') withUnref.unref()
    return true
  } catch {
    return false
  }
}

/** Spawn-level error messages that mean "this executable can't be launched"
 *  (vs. runtime failures) — only these trigger the fallback chain. */
function isLaunchError(message: string): boolean {
  return /ENOENT|EACCES|not found/i.test(message)
}

/**
 * Run one local-agent task. NEVER rejects — every failure mode (spawn error,
 * non-zero exit, timeout, abort) resolves to a result object, so the tool
 * layer stays a straight mapping. `spawnImpl` is the test seam.
 */
export function runLocalAgent(
  opts: RunLocalAgentOptions,
  spawnImpl?: SpawnLike,
): Promise<LocalAgentResult> {
  const spawnFn = spawnImpl ?? getDesktopSpawn()
  if (!spawnFn) {
    return Promise.resolve({
      ok: false,
      output: '',
      stderrTail: '',
      exitCode: null,
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 0,
      error: 'spawn_unavailable',
    })
  }
  const attempts = [opts.command, ...(opts.fallbackCommands ?? [])]
  return runAttempt(spawnFn, opts, attempts, 0, Date.now())
}

function runAttempt(
  spawnFn: SpawnLike,
  opts: RunLocalAgentOptions,
  attempts: string[],
  idx: number,
  started: number,
): Promise<LocalAgentResult> {
  return new Promise<LocalAgentResult>((resolve) => {
    // Wall-clock budget is shared across fallback attempts.
    const remainingMs =
      opts.timeoutMs > 0 ? opts.timeoutMs - (Date.now() - started) : 0
    if (opts.timeoutMs > 0 && remainingMs <= 0) {
      resolve({
        ok: false,
        output: '',
        stderrTail: '',
        exitCode: null,
        timedOut: true,
        aborted: false,
        truncated: false,
        durationMs: Date.now() - started,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let aborted = false
    let spawnError = ''
    let lastExitCode: number | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const settle = (): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      const trunc = truncateOutput(stdout, MAX_OUTPUT_CHARS)
      resolve({
        ok: !timedOut && !aborted && !spawnError && lastExitCode === 0,
        output: trunc.text,
        stderrTail: stderr.slice(-STDERR_TAIL_CHARS),
        exitCode: lastExitCode,
        timedOut,
        aborted,
        truncated: trunc.truncated,
        durationMs: Date.now() - started,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }

    let child: LocalAgentChild
    try {
      child = spawnFn(attempts[idx], opts.args, {
        cwd: opts.cwd,
        env: { ...buildDesktopEnv(), ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isLaunchError(msg) && idx + 1 < attempts.length) {
        resolve(runAttempt(spawnFn, opts, attempts, idx + 1, started))
        return
      }
      spawnError = msg
      settle()
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_CAPTURE_BYTES) return
      stdout += chunk.toString('utf8')
      stdoutBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_CAPTURE_BYTES) return
      stderr += chunk.toString('utf8')
      stderrBytes += chunk.length
    })
    child.on('error', (err: Error) => {
      // Spawn-level failure (ENOENT, EACCES…) — 'close' may never follow.
      // GUI PATH pitfall: fall back to the next candidate path if any.
      const msg = err.message || String(err)
      if (isLaunchError(msg) && idx + 1 < attempts.length) {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        resolve(runAttempt(spawnFn, opts, attempts, idx + 1, started))
        return
      }
      spawnError = msg
      settle()
    })
    child.on('close', (code: number | null) => {
      lastExitCode = typeof code === 'number' ? code : null
      settle()
    })

    const killChild = (): void => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS)
    }

    if (opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        killChild()
      }, remainingMs)
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        aborted = true
        killChild()
      } else {
        opts.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            killChild()
          },
          { once: true },
        )
      }
    }
  })
}
