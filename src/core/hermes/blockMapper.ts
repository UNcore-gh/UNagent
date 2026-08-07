// Hermes session/update → UiBlock mapping (补刀·五十六). Pure functions:
// the ACP hub feeds updates in, the chat hook renders the returned blocks.
// Mirrors the LLM agent's block semantics: streamed text appends to the tail
// text block, tool_call/tool_call_update drive tool blocks (callId keyed),
// plan upserts the single live todo block, thought chunks accumulate and
// attach to the NEXT tool call (same convention as agentRunner's thinking).
//
// 长任务帧流健壮性契约（M2-T8）：映射对帧序列不敏感——乱序（complete 先于
// start）、缺失帧（只有 start 或只有 complete）、重复帧、畸形载荷（无
// toolCallId / 非法 plan 条目）一律降级而不抛错：孤儿 complete 自成终态
// 卡；迟到 start 只补信息不改终态；未闭合 start 保持进行中态；重复帧幂等。
// 轮末未归属的 thinking 由 flushHermesThinking 兜底固化（不无声丢弃）。

import type { TodoItem } from '../../tools/todoWrite'
import type { UiBlock } from '../../components/chat-view/types'
import type { HermesPermissionRequest, HermesSessionUpdate } from './types'

/** Mutable per-turn accumulation state owned by the caller. */
export interface HermesTurnState {
  /** Thought chunks waiting to attach to the next tool call. */
  thinking: string
}

export interface HermesMapResult {
  blocks: UiBlock[]
  /** Set when the update carried usage/context-window info. */
  usage?: { size?: number; used?: number }
  /** Set when hermes generated/revised the session title. */
  sessionTitle?: string
}

/** Single callId for the upserted plan/todo block (latest plan wins). */
export const HERMES_PLAN_CALL_ID = 'hermes-plan'

const OUTPUT_PREVIEW_CHARS = 1200

/** Flatten hermes tool content (array of typed blocks) into display text. */
export function extractHermesContentText(content: unknown): string | undefined {
  if (content == null) return undefined
  const parts: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string') {
      parts.push(v)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) push(item)
      return
    }
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>
      if (typeof o.text === 'string') {
        parts.push(o.text)
      } else if (o.content !== undefined) {
        push(o.content)
      } else if (o.diff !== undefined) {
        push(o.diff)
      }
    }
  }
  push(content)
  const text = parts.join('\n').trim()
  if (!text) return undefined
  return text.length > OUTPUT_PREVIEW_CHARS
    ? `${text.slice(0, OUTPUT_PREVIEW_CHARS)}…`
    : text
}

/** 定位 callId 对应的工具卡（块列表只增不删、原位更新，索引语义稳定）。 */
function findToolBlockIndex(blocks: UiBlock[], callId: string): number {
  return blocks.findIndex(
    (b): b is Extract<UiBlock, { kind: 'tool' }> =>
      b.kind === 'tool' && b.callId === callId,
  )
}

/** 规范化 wire 上的 toolCallId——空/非字符串视为畸形帧（返回空串）。 */
function normalizeCallId(raw: unknown): string {
  return typeof raw === 'string' && raw !== '' ? raw : ''
}

function mapPlanStatus(
  status: string | undefined,
): TodoItem['status'] {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'completed') return 'completed'
  return 'pending'
}

/**
 * Apply one session/update to the block list. Returns the new list (input is
 * never mutated). Unknown update kinds are ignored (forward compatibility —
 * hermes may add new kinds; the conversation must not break).
 */
