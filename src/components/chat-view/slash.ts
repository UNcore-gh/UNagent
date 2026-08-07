// Pure logic behind the leading-slash system:
//   '/'  → command palette (Claude Code-style session directives)
//   '//' → skill invocation ("//skill-name …" force-loads that skill)
//   '///' → sub-agent manager panel (多 Agent 体系: locate / edit / create)
// Also: the send-time parser that classifies a message into a command,
// a skill invocation, an agents-panel trigger, or plain text, and candidate
// ranking for the picker.

import type { Skill } from '../../core/skills/types'
import { COMMANDS } from './commands'
import type { CommandDef } from './commands'

/** An in-progress leading-slash trigger. */
export interface Slash {
  /** 1 = command palette, 2 = skill invocation, 3 = sub-agent manager
   *  (多 Agent 体系; 4+ slashes collapse to 3). */
  level: 1 | 2 | 3
  /** The token typed after the slash run (no whitespace allowed). */
  query: string
}

/**
 * Detect a leading-slash trigger. The slash run must start at position 0
 * (it's a message-level directive) and the query is a single non-whitespace
 * token — typing a space closes the picker so the user can write the
 * argument / message body.
 */
export function getActiveSlash(value: string, caret: number): Slash | null {
  const run = /^\/+/.exec(value)
  if (!run) return null
  const runLen = run[0].length
  if (caret < 1) return null
  const query = value.slice(runLen, caret)
  if (/\s/.test(query)) return null
  if (query.length > 40) return null
  return { level: runLen >= 3 ? 3 : runLen >= 2 ? 2 : 1, query }
}

/** A message-level directive parsed at send time. */
export type Directive =
  | { kind: 'skill'; name: string; body: string }
  | { kind: 'command'; name: string; arg: string }
  /** '///…' — open the sub-agent manager panel (query = the rest, may be
   *  empty; an exact agent-name match shortcuts straight into that agent). */
  | { kind: 'agents'; query: string }

/**
 * Classify a message: "///…" → agents-panel trigger, "//name …" → skill
 * (body = text after the name), "/name …" → command (arg = the rest, may be
 * empty). Null when there is no leading directive — plain text the caller
 * should send through untouched.
 */
export function parseDirective(text: string): Directive | null {
  const m = text.match(/^\s*(\/+)(\S+)?(?:[ \t]+([\s\S]*))?$/)
  if (!m) return null
  const slashes = m[1]
  if (slashes.length >= 3) {
    const rest = `${m[2] ?? ''}${m[3] ? ` ${m[3]}` : ''}`.trim()
    return { kind: 'agents', query: rest }
  }
  if (!m[2]) return null
  const name = m[2]
  const rest = (m[3] ?? '').trim()
  if (slashes.length === 2) return { kind: 'skill', name, body: rest }
  return { kind: 'command', name, arg: rest }
}

/**
 * The leading command token of a message being typed (e.g. "/btw"). Used for
 * the live in-input highlight: the composer renders the command's Chinese
 * label as a pill when `known`. A command only counts once a space/tab
 * follows the name (用户指示) — while still mid-name, or in a space-less
 * continuation like "/btw问题", it isn't a correct invocation yet, so no
 * highlight. Null when the text doesn't start with a slash command.
 *
 * Level 2 covers "//skill-name " invocations (追加㊺): the skill part gets
 * the same pill as a command — the composer resolves the label from the
 * skill registry; the marker stays name-only so the textarea width still
 * matches the pill (same pad trick as commands). "///…" (the agents panel)
 * is never a token.
 */
export interface CommandToken {
  token: string
  /** Pill text: the command's Chinese label (level 1) or the skill name. */
  label: string
  known: boolean
  /** Value length of the token run. */
  end: number
  /** 1 = '/cmd', 2 = '//skill-name' — same pill shape, different icon. */
  level: 1 | 2
}

export function commandToken(value: string): CommandToken | null {
  const m = value.match(/^(\s*\/\/?)([A-Za-z0-9_-]+)/)
  if (!m) return null
  const next = value[m[1].length + m[2].length]
  if (next !== ' ' && next !== '\t') return null
  const token = m[1] + m[2]
  if (m[1].endsWith('//')) {
    // Skill invocation — the registry lookup happens in the composer (this
    // module is skill-agnostic); unknown names still render as a pill.
    return { token, label: m[2], known: true, end: token.length, level: 2 }
  }
  const cmd = COMMANDS.find((c) => c.id === m[2])
  return {
    token,
    label: cmd?.label ?? token,
    known: cmd !== undefined,
    end: token.length,
    level: 1,
  }
}

