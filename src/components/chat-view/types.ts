// UI-level chat message. Assistant messages are a list of ordered blocks
// (text + tool calls) so the tool-calling agent can be visualized step by step.

import type { TodoItem } from '../../tools/todoWrite'

export type ToolBlockState = 'running' | 'done' | 'error' | 'retrying'

/** Structured error detail shown as a professional error card (追加⑱ 补刀). */
export interface UiErrorInfo {
  /** Short category label, e.g. 「认证失败 · API Key 无效或已过期」. */
  title: string
  /** Actionable "how to fix" hint. */
  suggestion?: string
  /** HTTP status, when the error came from an HTTP response. */
  status?: number
  /** Full (untruncated) provider error body/message, for diagnosis. */
  raw?: string
}

export type UiBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      callId: string
      name: string
      args?: Record<string, unknown>
      state: ToolBlockState
      summary?: string
      /** Structured tool output (e.g. generated image path). */
      output?: unknown
      /** Model reasoning that preceded this tool call in the same turn
       *  (extended thinking / reasoning_content). Shown as a collapsible
       *  preview inside the tool node. */
      thinking?: string
    }
  /**
   * Task list (清单) block — the TodoWrite-style live checklist. Each
   * todo_write call UPSERTS this block (latest call wins), so a multi-step
   * run shows ONE list whose items move pending → in_progress → completed.
   * `callId` tracks the todo_write call currently reflected, so its
   * tool-result can flip `state` to done/error.
   */
  | {
      kind: 'todo'
      callId: string
      items: TodoItem[]
      state: ToolBlockState
    }

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  /** User messages carry plain content. */
  content?: string
  /** Assistant messages carry ordered blocks. */
  blocks?: UiBlock[]
  isStreaming?: boolean
  error?: string
  /**
   * Structured error info for a professional, diagnosable error card
   * (追加⑱ 补刀): category title + actionable suggestion + raw provider
   * detail, rendered alongside `error` instead of a bare red line.
   */
  errorInfo?: UiErrorInfo
  /**
   * Ephemeral "by-the-way" exchange (/btw): rendered in the chat but NEVER
   * part of the conversation — excluded from the LLM history, persistence,
   * turn counting (/rewind) and title derivation.
   */
  ephemeral?: boolean
  /**
   * The '/' command this assistant message is the successful RESULT of
   * (btw / learn / compact, and future commands): renders a dark-green
   * status pill on the reply when there was no error.
   */
  command?: string
  /**
   * Answer versions (追加52): after a regenerate / edit-and-resend the old
   * answer is NO LONGER deleted — it joins this array of every version
   * (the current one included, at the end), and `activeVersion` points at
   * the one shown. The ◀ N/M ▶ switcher under the answer flips it. When
   * activeVersion points at the LAST entry the message body itself is the
   * live version (streaming patches the body, not the array).
   */
  versions?: UiMessage[]
  activeVersion?: number
}

/** The version a message currently displays (追加52): when the active
 *  pointer names a non-latest entry the array holds it; the latest entry
 *  and the no-versions case both read the message body itself, so streaming
 *  patches to the body always show through. */
export function activeOf(m: UiMessage): UiMessage {
  const versions = m.versions
  if (!versions || versions.length === 0) return m
  const cur = m.activeVersion ?? versions.length - 1
  if (cur >= 0 && cur < versions.length - 1) return versions[cur] ?? m
  return m
}

/** Flip the shown version of one answer by ±1; returns the same array when
 *  the move is impossible. Pure so the switcher logic stays testable. */
export function switchMessageVersion(
  messages: UiMessage[],
  msgId: string,
  dir: -1 | 1,
): UiMessage[] {
  return messages.map((m) => {
    if (m.id !== msgId || !m.versions || m.versions.length < 2) return m
    const total = m.versions.length
    const cur = m.activeVersion ?? total - 1
    const next = cur + dir
    if (next < 0 || next >= total) return m
    return { ...m, activeVersion: next }
  })
}

/** Record a freshly generated answer as the newest version of `prev` (追加52):
 *  the old body joins the version list (unless it already is one — the list
 *  may carry earlier generations), `next` becomes the body and the pointer
 *  lands on the newest entry so activeOf reads the body. */
export function withNewVersion(prev: UiMessage, next: UiMessage): UiMessage {
  const versions = [...(prev.versions ?? [prev]), next]
  return { ...next, versions, activeVersion: versions.length - 1 }
}

export function genId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && 'randomUUID' in cryptoObj) {
    return cryptoObj.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Concatenate the text blocks of an assistant message (for LLM history).
 *  The LATEST todo block is appended as a compact checklist snapshot so the
 *  model keeps seeing task progress across turns (tool results only live
 *  within one send). */
export function textOfBlocks(blocks: UiBlock[] | undefined): string {
  if (!blocks) return ''
  const text = blocks
    .filter((b): b is Extract<UiBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('')
  const todo = [...blocks]
    .reverse()
    .find((b): b is Extract<UiBlock, { kind: 'todo' }> => b.kind === 'todo')
  if (!todo) return text
  const MARK: Record<string, string> = {
    completed: '[x]',
    in_progress: '[→]',
    pending: '[ ]',
  }
  const snapshot = todo.items
    .map((i) => `- ${MARK[i.status] ?? '[ ]'} ${i.content}`)
    .join('\n')
  return text
    ? `${text}\n\n【任务清单】\n${snapshot}`
    : `【任务清单】\n${snapshot}`
}

/** A rewind target: the boundary where one user turn begins. Slicing the
 *  message list at `index` yields a structurally valid shorter conversation
 *  (turns are user + assistant/tool exchanges, so a user boundary is safe). */
export interface TurnPoint {
  /** Index into the message array; slice(0, index) rewinds to before it. */
  index: number
  /** 1-based turn number (user messages only). */
  turn: number
  /** Short preview of the user message, for the picker. */
  preview: string
}

/** Points a backtrack menu may offer: turns whose user message is not the
 *  first one (rewindTo rejects index <= 0 — there is nowhere before the
 *  opening turn). Kept pure so the picker logic stays testable (追加51). */
export function backtrackablePoints(messages: UiMessage[]): TurnPoint[] {
  return turnPoints(messages).filter((p) => p.index > 0)
}

export function turnPoints(messages: UiMessage[]): TurnPoint[] {
  const out: TurnPoint[] = []
  let turn = 0
  messages.forEach((m, index) => {
    if (m.role !== 'user' || m.ephemeral) return
    turn += 1
    const text = (m.content ?? '').replace(/\s+/g, ' ').trim()
    out.push({
      index,
      turn,
      preview:
        text.length > 28 ? `${text.slice(0, 28)}…` : text || '（无内容）',
    })
  })
  return out
}