export function applyHermesUpdate(
  blocks: UiBlock[],
  state: HermesTurnState,
  update: HermesSessionUpdate,
): HermesMapResult {
  // 联合类型带 catch-all 索引签名（前向兼容未知 update 种类），判别收窄
  // 会被它污染成 unknown——各 case 内先 Extract 出精确变体再用。
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'agent_message_chunk' }
      >
      const text = u.content?.text ?? ''
      if (!text) return { blocks }
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'text') {
        return {
          blocks: [...blocks.slice(0, -1), { kind: 'text', text: last.text + text }],
        }
      }
      return { blocks: [...blocks, { kind: 'text', text }] }
    }

    case 'agent_thought_chunk': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'agent_thought_chunk' }
      >
      const text = u.content?.text ?? ''
      if (text) state.thinking += text
      return { blocks }
    }

    case 'tool_call': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'tool_call' }
      >
      // 畸形帧（无 toolCallId）无法配对也无法定位——丢弃，绝不产生无键卡片。
      const callId = normalizeCallId(u.toolCallId)
      if (!callId) return { blocks }
      const args =
        typeof u.rawInput === 'object' && u.rawInput !== null
          ? (u.rawInput as Record<string, unknown>)
          : undefined
      const name = u.title ?? u.kind ?? 'tool'
      const idx = findToolBlockIndex(blocks, callId)
      if (idx !== -1) {
        // 已有同 callId 卡片 = 重复帧或乱序（complete 先于 start 时孤儿
        // update 已建卡）。不新建卡片：
        //  - 进行中 → 重复 start，原位补齐 title/args（不覆盖已有信息）；
        //  - 已终态 → 迟到的 start，补 args 但保持终态渲染。
        // pending thinking：卡片还没有 thinking 时才补挂并消费（乱序场景下
        // 思考确实属于这个工具）；已有 thinking 的重复 start 不重复消费。
        const existing = blocks[idx] as Extract<UiBlock, { kind: 'tool' }>
        const pending =
          existing.thinking === undefined && state.thinking.trim()
            ? state.thinking.trim()
            : undefined
        if (pending) state.thinking = ''
        const merged: UiBlock = {
          ...existing,
          ...(existing.name === 'tool' && name !== 'tool' ? { name } : {}),
          ...(existing.args === undefined && args ? { args } : {}),
          ...(pending ? { thinking: pending } : {}),
        }
        return { blocks: [...blocks.slice(0, idx), merged, ...blocks.slice(idx + 1)] }
      }
      // 全新卡片才消费 thinking——思考归属「下一个工具」的语义在这里兑现。
      const thinking = state.thinking.trim() ? state.thinking.trim() : undefined
      state.thinking = ''
      const block: UiBlock = {
        kind: 'tool',
        callId,
        name,
        ...(args ? { args } : {}),
        state: 'running',
        ...(thinking ? { thinking } : {}),
      }
      return { blocks: [...blocks, block] }
    }

    case 'tool_call_update': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'tool_call_update' }
      >
      const callId = normalizeCallId(u.toolCallId)
      if (!callId) return { blocks } // 畸形帧：无法配对，丢弃。
      const output = extractHermesContentText(u.content ?? u.rawOutput)
      const idx = findToolBlockIndex(blocks, callId)
      if (idx === -1) {
        // 孤儿 complete（start 帧丢失/乱序未到达）：自成终态卡片，结果仍可见。
        // status 缺失时没有 start 可参照，按完成渲染（降级优先于留白）。
        return {
          blocks: [
            ...blocks,
            {
              kind: 'tool',
              callId,
              name: u.title ?? u.kind ?? 'tool',
              state: u.status === 'failed' ? 'error' : 'done',
              ...(output !== undefined ? { output } : {}),
            },
          ],
        }
      }
      const b = blocks[idx] as Extract<UiBlock, { kind: 'tool' }>
      const failed = u.status === 'failed'
      // status 缺失 = 中间进度帧（hermes 当前只发终态帧，但 ACP 允许进度
      // 更新）——保留现有 state，只刷新 title/output，不误判为完成。
      // 重复终态帧天然幂等：同值覆盖；新帧无 output 时保留旧 output。
      const nextState =
        u.status === undefined ? b.state : failed ? 'error' : 'done'
      const merged: UiBlock = {
        ...b,
        state: nextState,
        ...(u.title ? { name: u.title } : {}),
        ...(output !== undefined ? { output } : {}),
        summary: failed ? '失败' : u.status === 'completed' ? undefined : b.summary,
      }
      return { blocks: [...blocks.slice(0, idx), merged, ...blocks.slice(idx + 1)] }
    }

    case 'plan': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'plan' }
      >
      const entries = Array.isArray(u.entries) ? u.entries : []
      if (entries.length === 0) return { blocks }
      // 畸形条目（null/字符串/缺字段）逐项降级而不是抛错——长任务帧流里
      // 任何一帧出问题都不允许打断整个清单渲染。
      const items: TodoItem[] = (
        entries.filter((e) => typeof e === 'object' && e !== null) as unknown as Array<
          Record<string, unknown>
        >
      )
        .slice(0, 30)
        .map((e) => ({
          content: String(e.content ?? '').slice(0, 120),
          status: mapPlanStatus(typeof e.status === 'string' ? e.status : undefined),
        }))
      if (items.length === 0) return { blocks }
      const allDone = items.every((i) => i.status === 'completed')
      const todoBlock: UiBlock = {
        kind: 'todo',
        callId: HERMES_PLAN_CALL_ID,
        items,
        state: allDone ? 'done' : 'running',
      }
      const idx = blocks.findIndex(
        (b) => b.kind === 'todo' && b.callId === HERMES_PLAN_CALL_ID,
      )
      if (idx === -1) return { blocks: [...blocks, todoBlock] }
      return { blocks: [...blocks.slice(0, idx), todoBlock, ...blocks.slice(idx + 1)] }
    }

    case 'usage_update': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'usage_update' }
      >
      return { blocks, usage: { size: u.size, used: u.used } }
    }

    case 'session_info_update': {
      const u = update as Extract<
        HermesSessionUpdate,
        { sessionUpdate: 'session_info_update' }
      >
      return { blocks, sessionTitle: u.title }
    }

    default:
      // available_commands_update / unknown kinds — nothing to render.
      return { blocks }
  }
}