/** One inline "/cmd" / "//skill-name" run inside a message BODY (for the
 *  chat-bubble rendering — the same tokens, mid-text). A token must start at
 *  a word boundary (after whitespace / line start; URLs like "https://…"
 *  never match) and end at whitespace / punctuation / end-of-text (so
 *  "/btw问题" stays plain text, consistent with the composer rule).
 *  "///…" and longer runs never match (agents panel). */
export interface InlineCommandToken {
  start: number
  end: number
  /** 1 = '/cmd', 2 = '//skill-name'. */
  slashes: 1 | 2
  name: string
}

export function findInlineCommandTokens(text: string): InlineCommandToken[] {
  const out: InlineCommandToken[] = []
  const re = /(^|[\s\u3000（(【「『])(\/\/?)([A-Za-z0-9_-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[3]
    const next = text[m.index + m[0].length]
    // CJK or word chars glued to the name mean it's part of prose, not a
    // directive token; punctuation/space/end-of-text confirm the token.
    if (next !== undefined && /[A-Za-z0-9_\-\u4e00-\u9fff]/.test(next)) {
      continue
    }
    out.push({
      start: m.index + m[1].length,
      end: m.index + m[0].length,
      slashes: m[2].length === 2 ? 2 : 1,
      name,
    })
  }
  return out
}

/* ── command ranking ─────────────────────────────────────────────────── */

export interface CommandItem {
  id: string
  /** Chinese display name — the picker's primary label. */
  label: string
  description: string
  icon: string
  usage?: string
  /** M2-T4: 面板徽章（hermes 通告命令标注「Hermes」来源）。 */
  badge?: string
}

// Picker cap: room for every registered command plus headroom for a couple
// more. (多 Agent 体系 曾为 agent 三命令临时提到 16；改走 /// 面板后回调；
// 补刀·五十五加 /hermes 后命令共 13 个，提到 14 留余量；M2-T4 hermes 通告
// 命令并入面板（默认露 4 条）再提余量。)
const COMMAND_CAP = 20

function commandScore(q: string, cmd: CommandDef): number {
  const name = cmd.id.toLowerCase()
  const label = cmd.label.toLowerCase()
  if (name === q || label === q) return 100
  if (name.startsWith(q) || label.startsWith(q)) return 80
  if (name.includes(q) || label.includes(q)) return 60
  if (cmd.description.toLowerCase().includes(q)) return 30
  return -1
}

/** Rank commands for the '/' picker; empty query → all, in defined order. */
export function buildCommandCandidates(
  commands: CommandDef[],
  query: string,
): CommandItem[] {
  const q = query.trim().toLowerCase()
  const toItem = (c: CommandDef): CommandItem => ({
    id: c.id,
    label: c.label,
    description: c.description,
    icon: c.icon,
    usage: c.usage,
    ...(c.badge ? { badge: c.badge } : {}),
  })
  if (!q) {
    return commands.slice(0, COMMAND_CAP).map(toItem)
  }
  return commands
    .map((c) => ({ c, s: commandScore(q, c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
    .slice(0, COMMAND_CAP)
    .map((x) => toItem(x.c))
}

/* ── skill ranking (for '//') ────────────────────────────────────────── */

export interface SkillItem {
  name: string
  description: string
  emoji?: string
  source: Skill['source']
}

const SKILL_CAP = 12

function skillScore(q: string, item: SkillItem): number {
  const name = item.name.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  if (item.description.toLowerCase().includes(q)) return 30
  return -1
}

/** Rank skills for the '//' picker; empty query → all, alphabetical. */
export function buildSkillCandidates(
  skills: Skill[],
  query: string,
): SkillItem[] {
  const items: SkillItem[] = skills.map((s) => ({
    name: s.metadata.name,
    description: s.metadata.description,
    emoji: s.metadata.emoji,
    source: s.source,
  }))
  const q = query.trim().toLowerCase()
  if (!q) {
    return items
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, SKILL_CAP)
  }
  return items
    .map((item) => ({ item, s: skillScore(q, item) }))
    .filter((x) => x.s >= 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(a.item.source === 'user') - Number(b.item.source === 'user') ||
        a.item.name.localeCompare(b.item.name),
    )
    .slice(0, SKILL_CAP)
    .map((x) => x.item)
}
