// Hermes 侧技能清单（`hermes skills list`）——「//」双斜杠选择器的数据面。
//
// 背景：hermes 的技能体系独立于插件（~/.hermes/skills/ 等，`hermes skills`
// 管理），其技能命令是单斜杠形态（/技能名）。插件 hermes 模式复刻主 agent
// 的「//」唤起体验（补刀·五十七）：面板弹 hermes 技能清单，发送时把
// //技能名 转成 hermes 原生的 /技能名 透传。ACP 面对未知斜杠命令
// fall-through 当正文，hermes 模型凭系统提示里的技能索引自行 skill_view
// 加载——hermes 的 CLI/gateway 技能命令软件层展开面不经过 ACP，插件侧不做
// 正文重写（那是模型理解型，不是软件处理型）。
//
// 实现：与 hermesProject.ts 同款——runLocalAgent（spawn + PATH 兜底链），
// 纯函数解析表格，never reject。Rich 表格在窄终端会把长名字截断成
// `name…`，拉取时显式传 COLUMNS=300 加宽（本地 agent env 透传通道）。
// 移动端铁律：runLocalAgent 懒加载 spawn，移动端 getDesktopSpawn 返回
// null 直接报不可用，绝不触碰 Node API。
//
// 数据说明（补刀·五十八）：`hermes skills list` 表格原生五列 = Name /
// Category / Source / Trust / Status，没有 description 列——因此本模块
// 只提供这五列里的真实差异信息（Category 技能分类、Source 来源三态
// local/builtin/official），不手编假描述；列表无分类的 local 技能就
// 显示空描述，交给面板用「用户」徽章标注自装来源。

import { dlog } from '../../utils/diagnosticLog'
import {
  commandFallbacks,
  runLocalAgent,
  type SpawnLike,
} from '../desktop/localAgent'

/** `hermes skills list` 表格的一行技能：Name + 原生差异信息
 *  （Category 分类 / Source 来源三态 local|builtin|official）。
 *  表格无 description 列——描述缺失是原生事实，不手编占位。 */
export interface HermesSkillInfo {
  /** 技能命令名（/技能名 形态的 slug）。 */
  name: string
  /** 分类（表格 Category 列；local 技能常为空串）。 */
  category: string
  /** 来源（表格 Source 列：local | builtin | official | hub）。 */
  source: string
}

/** 解析 `hermes skills list` 的 Rich 表格 → 技能信息列表。
 *  行形态：`┃ Name ┃ Category ┃ Source ┃ …┃`（表头）/ `│ … │`（数据行）/ 
 *  `┏━┳━┓` 等框线行。列序固定：cells[1]=Name、cells[2]=Category、
 *  cells[3]=Source；跳过表头、框线与空行；非表格输出（错误消息等）
 *  天然无匹配 → []。 */
export function parseHermesSkillsTable(stdout: string): HermesSkillInfo[] {
  const out: HermesSkillInfo[] = []
  for (const line of (stdout ?? '').split('\n')) {
    if (!/[│┃]/.test(line)) continue
    if (line.includes('━')) continue
    const cells = line.split(/[│┃]/)
    const name = (cells[1] ?? '').trim()
    if (!name || name === 'Name') continue
    out.push({
      name,
      category: (cells[2] ?? '').trim(),
      source: (cells[3] ?? '').trim(),
    })
  }
  return out
}

export interface ListHermesSkillsInput {
  /** hermes 可执行命令（设置 localAgent.command 兜底 DEFAULT_HERMES_COMMAND）。 */
  command: string
  /** 工作目录（vault 根）——与 hermesProject 同款，spawn 需要合法 cwd。 */
  cwd: string
  /** 墙钟超时（ms）；<=0 或省略用默认 15s。 */
  timeoutMs?: number
}

export interface ListHermesSkillsResult {
  ok: boolean
  /** 已启用的技能（--enabled-only），含原生差异信息（分类/来源）。 */
  skills: HermesSkillInfo[]
  /** 失败时的可读文案（命令 + exit + stderr 摘要）。 */
  error?: string
}

const DEFAULT_TIMEOUT_MS = 15000

/** 拉取 hermes 已启用技能清单。never reject——一切失败（spawn 不可用、
 *  非零退出）落成 ok:false + 可读 error。COLUMNS=300 防 Rich 表格截断
 *  长技能名（截断名无法作为命令还原）。 */
export async function listHermesSkills(
  input: ListHermesSkillsInput,
  spawnImpl?: SpawnLike,
): Promise<ListHermesSkillsResult> {
  const res = await runLocalAgent(
    {
      command: input.command,
      fallbackCommands: commandFallbacks(input.command),
      cwd: input.cwd,
      timeoutMs:
        typeof input.timeoutMs === 'number' && input.timeoutMs > 0
          ? input.timeoutMs
          : DEFAULT_TIMEOUT_MS,
      args: ['skills', 'list', '--enabled-only'],
      env: { COLUMNS: '300' },
    },
    spawnImpl,
  )
  if (!res.ok) {
    const detail = res.error || res.stderrTail.trim() || '未知错误'
    const err = `hermes skills list 失败（exit ${res.exitCode ?? '?'}）：${detail.slice(
      0,
      200,
    )}`
    dlog('warn', 'chat', err)
    return { ok: false, skills: [], error: err }
  }
  return { ok: true, skills: parseHermesSkillsTable(res.output) }
}