/* ── 思考兜底（M2-T8） ──────────────────────────────────────────────
 * thinking 的归属语义是「挂到下一个工具卡」。一轮结束仍无后续工具时，
 * 缓冲的思考不能无声丢弃——flushHermesThinking 把它固化成一张独立的
 * 「思考」卡片（已完成的 think 工具形态，UI 按折叠思考块渲染）。
 * 纯函数、幂等（固定 callId，重复 flush 只合并文本），由轮末收尾调用。 */

/** 思考兜底卡的固定 callId（同轮内只会存在一张）。 */
export const HERMES_THOUGHT_CALL_ID = 'hermes-thought'

/**
 * 轮末收尾：若仍有未归属的 thinking，落成一张思考卡并清空缓冲。
 * 无 pending 思考时原样返回 blocks（不产生空卡）。
 */
export function flushHermesThinking(
  blocks: UiBlock[],
  state: HermesTurnState,
): UiBlock[] {
  const thinking = state.thinking.trim()
  if (!thinking) return blocks
  state.thinking = ''
  const idx = findToolBlockIndex(blocks, HERMES_THOUGHT_CALL_ID)
  if (idx !== -1) {
    // 极端情况（同一轮多次 flush）：合并到已有思考卡，不新建。
    const existing = blocks[idx] as Extract<UiBlock, { kind: 'tool' }>
    const merged: UiBlock = {
      ...existing,
      thinking: existing.thinking ? `${existing.thinking}\n${thinking}` : thinking,
    }
    return [...blocks.slice(0, idx), merged, ...blocks.slice(idx + 1)]
  }
  return [
    ...blocks,
    {
      kind: 'tool',
      callId: HERMES_THOUGHT_CALL_ID,
      name: '思考',
      state: 'done',
      thinking,
    },
  ]
}

/* ── permission request → approval panel model (M2-T7) ─────────────────
 * session/request_permission 载荷 → 审批面板数据模型的纯映射。hermes 侧两
 * 种构造（acp_adapter/permissions.py 的 execute 命令 / edit_approval.py 的
 * 编辑提案）：execute 带 {type:'content'} 文本块；edit 带 {type:'diff',
 * path, oldText?, newText?}（oldText=null = 新建文件或 V4A 多文件 patch）。
 * 映射层把 diff 两边原文算成行级 unified diff，面板只负责渲染。 */

export interface HermesDiffLine {
  /** add = 新增行（绿）/ del = 删除行（红）/ ctx = 上下文行。 */
  type: 'add' | 'del' | 'ctx'
  text: string
}

export interface HermesDiffFile {
  path: string
  /** oldText 缺失 = 新建文件（或 V4A patch 体）——整段按新增渲染。 */
  isNewFile: boolean
  lines: HermesDiffLine[]
  additions: number
  deletions: number
  /** 截断前的真实行数。 */
  totalLines: number
  /** 超过 DIFF_MAX_LINES 时截断，面板提示剩余行数。 */
  truncated: boolean
}

export interface HermesApprovalModel {
  kind: string
  title?: string
  /** execute 类请求的说明文本（保持原有展示）。 */
  texts: string[]
  /** edit 类请求的结构化 diff（无 diff 块时为空数组）。 */
  diffs: HermesDiffFile[]
}

