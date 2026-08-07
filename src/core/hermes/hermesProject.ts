// 显式项目层同步（Hermes「项目」= projects.db 里显式创建的工作区）。
//
// 背景：桌面端项目树分三层——显式项目（`hermes project create`，始终
// 显示）、auto 项目（无主会话按 cwd/git 归组的兜底）、Home 桶。会话按
// cwd（及 git 根）与项目 folders 做最深前缀匹配归入项目。没有与 vault
// 对应的显式项目时，对话只会落在某个父目录项目（如家目录 main）的仓库
// 节点下，桌面端项目区看不到「仓库名」项目——这是「历史对话没出现在
// 项目里」的根因（梦幻岛被 main 的 /Users/Zhuanz1 文件夹吸走的实例）。
//
// 本模块用 hermes CLI（spawn，runLocalAgent + PATH 兜底链）做幂等同步：
// `project list` 查 name → 缺失则 `project create <name> <vaultRoot>`
// （folders 第一个 = primary）。项目名 = vault 文件夹名（如「梦幻岛」）。
// 自动路径（ensureHermesProjectOnce）带模块级去重，供对话轮 fire-and-
// forget 后台兜底；手动路径（/hermes-init）调 ensureHermesProject 同步
// 执行并展开结果。新建项目后 Hermes 侧「最深文件夹优先」规则自然把 vault
// 会话从父目录项目手里夺回——插件无需干预归属。
//
// 移动端铁律：与 ACP 连接层同款——runLocalAgent 懒加载 spawn，移动端
// getDesktopSpawn 返回 null 直接报不可用，绝不触碰 Node API。

import { dlog } from '../../utils/diagnosticLog'
import {
  commandFallbacks,
  runLocalAgent,
  type SpawnLike,
} from '../desktop/localAgent'

export interface EnsureHermesProjectInput {
  /** hermes 可执行命令（设置 localAgent.command 兜底 DEFAULT_HERMES_COMMAND）。 */
  command: string
  /** vault 根路径（adapter.getBasePath()）——项目的 primary folder。 */
  vaultRoot: string
  /** 墙钟超时（ms）；<=0 或省略用默认 15s。 */
  timeoutMs?: number
}

export interface EnsureHermesProjectResult {
  ok: boolean
  /** 本轮实际创建了项目。 */
  created: boolean
  /** 项目名 = vault 文件夹名（幂等匹配键）。 */
  projectName: string
  /** 失败时的可读文案（命令 + exit + stderr 摘要）。 */
  error?: string
}

const DEFAULT_TIMEOUT_MS = 15000

/** vault 根 → 项目名（路径 basename）。 */
export function projectNameFromRoot(vaultRoot: string): string {
  return vaultRoot.split(/[\\/]/).filter(Boolean).pop() || vaultRoot
}

/** 解析 `hermes project list` 输出 → (slug, name) 列表。
 *  行格式：`{marker} {slug:<24} {name}{flags}  [{n} folder(s)]`；
 *  slug 规则保证无空白（小写字母数字连字符下划线），name 可含空格。
 *  默认 list 不含归档项目（--all 才显示）；空输出 / 「No projects yet」
 *  引导行无匹配 → []。 */
export function parseProjectList(
  stdout: string,
): { slug: string; name: string }[] {
  const out: { slug: string; name: string }[] = []
  for (const line of (stdout ?? '').split('\n')) {
    const m = /^[* ] (\S+)\s+(.+?)\s*\[\d+ folder\(s\)\]\s*$/.exec(line)
    if (m) out.push({ slug: m[1], name: m[2].trim() })
  }
  return out
}

function describeFailure(
  kind: string,
  r: { exitCode: number | null; stderrTail: string; error?: string },
): string {
  const detail =
    r.error || r.stderrTail.trim() || '未知错误'
  return `hermes project ${kind} 失败（exit ${r.exitCode ?? '?'}）：${detail.slice(
    0,
    200,
  )}`
}

/** 幂等确保 Hermes 侧存在当前 vault 对应的显式项目。never reject——一切
 *  失败（spawn 不可用、list/create 非零退出）落成 ok:false + 可读 error。 */
export async function ensureHermesProject(
  input: EnsureHermesProjectInput,
  spawnImpl?: SpawnLike,
): Promise<EnsureHermesProjectResult> {
  const projectName = projectNameFromRoot(input.vaultRoot)
  const base = {
    command: input.command,
    fallbackCommands: commandFallbacks(input.command),
    cwd: input.vaultRoot,
    timeoutMs:
      typeof input.timeoutMs === 'number' && input.timeoutMs > 0
        ? input.timeoutMs
        : DEFAULT_TIMEOUT_MS,
  }

  const list = await runLocalAgent(
    { ...base, args: ['project', 'list'] },
    spawnImpl,
  )
  if (!list.ok) {
    const err = describeFailure('list', list)
    dlog('warn', 'chat', `ensure hermes project: ${err}`)
    return { ok: false, created: false, projectName, error: err }
  }
  if (parseProjectList(list.output).some((p) => p.name === projectName)) {
    return { ok: true, created: false, projectName }
  }

  const created = await runLocalAgent(
    { ...base, args: ['project', 'create', projectName, input.vaultRoot] },
    spawnImpl,
  )
  if (!created.ok) {
    const err = describeFailure('create', created)
    dlog('warn', 'chat', `ensure hermes project: ${err}`)
    return { ok: false, created: false, projectName, error: err }
  }
  return { ok: true, created: true, projectName }
}

// 自动路径（对话轮 fire-and-forget）去重：同一次插件生命周期内同一 vault
// 只跑一次幂等检查；失败不缓存（下次触发重试，检查本身廉价）。
const autoEnsureCache = new Map<string, Promise<EnsureHermesProjectResult>>()

export function ensureHermesProjectOnce(
  input: EnsureHermesProjectInput,
  spawnImpl?: SpawnLike,
): Promise<EnsureHermesProjectResult> {
  const key = input.vaultRoot
  const existing = autoEnsureCache.get(key)
  if (existing) return existing
  const run = ensureHermesProject(input, spawnImpl).then((r) => {
    if (!r.ok) autoEnsureCache.delete(key)
    return r
  })
  autoEnsureCache.set(key, run)
  return run
}

/** 测试接缝：清空自动路径去重缓存。 */
export function resetHermesProjectCache(): void {
  autoEnsureCache.clear()
}
