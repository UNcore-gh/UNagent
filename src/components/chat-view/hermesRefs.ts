import type { App } from 'obsidian'
import { TFolder } from 'obsidian'
import { collectTags } from '../../tools/util'
import { isExcludedPath } from '../../utils/exclusions'

/**
 * hermes 原生 @ 上下文引用（独立于插件主 agent 的 mention/slash 机制）：
 * hermes 不认 [[wiki link]]，只认 @kind:relpath 这类 token。文件/文件夹
 * 取 vault 全量（与主模式同款排除规则过滤），注入原始库相对路径
 * （hermes cwd = 库基路径）。
 */

/** 一个 @ 引用候选：insert 即最终写入 textarea 的 hermes 原生 token。 */
export interface HermesRef {
  /** CommandPicker 的稳定 id（复用为 insert 的 key）。 */
  id: string
  label: string
  sub?: string
  description?: string
  icon?: string
  iconFallback?: string
  /** 插入 textarea 的原文。 */
  insert: string
  /** 插入后光标停在第几个字符之后（默认 insert.length）。 */
  caretOffset?: number
}

/** 静态上下文引用——不依赖本地文件，插一个固定 token。 */
export const HERMES_CONTEXT_REFS: HermesRef[] = [
  {
    id: '@url:',
    label: '@url:https://…',
    description: '抓取并注入网页内容',
    insert: '@url:',
    caretOffset: 5,
    icon: 'globe',
    iconFallback: 'send',
  },
]

/** 文件/文件夹引用：选中注入 @file:<relpath> / @folder:<relpath>/。 */
export interface HermesFileRef extends HermesRef {
  mtime: number
}

/**
 * 按需构建哪一类候选：@ 窗只出文件（kind='files'），@@ 窗只出文件夹
 * （kind='folders'），各自按需构建避免全量构建后丢弃。
 */
export type HermesRefKind = 'files' | 'folders' | 'both'

const TOTAL_CAP = 24

/**
 * hermes 命令的中文/图标润色目录（key = 命令名）。
 * 运行时注册表（available_commands_update）决定「显示哪些命令」，这张表决定
 * 「每个命令长什么样」——中文名 + 语义图标 + 中文说明。未收录的命令回退为
 * `/name` + terminal 图标。图标只用插件内嵌的 lucide 子集（见 Icon 组件）。
 */
export interface HermesCommandMeta {
  label: string
  description?: string
  icon?: string
}

