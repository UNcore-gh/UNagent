import { FileSystemAdapter, Platform } from 'obsidian'

import { DEFAULT_HERMES_COMMAND } from '../desktop/localAgent'
import { getOrCreateProjectSession } from './runHermesTurn'
import type { HermesTurnHub } from './runHermesTurn'
import { getHermesHub } from './hermesHub'
import type { HermesHubConfig } from './hermesHub'

/** 预热需要的 hub 面 = 编排面（loadSession/newSession/forkSession）+ 连接。 */
export type HermesWarmupHub = HermesTurnHub & {
  ensureConnected(config: HermesHubConfig): Promise<unknown>
  /** 存入预备 fork 子会话（runHermesTurn 消费，省去发送时的 fork 等待）。 */
  setReadyFork(sessionId: string): void
}

/**
 * Hermes 连接预热（性能优化，2026-08-07）。
 *
 * hermes 侧 session/new 首次创建很慢（实测 3.7-9.9s：AIAgent 构造等 MCP
 * discovery 上限 1.5s + 模型目录网络拉取 ~1s + 冷 import ~1.4s，均为 hermes
 * 进程内固有成本，插件侧无法缩短）。预热把这段等待从「用户按下发送后」
 * 挪到「用户打字/切换模式时」的后台——首次发送时连接与会话已就绪，感知
 * 延迟趋近于零。
 *
 * 幂等：同一 Obsidian 生命周期只预热一次（成功即常驻；失败置空允许重试，
 * 静默不打扰——正式发送路径会再次尝试并给出用户可见错误）。
 */
export interface HermesWarmupOptions {
  /** localAgent.enabled 且非移动端才预热（与 send 路径同一门控）。 */
  enabled: boolean
  isMobile: boolean
  /** 非文件系统 vault（无本地路径）无法 spawn——上层传 null 跳过。 */
  cwd: string | null
  command: string
  hub: HermesWarmupHub
  projectSessionId: string | null
  /** 项目会话就绪后的落盘回调（settings.localAgent.projectSessionId）。 */
  onProjectSessionBound: (projectId: string) => void
}

/** 预热组装所需的最小插件面（main.ts onload 与 useAgent 共用同一组装逻辑）。 */
export interface HermesWarmupHost {
  settings: {
    localAgent?: {
      enabled?: boolean
      command?: string
      projectSessionId?: string | null
    }
  }
  app: { vault: { adapter: unknown } }
  saveSettings(): Promise<void>
}

/**
 * 从插件实例组装预热参数（纯函数，门控内置）：未启用 / 移动端 / 非文件
 * 系统 vault（无本地路径可 spawn）返回 null——调用方据此零成本跳过。
 */
export function buildHermesWarmupOptions(
  host: HermesWarmupHost,
): Omit<HermesWarmupOptions, 'hub'> | null {
  const block = host.settings.localAgent
  if (Platform.isMobile || !block || block.enabled !== true) return null
  if (!(host.app.vault.adapter instanceof FileSystemAdapter)) return null
  return {
    enabled: true,
    isMobile: false,
    command: block.command?.trim() || DEFAULT_HERMES_COMMAND,
    cwd: (host.app.vault.adapter as FileSystemAdapter).getBasePath(),
    projectSessionId: block.projectSessionId ?? null,
    onProjectSessionBound: (projectId) => {
      // 项目会话就绪后落盘，重启后直接 load 复用而非重新 newSession。
      if (block.projectSessionId !== projectId) {
        block.projectSessionId = projectId
        void host.saveSettings()
      }
    },
  }
}

/**
 * 从插件实例触发后台预热（幂等，fire-and-forget，永不 reject）——插件
 * onload 与用户交互（Composer 输入/切换模式/打开会话）共用同一入口。
 */
export function warmupHermesNow(host: HermesWarmupHost): void {
  const base = buildHermesWarmupOptions(host)
  if (!base) return
  warmupHermesOnce({ ...base, hub: getHermesHub() })
}

let warmupPromise: Promise<void> | null = null

/** 仅供测试：重置预热状态（允许重新预热）。 */
export function resetHermesWarmup(): void {
  warmupPromise = null
}

/** Fire-and-forget：后台确保 hermes 进程 + 项目会话就绪。永不 reject。 */
export function warmupHermesOnce(opts: HermesWarmupOptions): void {
  if (opts.isMobile || !opts.enabled || !opts.cwd) return
  if (warmupPromise) return
  const config: HermesHubConfig = { command: opts.command, cwd: opts.cwd }
  warmupPromise = (async () => {
    try {
      // 档 1：进程 + initialize 握手（~0.6s）。
      await opts.hub.ensureConnected(config)
      // 档 2：项目会话 load/new（3.7-9.9s 的重头）。getOrCreateProjectSession
      // 自带 per-cwd 并发锁——与正式发送同时到达时共享同一 promise，不会
      // 双创建孤儿会话。
      const projectId = await getOrCreateProjectSession(
        opts.hub,
        config,
        opts.projectSessionId,
      )
      opts.onProjectSessionBound(projectId)
      // 档 3：从项目会话 fork 预备子会话（~2s，hermes 侧 fork 也要重建
      // AIAgent）——首次发送时 runHermesTurn 直接消费，省掉最后一段等待。
      const forked = await opts.hub.forkSession(config, projectId)
      opts.hub.setReadyFork(forked.sessionId)
    } catch {
      // 预热失败静默（如 hermes 未安装/凭据缺失）——正式路径会再次尝试并
      // 给出用户可见错误；置空让下一次触发可重试。
      warmupPromise = null
    }
  })()
}
