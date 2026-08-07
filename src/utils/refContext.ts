// Task #7: turn wiki-link references ([[note]]) found in a message into
// context text for the LLM. Pure vault/metadataCache access — mobile-safe.

import type { App } from 'obsidian'
import { resolveFile } from '../tools/util'

export type RefMode = 'link' | 'excerpt' | 'full'

/** Configurable caps (defaults follow the task spec). */
export interface RefLimits {
  /** Max notes expanded in full/excerpt mode; extras degrade to link lines. */
  maxNotes?: number
  /** Per-note character cap for excerpt mode. */
  excerptMax?: number
  /** Per-note character cap for full mode. */
  fullMax?: number
  /** Hard cap for the assembled output. */
  totalMax?: number
}

const DEFAULT_LIMITS = {
  maxNotes: 4,
  excerptMax: 2000,
  fullMax: 8000,
  totalMax: 20000,
}

/**
 * Extract wiki-link note references from arbitrary text. Excluded:
 * embeds (`![[...]]`), message-reference tokens (`[[msg:...]]`) and folder
 * references (`[[文件夹/]]`). Aliases (`|别名`) and anchors (`#锚点`) are
 * stripped; results are de-duplicated preserving first-seen order.
 */
export function extractNoteRefs(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^\[\]\n]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Reject embeds (`![[...]]`) by peeking at the preceding char — this
    // avoids consuming it, so back-to-back links still both match.
    if (text[m.index - 1] === '!') continue
    const ref = m[1].split('|')[0].split('#')[0].trim()
    if (!ref) continue
    if (ref.startsWith('msg:')) continue // 消息引用 token
    if (ref.endsWith('/')) continue // 文件夹引用
    if (seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

/** One expanded note section; failures become a one-line degradation. */
async function sectionFor(
  app: App,
  ref: string,
  perNoteMax: number,
): Promise<string> {
  try {
    const file = resolveFile(app, ref)
    if (!file || file.extension !== 'md') {
      return `【引用笔记：${ref}】\n（引用 ${ref} 无法读取）`
    }
    const content = await app.vault.read(file)
    if (content.length > perNoteMax) {
      return `【引用笔记：${file.path}】\n${content.slice(0, perNoteMax)}\n…（后略，可用 read_note 查看全文）`
    }
    return `【引用笔记：${file.path}】\n${content}`
  } catch {
    return `【引用笔记：${ref}】\n（引用 ${ref} 无法读取）`
  }
}

/**
 * Build LLM context from note references.
 * - 'link' → returns '' (refs stay as plain [[links]] in the message).
 * - 'excerpt' / 'full' → expands up to `maxNotes` notes (extras degrade to
 *   one-line links), each capped per mode, with a hard total cap. Everything
 *   unreadable degrades to a `（引用 X 无法读取）` line; when there is
 *   nothing at all, returns ''.
 */
export async function buildRefContext(
  app: App,
  refs: string[],
  mode: RefMode,
  limits?: RefLimits,
): Promise<string> {
  if (mode === 'link' || refs.length === 0) return ''
  const { maxNotes, excerptMax, fullMax, totalMax } = {
    ...DEFAULT_LIMITS,
    ...limits,
  }
  const perNoteMax = mode === 'excerpt' ? excerptMax : fullMax

  const sections: string[] = []
  refs.forEach((ref, i) => {
    if (i >= maxNotes) {
      // Beyond the expansion cap: keep the reference as a bare link line.
      sections.push(`【引用笔记：${ref}】\n[[${ref}]]`)
      return
    }
    // Placeholder — replaced by the awaited result below (order preserved).
    sections.push('')
  })
  const head = refs.slice(0, maxNotes)
  const expanded = await Promise.all(
    head.map((ref) => sectionFor(app, ref, perNoteMax)),
  )
  for (let i = 0; i < expanded.length; i++) sections[i] = expanded[i]

  let joined = sections.filter((s) => s.length > 0).join('\n\n')
  if (joined.length > totalMax) {
    joined = `${joined.slice(0, totalMax)}\n…（后略，可用 read_note 查看全文）`
  }
  return joined
}
