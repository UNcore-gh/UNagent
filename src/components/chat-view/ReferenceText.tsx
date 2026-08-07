import React, { useMemo } from 'react'

import { usePlugin } from '../../contexts/plugin-context'
import {
  PH_A,
  PH_B,
  PH_C,
  PH_D,
  injectChips,
  injectCommandChips,
} from './chipInject'
import type { CommandChip } from './chipInject'
import { COMMANDS } from './commands'
import { groupMentions, segmentValue } from './mention'
import type { MentionRun } from './mention'
import { findInlineCommandTokens } from './slash'
import { useNativeMarkdown } from './nativeMarkdown'

/**
 * The AI answer's inline text with references rendered as "引用"-style chips
 * — now on top of Obsidian's NATIVE renderer (追加㉛): mention runs become
 * invisible placeholder tokens BEFORE rendering, then the rendered DOM's text
 * nodes get the tokens swapped for chips (chipInject). Inline command/skill
 * tokens ("/cmd", "//skill-name") get the same treatment with their own
 * placeholder pair (追加㊺). A text without references renders exactly like
 * plain Markdown; any segmentation hiccup falls back to the untouched source
 * so a single bad reference can never blank the whole answer.
 *
 * Reused for USER messages (追加㊺): the user's own text gets the same native
 * rendering + chips (markdown, references and command tokens alike).
 */

/** Pure: bracket every mention run with placeholder tokens + collect the
 *  runs (same order as the tokens); then bracket known inline command/skill
 *  tokens with the command placeholder pair. Exported for unit tests. */
export function buildMarked(
  content: string,
  skillNames?: ReadonlySet<string>,
): {
  marked: string
  chips: MentionRun[]
  commands: CommandChip[]
} {
  try {
    const segments = groupMentions(segmentValue(content))
    const chips: MentionRun[] = []
    let marked = ''
    for (const run of segments) {
      if (run.type === 'text') {
        marked += run.text
        continue
      }
      marked += `${PH_A}${chips.length}${PH_B}`
      chips.push(run)
    }

    // Command pass over the mention-marked text: only KNOWN commands and
    // KNOWN skills become pills — "/20", "//whatever" and URLs stay plain
    // prose (the scanner is boundary-aware, the known-check is the second
    // gate).
    const commands: CommandChip[] = []
    let cmdMarked = ''
    let last = 0
    for (const t of findInlineCommandTokens(marked)) {
      const def =
        t.slashes === 1 ? COMMANDS.find((c) => c.id === t.name) : undefined
      const skill = t.slashes === 2 && skillNames?.has(t.name) === true
      if (!def && !skill) continue
      cmdMarked += marked.slice(last, t.start)
      cmdMarked += `${PH_C}${commands.length}${PH_D}`
      commands.push({
        label: def?.label ?? t.name,
        icon: def?.icon ?? 'sparkles',
      })
      last = t.end
    }
    cmdMarked += marked.slice(last)
    return { marked: cmdMarked, chips, commands }
  } catch {
    return { marked: content, chips: [], commands: [] }
  }
}

/** memo: a streamed chunk only mutates the in-flight text block; untouched
 *  blocks keep their string reference, so memo skips re-rendering (and
 *  re-running the native renderer for) them entirely (移动端重渲染成本). */
export const ReferenceText = React.memo(function ReferenceText({
  content,
}: {
  content: string
}) {
  const plugin = usePlugin()
  // Known skill names — the second gate for "//skill-name" tokens (the
  // registry lives on the plugin; reloads change its contents, not identity).
  // 追加89: 热重载原地换内容——订阅数据变更通知，用 tick 驱动重算，
  // 新技能落盘后不必重开视图就能被 // token 识别。
  const [skillsTick, setSkillsTick] = React.useState(0)
  React.useEffect(
    () => plugin.addDataChangeListener(() => setSkillsTick((t) => t + 1)),
    [plugin],
  )
  const skillNames = useMemo(
    () => new Set(plugin.skills.getAll().map((s) => s.metadata.name)),
    [plugin.skills, skillsTick],
  )
  const { marked, chips, commands } = useMemo(
    () => buildMarked(content, skillNames),
    [content, skillNames],
  )
  // Post-render hook: swap placeholder tokens for chips (only when needed).
  const post = useMemo(
    () =>
      chips.length === 0 && commands.length === 0
        ? undefined
        : (el: HTMLElement) => {
            injectChips(el, chips, plugin)
            injectCommandChips(el, commands)
          },
    [chips, commands, plugin],
  )
  const elRef = useNativeMarkdown(marked, post)
  return (
    <div
      ref={elRef}
      className="UNagent-markdown markdown-preview-view markdown-rendered"
    />
  )
})
