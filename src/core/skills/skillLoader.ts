// Skill loading: parse a SKILL.md-style file (YAML frontmatter + markdown
// body) into a Skill, and scan the vault's skill folder for user skills.
// Parsing is pure (no obsidian runtime) so it's unit-testable; the vault
// scan goes through the raw adapter (utils/vaultIO) — the default skill
// folder lives under the dot-prefixed AI data folder (.obsidian-ai/skills/),
// which Obsidian's indexed APIs (getMarkdownFiles) never see. Mobile-safe.

import { App, normalizePath } from 'obsidian'
import { asString, asStringArray, splitFrontmatter } from '../../tools/util'
import { listDir, readText } from '../../utils/vaultIO'
import { normalizeAiFolder } from '../../utils/conversationStore'
import type { Skill, SkillMode, SkillSource } from './types'

/** Subfolder under the AI data folder where user skills live (追加45:
 *  storage is standardized on `<aiFolder>/skills` — no separate setting). */
export const SKILLS_SUBFOLDER = 'skills'

/** `<aiFolder>/skills` — the derived user-skill folder. */
export function skillsFolder(aiFolder: string | undefined): string {
  return `${normalizeAiFolder(aiFolder)}/${SKILLS_SUBFOLDER}`
}

/** The conventional skill file name inside a per-skill subfolder. */
export const SKILL_FILE_NAME = 'SKILL.md'

/** Case-insensitive match against the conventional SKILL.md name. */
export function isSkillFileName(name: string): boolean {
  return name.toUpperCase() === SKILL_FILE_NAME.toUpperCase()
}

/**
 * Parse the small YAML subset skills use: `key: value`, inline arrays
 * `[a, b]`, block lists (`- item` under a key), quoted strings, booleans.
 * Enough for skill frontmatter; deliberately NOT a full YAML parser.
 */
export function parseSimpleYaml(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = block.split('\n')
  let listKey: string | null = null

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    // Block-list item: "- value" while a key is open.
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && listKey) {
      const arr = Array.isArray(out[listKey]) ? (out[listKey] as unknown[]) : []
      arr.push(unquote(item[1].trim()))
      out[listKey] = arr
      continue
    }

    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    listKey = null

    if (value === '') {
      // Could open a block list on following lines.
      listKey = key
      out[key] = []
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0)
      continue
    }
    if (value === 'true' || value === 'false') {
      out[key] = value === 'true'
      continue
    }
    out[key] = unquote(value)
  }

  // Drop keys that opened a list but never got items.
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length === 0) delete out[k]
  }
  return out
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

export interface ParseSkillOptions {
  source: SkillSource
  /** Vault path (user skills) — used for display and name fallback. */
  path?: string
  /** Name to use when frontmatter has none (typically the file name). */
  fallbackName: string
}

/** Parse one skill document; null when it has neither body nor description. */
export function parseSkillContent(
  content: string,
  opts: ParseSkillOptions,
): Skill | null {
  const { frontmatter, body } = splitFrontmatter(content)
  const fm = frontmatter
    ? parseSimpleYaml(frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, ''))
    : {}

  const name = asString(fm.name).trim() || opts.fallbackName.trim()
  if (!name) return null

  const trimmedBody = body.trim()
  const description = asString(fm.description).trim() || firstMeaningfulLine(trimmedBody)
  if (!description && !trimmedBody) return null

  const mode: SkillMode = fm.mode === 'always' ? 'always' : 'lazy'
  const tools = asStringArray(fm.tools)

  return {
    metadata: {
      name,
      description,
      mode,
      emoji: asString(fm.emoji).trim() || undefined,
      version: asString(fm.version).trim() || undefined,
      tools: tools.length > 0 ? tools : undefined,
    },
    body: trimmedBody,
    source: opts.source,
    path: opts.path,
  }
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+\s+/, '').trim()
    if (t) return t
  }
  return ''
}

/** A located skill file: its vault path plus the display-name fallback. */
export interface SkillFileRef {
  path: string
  /** Basename for plain files; the subfolder name for `<sub>/SKILL.md`. */
  fallbackName: string
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}

/**
 * Collect the skill files under a folder: direct `*.md` children plus one
 * `<sub>/SKILL.md` per immediate subfolder (nothing deeper). Adapter-level
 * scan, so dot-prefixed skill folders are found too.
 */
export async function findSkillFiles(
  app: App,
  folder: string,
): Promise<SkillFileRef[]> {
  const root = normalizePath(folder.trim().replace(/^\/+|\/+$/g, ''))
  if (!root) return []
  const { files, folders } = await listDir(app, root)
  const out: SkillFileRef[] = []
  for (const file of files) {
    if (file.toLowerCase().endsWith('.md')) {
      const name = basename(file)
      out.push({ path: file, fallbackName: name.replace(/\.md$/i, '') })
    }
  }
  for (const sub of folders) {
    const inner = await listDir(app, sub)
    const skill = inner.files.find((f) => isSkillFileName(basename(f)))
    if (skill) out.push({ path: skill, fallbackName: basename(sub) })
  }
  return out
}

/** Read + parse every user skill in the folder. Unparseable files are skipped. */
export async function loadUserSkills(
  app: App,
  folder: string,
): Promise<Skill[]> {
  const refs = await findSkillFiles(app, folder)
  const skills: Skill[] = []
  for (const ref of refs) {
    const content = await readText(app, ref.path)
    if (content === null) continue
    const skill = parseSkillContent(content, {
      source: 'user',
      path: ref.path,
      fallbackName: ref.fallbackName,
    })
    if (skill) skills.push(skill)
  }
  return skills
}
