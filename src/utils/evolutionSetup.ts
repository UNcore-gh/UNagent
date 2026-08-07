// One-time storage evolution (追加⑲): plugin data moves out of the legacy
// HIDDEN folder (`.obsidian-ai/`) into the VISIBLE `AI 助手/` folder, and
// the three self-evolution "brain files" get seeded there so the user can
// browse and edit them directly in Obsidian:
//
//   agent.md  — the AI's persona & working rules (hermes-agent's SOUL.md
//               role) — free-form document, injected whole into the system
//               prompt; the user edits it by hand or asks the AI to refine
//               it via edit_note.
//   memory.md — long-term memory entries (save_memory target=memory).
//   user.md   — user-profile entries (save_memory target=user).
//
// All file operations go through the raw adapter (utils/vaultIO) — the
// legacy folder is dot-prefixed and invisible to Obsidian's indexed APIs.
// Migration is conservative: on a name conflict the destination wins and the
// source file stays put; anything unexpected aborts without data loss.

import { App } from 'obsidian'
import { SUBAGENT_FILENAME } from '../core/agents/agentLoader'
import { parseSimpleYaml } from '../core/skills/skillLoader'
import { splitFrontmatter } from '../tools/util'
import { DEFAULT_AI_FOLDER, memoryPath } from './memoryStore'
import {
  listAllFiles,
  listDir,
  pathExists,
  readBinary,
  readText,
  removeEmptyDirs,
  removePath,
  writeBinary,
  writeText,
} from './vaultIO'

/** The pre-evolution hidden data folder. */
export const LEGACY_AI_FOLDER = '.obsidian-ai'

/** Persona & rules file name inside the AI data folder. */
export const AGENT_FILENAME = 'agent.md'