/** LCS 单元格上限——再大的文件对降级为「整体替换」展示，防 DP 爆内存。 */
const DIFF_LCS_CELL_CAP = 600_000
/** 面板数据模型行数上限（超长折叠/滚动之外的最后一道保护）。 */
const DIFF_MAX_LINES = 1500

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // 结尾换行产生的空尾行没有信息量，去掉。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * oldText/newText → 行级 unified diff（纯函数）。LCS 动态规划；规模超过
 * DIFF_LCS_CELL_CAP 时降级为「全删 + 全增」，保证审批面板永远拿得到结果。
 */
export function computeUnifiedDiff(
  oldText: string | null,
  newText: string,
): { lines: HermesDiffLine[]; additions: number; deletions: number; totalLines: number; truncated: boolean } {
  const oldLines = oldText == null ? [] : splitLines(oldText)
  const newLines = splitLines(newText)
  const n = oldLines.length
  const m = newLines.length

  let merged: HermesDiffLine[]
  if (n === 0) {
    merged = newLines.map((text) => ({ type: 'add' as const, text }))
  } else if (m === 0) {
    merged = oldLines.map((text) => ({ type: 'del' as const, text }))
  } else if (n * m > DIFF_LCS_CELL_CAP) {
    // 规模过大：不做 LCS，整体替换展示（语义仍是「删旧增新」）。
    merged = [
      ...oldLines.map((text) => ({ type: 'del' as const, text })),
      ...newLines.map((text) => ({ type: 'add' as const, text })),
    ]
  } else {
    const W = m + 1
    const dp = new Int32Array((n + 1) * W)
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i * W + j] =
          oldLines[i - 1] === newLines[j - 1]
            ? dp[(i - 1) * W + (j - 1)] + 1
            : Math.max(dp[(i - 1) * W + j], dp[i * W + (j - 1)])
      }
    }
    const rev: HermesDiffLine[] = []
    let i = n
    let j = m
    while (i > 0 && j > 0) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        rev.push({ type: 'ctx', text: oldLines[i - 1] })
        i--
        j--
      } else if (dp[(i - 1) * W + j] > dp[i * W + (j - 1)]) {
        // 平局时先回溯 add（逆序压栈）——保证正序输出「删行在增行前」，
        // 与 unified diff 惯例一致。
        rev.push({ type: 'del', text: oldLines[i - 1] })
        i--
      } else {
        rev.push({ type: 'add', text: newLines[j - 1] })
        j--
      }
    }
    while (i > 0) {
      rev.push({ type: 'del', text: oldLines[--i] })
    }
    while (j > 0) {
      rev.push({ type: 'add', text: newLines[--j] })
    }
    merged = rev.reverse()
  }

  const totalLines = merged.length
  const truncated = totalLines > DIFF_MAX_LINES
  const lines = truncated ? merged.slice(0, DIFF_MAX_LINES) : merged
  let additions = 0
  let deletions = 0
  for (const line of merged) {
    if (line.type === 'add') additions++
    else if (line.type === 'del') deletions++
  }
  return { lines, additions, deletions, totalLines, truncated }
}

/**
 * 权限请求载荷 → 审批面板数据模型（纯函数）。未知/畸形 content 块一律跳过
 * （前向兼容）；非 edit 类请求 diffs 为空、texts 保持原有语义。
 */
export function parseHermesPermissionRequest(
  request: HermesPermissionRequest,
): HermesApprovalModel {
  const toolCall = request.toolCall
  const model: HermesApprovalModel = {
    kind: toolCall?.kind ?? 'other',
    ...(toolCall?.title ? { title: toolCall.title } : {}),
    texts: [],
    diffs: [],
  }
  const blocks = toolCall?.content
  if (!Array.isArray(blocks)) return model
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'diff' && typeof (block as { path?: unknown }).path === 'string') {
      const d = block as { path: string; oldText?: string | null; newText?: string | null }
      const diff = computeUnifiedDiff(d.oldText ?? null, d.newText ?? '')
      model.diffs.push({
        path: d.path,
        isNewFile: d.oldText == null,
        ...diff,
      })
      continue
    }
    if (block.type === 'content') {
      const inner = (block as { content?: { text?: unknown } }).content
      if (inner && typeof inner.text === 'string') model.texts.push(inner.text)
    }
  }
  return model
}
