// Sub-agent loading (追加75: 与 skills 同构 — 一代理一文件夹): scan
// `<aiFolder>/agents/` for immediate sub-folders holding a `subagent.md`
// and parse each into an AgentDef. The agent name is the folder name
// (fallback when the note lacks a `name` frontmatter); everything else in
// the folder is the agent's own data and is never scanned. Adapter-level
// scan (utils/vaultIO) so dot-prefixed AI folders are seen too — same
// discipline as skill loading. Missing/unreadable folder = empty list,
// never a throw.

import { App } from 'obsidian'
import { normalizeAiFolder } from '../../utils/conversationStore'
import { listDir, readText } from '../../utils/vaultIO'
import { AgentDef, parseAgentDef } from './agentDef'

/** Subfolder under the AI data folder where sub-agents live. */
export const AGENTS_SUBFOLDER = 'agents'

/** Main persona file inside each sub-agent folder (追加75). */
export const SUBAGENT_FILENAME = 'subagent.md'

/** `<aiFolder>/agents` — the sub-agent folder (standardized on the AI
 *  data folder, 追加45: no separate setting). */
export function agentsFolder(aiFolder: string | undefined): string {
  return `${normalizeAiFolder(aiFolder)}/${AGENTS_SUBFOLDER}`
}

/** Read + parse every sub-agent folder. Folders without subagent.md and
 *  broken files are skipped. */
export async function loadAgentDefs(
  app: App,
  folder: string,
): Promise<AgentDef[]> {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return []
  const { folders: subs } = await listDir(app, trimmed)
  const defs: AgentDef[] = []
  for (const sub of subs) {
    const path = `${sub}/${SUBAGENT_FILENAME}`
    const content = await readText(app, path)
    if (content === null) continue
    const folderName =
      sub
        .split('/')
        .filter(Boolean)
        .pop() ?? ''
    const def = parseAgentDef(content, {
      source: 'user',
      path,
      fallbackName: folderName,
    })
    if (def) defs.push(def)
  }
  return defs
}