/** Path of agent.md under the given AI data folder. */
export function agentDocPath(aiFolder?: string): string {
  const base =
    (aiFolder ?? '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_AI_FOLDER
  return `${base}/${AGENT_FILENAME}`
}

/* ── seed templates ─────────────────────────────────────────────────────
 * Only bullet lines ("- …") are ever injected into the system prompt; the
 * explanatory prose below is a preserved preamble, so these notes stay
 * self-documenting without leaking into the prompt. */

export const AGENT_TEMPLATE = `# 助手人设（agent.md）

> 这个文件定义 AI 助手「是谁、怎么做事」——全文会在每次新对话开始时注入系统提示词。
> 你可以随时直接编辑；也可以让 AI 用编辑笔记工具帮你调整。修改在**下一次新对话**生效。

## 你是谁

- 你是这个 Obsidian 笔记库的 AI 管家：简洁、谨慎、诚实，不编造不存在的内容。

## 工作守则

- 动笔记之前先检索确认，不要臆造路径。
- 回复使用简体中文；涉及文件时给出其路径。
- 破坏性操作（改 / 移 / 删）先向用户说明要做什么。
- 用户透露的长期偏好与背景，用 save_memory 记到 user.md / memory.md。

（继续补充你想要的规则：称呼、语气、回答格式、哪些事必须 / 禁止……）
`

export const MEMORY_TEMPLATE = `# AI 记忆

> AI 通过 save_memory 工具在这里积累长期事实与经验教训（每条以 \`-\` 开头、一行一条），每次新对话开始时注入系统提示词。
> 你可以随时手动编辑或删除；改动在**下一次新对话**生效。
> 注意：只有以 \`-\` 开头的行会被读取为记忆条目，这段说明文字不会被注入。
`

export const USER_TEMPLATE = `# 用户画像

> AI 通过 save_memory 工具（target=user）在这里记录你的长期信息：你是谁、身份、偏好、沟通习惯（每条以 \`-\` 开头、一行一条），每次新对话开始时注入系统提示词。
> 你可以随时手动编辑或删除；改动在**下一次新对话**生效。
> 注意：只有以 \`-\` 开头的行会被读取为条目，这段说明文字不会被注入。
`

/**
 * Seed the three brain files where they are missing. Called only on the
 * fresh-folder / just-migrated paths (never on every load), so a file the
 * user deleted on purpose stays deleted. Never overwrites existing content.
 */
export async function ensureBrainFiles(
  app: App,
  aiFolder: string,
): Promise<void> {
  const seeds: Array<[string, string]> = [
    [agentDocPath(aiFolder), AGENT_TEMPLATE],
    [memoryPath(aiFolder, 'memory'), MEMORY_TEMPLATE],
    [memoryPath(aiFolder, 'user'), USER_TEMPLATE],
  ]
  for (const [path, template] of seeds) {
    if (!(await pathExists(app, path))) {
      await writeText(app, path, template)
    }
  }
}

export interface MigrationResult {
  /** Files copied to the new folder and removed from the legacy one. */
  moved: number
  /** Files left behind (destination already existed, or unreadable). */
  skipped: number
}

/**
 * Move every file under `.obsidian-ai/` into `target` (adapter-level, works
 * on dot-folders). Dot-files like `.DS_Store` are ignored. Conflict → the
 * destination wins and the source file stays where it is. Afterwards the
 * emptied legacy folder tree is swept. Returns null when there is no legacy
 * folder to migrate.
 */
export async function migrateLegacyFolder(
  app: App,
  target: string,
): Promise<MigrationResult | null> {
  const dest = target.trim().replace(/^\/+|\/+$/g, '')
  if (!dest || dest === LEGACY_AI_FOLDER) return null
  if (!(await pathExists(app, LEGACY_AI_FOLDER))) return null

  let moved = 0
  let skipped = 0
  for (const src of await listAllFiles(app, LEGACY_AI_FOLDER)) {
    const rel = src.slice(LEGACY_AI_FOLDER.length + 1)
    if (!rel) continue
    // Skip junk dot-files (.DS_Store) — but never real data.
    if (rel.split('/').some((part) => part.startsWith('.'))) continue
    const destPath = `${dest}/${rel}`
    if (await pathExists(app, destPath)) {
      // Destination already exists — the source file is a confirmed
      // duplicate. Delete it so the legacy folder can be fully cleaned
      // up and migration doesn't re-trigger (and re-notify) on every
      // startup. The destination's content is preserved.
      await removePath(app, src)
      skipped++
      continue
    }
    const bytes = await readBinary(app, src)
    if (bytes === null) {
      skipped++
      continue
    }
    await writeBinary(app, destPath, bytes)
    await removePath(app, src)
    moved++
  }
  await sweepSourceTree(app, LEGACY_AI_FOLDER)
  return { moved, skipped }
}

/**
 * 追加64: 迁移任意数据文件夹（设置页切换「数据文件夹」时用）。与
 * migrateLegacyFolder 同款 adapter 级移动（复制 + 删源），但冲突时
 * **保守跳过**：目标已有同名文件 → 源保留、计入 skipped——目标文件夹
 * 可能含用户自己的文件，不能像 legacy 迁移那样把冲突源当重复数据删掉。
 * 点前缀文件（.DS_Store 等）同样忽略。无可迁移时返回 null。
 */
export async function migrateDataFolder(
  app: App,
  from: string,
  to: string,
): Promise<MigrationResult | null> {
  const src = from.trim().replace(/^\/+|\/+$/g, '')
  const dest = to.trim().replace(/^\/+|\/+$/g, '')
  if (!src || !dest || src === dest) return null
  if (!(await pathExists(app, src))) return null

  let moved = 0
  let skipped = 0
  for (const srcPath of await listAllFiles(app, src)) {
    const rel = srcPath.slice(src.length + 1)
    if (!rel) continue
    // Skip junk dot-files (.DS_Store) — but never real data.
    if (rel.split('/').some((part) => part.startsWith('.'))) continue
    const destPath = `${dest}/${rel}`
    if (await pathExists(app, destPath)) {
      skipped++
      continue
    }
    const bytes = await readBinary(app, srcPath)
    if (bytes === null) {
      skipped++
      continue
    }
    await writeBinary(app, destPath, bytes)
    await removePath(app, srcPath)
    moved++
  }
  await sweepSourceTree(app, src)
  return { moved, skipped }
}

/** True for OS-generated junk that must never migrate AND must not block
 *  the source-folder cleanup (.DS_Store / AppleDouble / Windows junk). */
function isSystemJunkFile(name: string): boolean {
  return (
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.startsWith('._')
  )
}

/** 追加65: After a migration, drop the skipped junk files from the source
 *  tree so the emptied folder can actually be removed. Without this,
 *  macOS Finder leaves .DS_Store behind → removeEmptyDirs sees a file and
 *  refuses to delete the old folder — the “old location removed” half of
 *  the migrate-on-switch feature silently fails. Only system junk is
 *  deleted; user dot-FOLDERS (.trash …) and everything else stay put. */
async function sweepSourceTree(app: App, src: string): Promise<void> {
  for (const p of await listAllFiles(app, src)) {
    const rel = p.slice(src.length + 1)
    const name = rel.split('/').pop() ?? ''
    if (isSystemJunkFile(name)) await removePath(app, p)
  }
  await removeEmptyDirs(app, src)
}

/* ── sub-agent layout evolution (追加75) ────────────────────────────────
 * Sub-agents move from loose `agents/<名字>.md` notes to the skills-style
 * one-folder-per-agent layout: `agents/<名字>/subagent.md` is the persona,
 * everything else in the folder is the agent's own data (progress notes…).
 * One-time best-effort migration, idempotent: once no direct .md files
 * remain under agents/ it does nothing on later loads. */

const SUBAGENT_SEPARATORS = /[·\-_]/

/** Escape a name for use inside a RegExp source (folder names may contain
 *  any character except `/`). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 追加75: 迁移旧子代理布局 → 一代理一文件夹（与 skills 同构）：
 * - 带 name frontmatter 的直接 .md → `agents/<name>/subagent.md`；目标已
 *   存在（或 name 非法）则保留源文件、计入 skipped（保守，不覆盖）。
 * - 无 name 的直接 .md（agent 产物，如 追问启发·进度.md）→ 若文件名以
 *   「某 agent 文件夹名 + ·/-/_」开头，归入该文件夹（追问启发·进度.md →
 *   agents/追问启发/进度.md）；无法归属的留在原地——新扫描只认
 *   subagent.md，它们不会再被误认成子代理。
 * 迁移在启动 evolveStorage 时执行一次；无直接 .md 文件时直接返回。
 */
export async function evolveAgentsLayout(
  app: App,
  agentsDir: string,
): Promise<{ moved: number; skipped: number }> {
  const dir = agentsDir.trim().replace(/^\/+|\/+$/g, '')
  if (!dir || !(await pathExists(app, dir))) return { moved: 0, skipped: 0 }
  const { files, folders } = await listDir(app, dir)
  const directNotes = files.filter((f) => f.toLowerCase().endsWith('.md'))
  if (directNotes.length === 0) return { moved: 0, skipped: 0 }

  let moved = 0
  let skipped = 0
  // Existing agent folder names — a data file may also target a folder the
  // user already created by hand (second pass below).
  const agentDirs = new Set(
    folders
      .map((f) => f.split('/').filter(Boolean).pop() ?? '')
      .filter(Boolean),
  )
  // 1st pass: persona notes → agents/<name>/subagent.md.
  for (const src of directNotes) {
    const content = await readText(app, src)
    if (content === null) {
      skipped++
      continue
    }
    const { frontmatter } = splitFrontmatter(content)
    const fm = frontmatter
      ? parseSimpleYaml(
          frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, ''),
        )
      : {}
    const name = (fm.name as string | undefined)?.trim() ?? ''
    if (!name || name.includes('/')) {
      // Not a persona note (agent data file) or an invalid name — leave it
      // for the 2nd pass / stays put.
      continue
    }
    const dest = `${dir}/${name}/${SUBAGENT_FILENAME}`
    if (await pathExists(app, dest)) {
      skipped++
      continue
    }
    try {
      await writeText(app, dest, content)
      await removePath(app, src)
      agentDirs.add(name)
      moved++
    } catch {
      skipped++
    }
  }
  // 2nd pass: agent-produced data files whose name starts with an agent
  // folder name + separator → into that agent's folder.
  for (const src of directNotes) {
    const base = src.split('/').filter(Boolean).pop() ?? ''
    const stem = base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : ''
    if (!stem) continue
    for (const agentName of agentDirs) {
      const m = stem.match(
        new RegExp(
          `^${escapeRegExp(agentName)}${SUBAGENT_SEPARATORS.source}(.+)$`,
        ),
      )
      if (!m) continue
      const content = await readText(app, src)
      if (content === null) break // 1st pass already moved it — nothing to do
      const dest = `${dir}/${agentName}/${m[1]}.md`
      if (await pathExists(app, dest)) {
        skipped++
        break
      }
      try {
        await writeText(app, dest, content)
        await removePath(app, src)
        moved++
      } catch {
        skipped++
      }
      break
    }
  }
  return { moved, skipped }
}