export const HERMES_COMMAND_CATALOG: Record<string, HermesCommandMeta> = {
  help: { label: '帮助', description: '列出可用命令与用法', icon: 'help-circle' },
  model: { label: '切换模型', description: '显示或切换当前模型（如 /model，/model claude）', icon: 'cpu' },
  mode: { label: '审批模式', description: '查看或切换审批模式：默认（逐次询问）/ 自动（编辑放行）/ 免询（全部放行）', icon: 'shield-question' },
  prompt: { label: '提示词', description: '显示或修改系统提示词', icon: 'quote' },
  profile: { label: '模型档案', description: '切换或查看模型档案', icon: 'cpu' },
  tools: { label: '工具列表', description: '列出当前可用的工具', icon: 'list-checks' },
  toolsets: { label: '工具集', description: '查看启用的工具集', icon: 'puzzle' },
  context: { label: '上下文统计', description: '统计对话消息数与用量', icon: 'gauge' },
  reset: { label: '清空对话', description: '清空当前对话历史', icon: 'rotate-ccw' },
  compress: { label: '压缩上下文', description: '压缩对话上下文以节省用量', icon: 'archive' },
  steer: { label: '注入指引', description: '给正在运行的轮注入方向指引', icon: 'zap' },
  queue: { label: '排队指令', description: '排一条 prompt，当前轮结束后运行', icon: 'list-checks' },
  version: { label: '版本', description: '显示 Hermes 版本', icon: 'help-circle' },
  status: { label: '状态', description: '显示当前运行状态', icon: 'gauge' },
  statusbar: { label: '状态栏', description: '控制状态栏显示', icon: 'gauge' },
  stop: { label: '停止', description: '停止当前正在运行的轮', icon: 'square' },
  approvals: { label: '审批', description: '查看待审批的请求', icon: 'shield-question' },
  approve: { label: '批准', description: '批准一个待审批请求', icon: 'check' },
  deny: { label: '拒绝', description: '拒绝一个待审批请求', icon: 'x' },
  agents: { label: '代理列表', description: '查看或切换代理', icon: 'bot' },
  topic: { label: '主题', description: '查看或设置对话主题', icon: 'message-square' },
  title: { label: '标题', description: '查看或设置对话标题', icon: 'pencil' },
  memory: { label: '记忆', description: '查看或管理长期记忆', icon: 'brain' },
  save: { label: '保存快照', description: '保存当前对话快照', icon: 'folder' },
  rollback: { label: '回滚', description: '回滚到之前的快照', icon: 'undo-2' },
  retry: { label: '重试', description: '重试上一条消息', icon: 'rotate-ccw' },
  undo: { label: '撤销', description: '撤销上一步操作', icon: 'undo-2' },
  new: { label: '新对话', description: '开始一个新对话', icon: 'plus' },
  reasoning: { label: '推理', description: '控制推理强度', icon: 'lightbulb' },
  moa: { label: 'MoA', description: '切换 MoA（多代理聚合）', icon: 'sparkles' },
  verbose: { label: '详细输出', description: '切换详细日志输出', icon: 'command' },
  clear: { label: '清屏', description: '清空终端输出', icon: 'x' },
  quit: { label: '退出', description: '退出 Hermes', icon: 'command' },
  reload: { label: '重载', description: '重载配置与技能', icon: 'rotate-ccw' },
  'reload-skills': { label: '重载技能', description: '热重载技能定义', icon: 'puzzle' },
  'reload-mcp': { label: '重载 MCP', description: '重载 MCP 服务', icon: 'plug' },
  plugins: { label: '插件', description: '查看启用的插件', icon: 'puzzle' },
  skills: { label: '技能列表', description: '列出可用技能', icon: 'lightbulb' },
  diff: { label: '查看改动', description: '查看未暂存的 git 改动', icon: 'pencil' },
  history: { label: '历史', description: '查看对话历史', icon: 'gauge' },
  sessions: { label: '会话', description: '列出或切换会话', icon: 'message-square' },
  resume: { label: '恢复会话', description: '恢复之前的会话', icon: 'rotate-ccw' },
  contextclear: { label: '清理上下文', description: '清理上下文窗口', icon: 'archive' },
  usage: { label: '用量', description: '显示 token 用量与配额', icon: 'gauge' },
  subgoal: { label: '子目标', description: '管理当前子目标', icon: 'list-checks' },
  goal: { label: '目标', description: '查看或设置任务目标', icon: 'zap' },
  topic_header: { label: '主题头部', description: '设置主题头部提示', icon: 'quote' },
  timestamps: { label: '时间戳', description: '切换时间戳显示', icon: 'gauge' },
}

/** 简单打分：前缀命中 > startsWith > 包含；query 为空时全部等分（靠 mtime 排序）。 */
const scoreRef = (q: string, label: string, sub: string): number => {
  const hay = `${label} ${sub}`.toLowerCase()
  if (hay.startsWith(q)) return 100
  if (label.toLowerCase().startsWith(q)) return 80
  if (hay.includes(q)) return 40
  return -1
}

/**
 * 按需列出 vault 全量的文件与/或文件夹（经排除规则过滤），注入 hermes
 * 原生 @ 引用 token。
 * - 文件 → `@file:relpath `（vault.getFiles 全量）
 * - 文件夹 → `@folder:relpath/ `（getAllLoadedFiles + TFolder 真实枚举，
 *   空文件夹也能出现；根目录 `/` 不作为候选）
 * kind 按需构建：@ 窗传 'files' 只出文件、@@ 窗传 'folders' 只出文件夹
 * （不碰另一类通道）；文件与文件夹分别按 TOTAL_CAP 截断后再合并——
 * 防止 'both' 模式下大库某一类挤空另一类。
 * query 空 → 各自类别自然序（文件夹字母序、文件按 mtime 近者优先），
 * 'both' 时文件夹在前；非空 → 打分降序。
 */
