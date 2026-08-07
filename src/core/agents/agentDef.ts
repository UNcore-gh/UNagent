// Sub-agent definitions (多 Agent 体系): a sub-agent is a folder under
// `<aiFolder>/agents/<name>/` whose main file is `subagent.md` (YAML
// frontmatter name/emoji/description/model + a markdown persona body) — the
// same one-folder-per-item layout as skills. Everything else inside the
// folder is the agent's own data (progress notes, outputs…) and is never
// scanned as an agent. It is NOT a second runtime: sub-agent conversations
// are ordinary persisted conversations tagged with an agentId, and the
// persona rides along as a frozen system-prompt snapshot (same pattern as
// the three brain files). Parsing is pure (no obsidian runtime) so it's
// unit-testable; the registry mirrors SkillRegistry — a plain class owned
// by the plugin (never the ToolRegistry singleton).

import { asString, splitFrontmatter } from '../../tools/util'
import { parseSimpleYaml } from '../skills/skillLoader'

/** Persona body cap — one runaway note must not swallow the context. */
export const MAX_AGENT_PERSONA_CHARS = 6000

/** 内置 Hermes 代理名（补刀·五十七）：「Hermes 模式」切换的目标代理。
 *  main.ts 以 source=builtin 注册；用户自建同名代理会覆盖它（user 优先）。 */
export const HERMES_AGENT_NAME = 'Hermes'

export type AgentSource = 'builtin' | 'user'

/** One parsed sub-agent persona note. */
export interface AgentDef {
  name: string
  emoji?: string
  description: string
  /** Optional model profile id (frontmatter `model`) — 2nd in the chain:
   *  session /model override > agent model > global default. */
  modelOverride?: string
  /** 执行引擎（补刀·五十五，frontmatter `engine`）：'hermes' = 该代理的
   *  每一轮对话都委托本机 hermes one-shot（桌面专属），不走插件 LLM；
   *  undefined = 常规 LLM 对话。未来可扩展其他引擎，目前只认 'hermes'。 */
  engine?: 'hermes'
  /** Persona body, injected into the system prompt (capped). */
  body: string
  /** Vault path (user agents) — display + hot reload. */
  path?: string
  source: AgentSource
}

export interface ParseAgentOptions {
  source: AgentSource
  /** Vault path (user agents). */
  path?: string
  /** Folder-derived agent name (追加75: 一代理一文件夹，文件夹名即默认名) —
   *  used when the note has no `name` frontmatter. */
  fallbackName?: string
}

/**
 * Parse one subagent.md; null when it is not a persona note.
 * 追加74: a `name` frontmatter is REQUIRED for loose markdown files — the
 * agents/ folder may hold agent-produced data files, which look like any
 * other markdown and must NOT become agents. 追加75: the scanner only ever
 * feeds subagent.md files into this parser, so a missing name now falls
 * back to the folder name (never null when a folder name is given).
 */
export function parseAgentDef(
  content: string,
  opts: ParseAgentOptions,
): AgentDef | null {
  const { frontmatter, body } = splitFrontmatter(content)
  const fm = frontmatter
    ? parseSimpleYaml(
        frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, ''),
      )
    : {}

  const name = asString(fm.name).trim() || opts.fallbackName?.trim() || ''
  if (!name) return null

  const trimmedBody = body.trim()
  const description =
    asString(fm.description).trim() || firstMeaningfulLine(trimmedBody)
  if (!description && !trimmedBody) return null

  const model = asString(fm.model).trim()
  // engine 只认 'hermes'（大小写不敏感）；其它值视为未写，静默回落常规
  // LLM——拼错引擎名不该让代理整个失效。
  const engineRaw = asString(fm.engine).trim().toLowerCase()
  const engine: 'hermes' | undefined = engineRaw === 'hermes' ? 'hermes' : undefined
  let persona = trimmedBody
  if (persona.length > MAX_AGENT_PERSONA_CHARS) {
    persona = persona.slice(0, MAX_AGENT_PERSONA_CHARS)
  }

  return {
    name,
    emoji: asString(fm.emoji).trim() || undefined,
    description,
    modelOverride: model || undefined,
    engine,
    body: persona,
    path: opts.path,
    source: opts.source,
  }
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+\s+/, '').trim()
    if (t) return t
  }
  return ''
}

/** Builtin + user sub-agents by name (plugin-owned; user defs reload on
 *  vault changes — same shape as SkillRegistry). */
export class AgentRegistry {
  private agents = new Map<string, AgentDef>()

  register(def: AgentDef): void {
    this.agents.set(def.name, def)
  }

  registerAll(defs: AgentDef[]): void {
    for (const d of defs) this.register(d)
  }

  /** Remove every agent from a given source (used when reloading user defs). */
  removeBySource(source: AgentSource): void {
    for (const [name, def] of this.agents) {
      if (def.source === source) this.agents.delete(name)
    }
  }

  getByName(name: string): AgentDef | undefined {
    return this.agents.get(name.trim())
  }

  getAll(): AgentDef[] {
    return Array.from(this.agents.values())
  }

  clear(): void {
    this.agents.clear()
  }
}