export function buildHermesFileRefCandidates(
  app: App,
  query: string,
  exclusions: string[],
  kind: HermesRefKind = 'both',
): HermesFileRef[] {
  const q = query.trim().toLowerCase()

  // 打分过滤 + 同类 TOTAL_CAP 截断（排序规则：非空 query 分数降序；
  // 空 query 走各自类别的自然序，由调用方传入）。
  const scoreAndCap = (
    refs: HermesFileRef[],
    emptyQuerySort: (a: HermesFileRef, b: HermesFileRef) => number,
  ): { r: HermesFileRef; s: number }[] =>
    refs
      .map((r) => ({ r, s: q ? scoreRef(q, r.label, r.sub ?? '') : 1 }))
      .filter((x) => x.s >= 0)
      .sort((a, b) =>
        q
          ? b.s - a.s || a.r.label.localeCompare(b.r.label)
          : emptyQuerySort(a.r, b.r),
      )
      .slice(0, TOTAL_CAP)

  const scored: { r: HermesFileRef; s: number }[] = []

  if (kind !== 'files') {
    // 文件夹真实枚举（主模式 mention.ts folderResults 同款范式）：空文件夹
    // 也能出现，不依赖子树文件反推。
    const folderRefs = app.vault
      .getAllLoadedFiles()
      .filter(
        (a): a is TFolder =>
          a instanceof TFolder &&
          a.path !== '/' &&
          !isExcludedPath(a.path, exclusions),
      )
      .map((d) => ({
        id: `@folder:${d.path}/`,
        label: d.name,
        sub: d.path,
        insert: `@folder:${d.path}/ `,
        mtime: 0,
        icon: 'folder',
      }))
    scored.push(...scoreAndCap(folderRefs, (a, b) => a.label.localeCompare(b.label)))
  }

  if (kind !== 'folders') {
    const fileRefs: HermesFileRef[] = []
    for (const f of app.vault.getFiles()) {
      if (isExcludedPath(f.path, exclusions)) continue
      const parent = f.parent?.path
      fileRefs.push({
        id: `@file:${f.path}`,
        label: f.name,
        sub: parent && parent !== '/' ? parent : '/',
        insert: `@file:${f.path} `,
        mtime: f.stat.mtime,
        icon: 'file',
      })
    }
    scored.push(...scoreAndCap(fileRefs, (a, b) => b.mtime - a.mtime))
  }

  // 'both' 模式（当前无调用方，@/@@ 窗各自单类构建）：空 query 文件夹在前
  // （scored 已按 folders→files 顺序入列，各自有序）；非空 query 跨类按分数重排。
  if (q) scored.sort((a, b) => b.s - a.s || a.r.label.localeCompare(b.r.label))
  return scored.map((x) => x.r)
}

/**
 * 索引全部标签（@@@ 触发）：列出库内所有 `#` 标签（frontmatter tags +
 * 行内 #tags），作为索引供选择。选中注入 `@tag:<name> `，由插件侧
 * expandHermesRefs 展开为含该标签的文件路径列表。被排除路径下的文件
 * 不参与计数（与主模式 mention.ts tagResults 一致）。
 * query 空 → 按含该标签的文件数降序；非空 → 标签名包含匹配，字母序。
 */
export function buildHermesTagCandidates(
  app: App,
  query: string,
  exclusions: string[],
): HermesRef[] {
  const q = query.trim().toLowerCase()
  const tagCount = new Map<string, number>()
  for (const f of app.vault.getFiles()) {
    if (f.extension !== 'md') continue
    if (isExcludedPath(f.path, exclusions)) continue
    const cache = app.metadataCache.getFileCache(f)
    for (const t of collectTags(cache)) {
      tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
    }
  }
  const sorted = Array.from(tagCount.entries())
    .filter(([name]) => (q ? name.toLowerCase().includes(q) : true))
    .sort((a, b) => {
      if (q) return a[0].localeCompare(b[0])
      return b[1] - a[1] || a[0].localeCompare(b[0])
    })
    .slice(0, TOTAL_CAP)
  return sorted.map(([name, count]) => ({
    id: `@tag:${name}`,
    label: `#${name}`,
    sub: `${count} 个文件`,
    description: `包含标签 #${name} 的文件（${count} 个）`,
    insert: `@tag:${name} `,
    icon: 'hash',
    iconFallback: 'list-checks',
  }))
}