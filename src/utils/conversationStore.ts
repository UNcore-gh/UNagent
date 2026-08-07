// Persistent conversation history — one JSON file per conversation plus a
// lightweight index, all under <aiFolder>/conversations/ (default
// .obsidian-ai/conversations/). Conversations form a MULTI-LEVEL tree:
// /branch creates a child that inherits the parent's messages, linked by
// parentId; any conversation can be branched again. The index file mirrors
// just the metadata so listing conversations never reads every message file;
// when the index is missing or corrupt it is rebuilt by scanning the folder.
//
// All I/O goes through the raw adapter (utils/vaultIO): the default data
// folder is dot-prefixed (.obsidian-ai/), which Obsidian's indexed vault
// APIs (getFiles / getAbstractFileByPath / createFolder) cannot see — an
// index scan via getFiles() would come back empty and history would look
// lost. The adapter works on paths directly, so listing and self-healing
// work regardless of visibility. Mobile-safe (no fs, no local database).

import { App, normalizePath } from 'obsidian'
import type { ThinkLevel } from '../core/llm/base'
import type { UiMessage } from '../components/chat-view/types'
import { DEFAULT_AI_FOLDER } from './memoryStore'
import { listAllFiles, readText, removePath, writeText } from './vaultIO'

export const CONVERSATIONS_SUBFOLDER = 'conversations'
export const INDEX_FILENAME = 'index.json'
export const STORE_VERSION = 1

/** Everything the conversation list needs — no message payloads. */
export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Parent conversation id when created via /branch (multi-level tree). */
  parentId: string | null
  /** How many messages were inherited when branched (informational). */
  parentMessageCount: number
  messageCount: number
  /** Sub-agent this conversation belongs to (多 Agent 体系); absent = main. */
  agentId?: string
  /**
   * Hermes ACP session bound to this conversation (任务四): mirrored from
   * StoredConversation.hermesSessionId so the Hermes view can list sessions
   * from the index alone. Absent on non-hermes conversations and on old
   * index entries — those self-heal via rebuildIndex (idempotent, no
   * migration code needed).
   */
  hermesSessionId?: string
}

/** Full on-disk shape of one conversation file (<id>.json). */
export interface StoredConversation extends ConversationMeta {
  version: number
  messages: UiMessage[]
  thinking: ThinkLevel
  modelOverride: string | null
  /**
   * Vault paths of attachments this conversation added from OUTSIDE the
   * vault (pasted / uploaded from the composer). Bound to the conversation:
   * deleted from the vault when the conversation is deleted (追加⑱ 补刀).
   * The message text keeps the file path (a wiki link) for traceability.
   */
  attachments?: string[]
  /**
   * Sub-agent identity this conversation belongs to (多 Agent 体系): the
   * persona note name under <aiFolder>/agents/. Absent/null = the main
   * agent. Optional so existing conversation files stay fully compatible.
   */
  agentId?: string
  /**
   * Hermes ACP session bound to this conversation (补刀·五十六): when the
   * conversation belongs to an engine: hermes agent, the interactive session
   * id survives restarts (hermes persists it in its own state.db; the plugin
   * re-loads it on the next turn). Absent = no hermes session yet.
   */
  hermesSessionId?: string
  /**
   * 分支源的主干 hermes 会话（补刀·六十）：分支 hermes 对话时记录父对话
   * 的 hermesSessionId，首轮发送经 session/fork 在 hermes 侧建真分支
   * （保留主干完整上下文，hermes 桌面端呈分支关系而非并列会话）；首轮
   * 解析后（无论成败）即被消费清除。缺省 = 非分支对话。
   */
  forkSourceHermesSessionId?: string
  /**
   * UPGRADE SLOT (v2, declared but NOT wired in v1): structured per-agent
   * state (e.g. difficulty level). v1 keeps progress in a plain note via
   * the persona's read_note/edit_note protocol; revisit only if that
   * proves insufficient in real use.
   */
  agentState?: Record<string, string>
}

/** Normalize the AI data folder setting; blank falls back to the default. */
export function normalizeAiFolder(aiFolder?: string): string {
  return (aiFolder ?? '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_AI_FOLDER
}

export function conversationsFolder(aiFolder?: string): string {
  return `${normalizeAiFolder(aiFolder)}/${CONVERSATIONS_SUBFOLDER}`
}

function conversationFilePath(aiFolder: string | undefined, id: string): string {
  return `${conversationsFolder(aiFolder)}/${id}.json`
}

function indexPath(aiFolder: string | undefined): string {
  return `${conversationsFolder(aiFolder)}/${INDEX_FILENAME}`
}

export function makeConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Title from the first user message, flattened + capped. */
export function deriveTitle(messages: UiMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content)
  const text = (firstUser?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '新对话'
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

/** Drop transient UI flags (mid-stream markers) before writing to disk. */
export function sanitizeMessages(messages: UiMessage[]): UiMessage[] {
  // Ephemeral /btw exchanges are display-only — they never enter the
  // persisted conversation (nor the LLM history derived from it).
  const clean = (m: UiMessage): UiMessage =>
    m.isStreaming ? { ...m, isStreaming: false } : m
  return messages
    .filter((m) => !m.ephemeral)
    .map((m) =>
      m.versions
        ? { ...clean(m), versions: m.versions.filter((v) => !v.ephemeral).map(clean) }
        : clean(m),
    )
}

export function metaOfConversation(conv: StoredConversation): ConversationMeta {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    parentId: conv.parentId,
    parentMessageCount: conv.parentMessageCount,
    messageCount: conv.messageCount,
    ...(conv.agentId ? { agentId: conv.agentId } : {}),
    ...(conv.hermesSessionId ? { hermesSessionId: conv.hermesSessionId } : {}),
  }
}

/* ── low-level JSON file I/O (adapter-level; see header note) ───────── */

async function readJsonFile(app: App, path: string): Promise<unknown> {
  const text = await readText(app, path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function writeJsonFile(
  app: App,
  path: string,
  data: unknown,
): Promise<void> {
  await writeText(app, path, JSON.stringify(data))
}

/* ── index ──────────────────────────────────────────────────────────── */

interface IndexFile {
  version: number
  entries: ConversationMeta[]
}

function isMeta(x: unknown): x is ConversationMeta {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.title === 'string'
}

async function writeIndex(
  app: App,
  aiFolder: string | undefined,
  entries: ConversationMeta[],
): Promise<void> {
  const index: IndexFile = { version: STORE_VERSION, entries }
  await writeJsonFile(app, indexPath(aiFolder), index)
}

/**
 * Rebuild the index by scanning the conversations folder — used when the
 * index file is missing or corrupt (self-healing; also recovers files the
 * user hand-edited). Rewrites a healthy index when anything was found.
 */
export async function rebuildIndex(
  app: App,
  aiFolder?: string,
): Promise<ConversationMeta[]> {
  const folder = normalizePath(conversationsFolder(aiFolder))
  const entries: ConversationMeta[] = []
  // Adapter-level scan: works even though dot-folders are invisible to
  // vault.getFiles() (the default data folder is .obsidian-ai/).
  for (const path of await listAllFiles(app, folder)) {
    if (!path.endsWith('.json')) continue
    if (path.endsWith(`/${INDEX_FILENAME}`) || path === INDEX_FILENAME) continue
    const text = await readText(app, path)
    if (text === null) continue
    try {
      const conv = JSON.parse(text) as StoredConversation
      if (
        conv &&
        typeof conv.id === 'string' &&
        Array.isArray(conv.messages)
      ) {
        entries.push(metaOfConversation(conv))
      }
    } catch {
      // Unreadable file — skip; the user can fix or delete it.
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  if (entries.length > 0) {
    try {
      await writeIndex(app, aiFolder, entries)
    } catch {
      // Non-fatal: the rebuilt list is still returned for this session.
    }
  }
  return entries
}

/** Load the metadata list; rebuilds (and persists) the index when unhealthy. */
export async function loadIndex(
  app: App,
  aiFolder?: string,
): Promise<ConversationMeta[]> {
  const parsed = (await readJsonFile(app, indexPath(aiFolder))) as
    | IndexFile
    | null
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
    return parsed.entries.filter(isMeta)
  }
  return rebuildIndex(app, aiFolder)
}

/* ── CRUD ───────────────────────────────────────────────────────────── */

/**
 * Write the conversation file AND upsert its metadata into the index
 * (kept most-recently-updated first). Id characters are sanitized so the
 * filename can never escape the conversations folder.
 */
export async function saveConversation(
  app: App,
  aiFolder: string | undefined,
  conv: StoredConversation,
): Promise<void> {
  const id = conv.id.replace(/[^a-zA-Z0-9_-]/g, '') || makeConversationId()
  const safe: StoredConversation = { ...conv, id }
  await writeJsonFile(app, conversationFilePath(aiFolder, id), safe)

  const entries = await loadIndex(app, aiFolder)
  const meta = metaOfConversation(safe)
  const rest = entries.filter((e) => e.id !== id)
  rest.unshift(meta)
  rest.sort((a, b) => b.updatedAt - a.updatedAt)
  await writeIndex(app, aiFolder, rest)
}

/** Read one full conversation; null when missing or unreadable. */
export async function loadConversation(
  app: App,
  aiFolder: string | undefined,
  id: string,
): Promise<StoredConversation | null> {
  const parsed = (await readJsonFile(
    app,
    conversationFilePath(aiFolder, id),
  )) as StoredConversation | null
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) {
    return null
  }
  return {
    ...parsed,
    parentId: parsed.parentId ?? null,
    parentMessageCount: parsed.parentMessageCount ?? 0,
    thinking: parsed.thinking ?? 'off',
    modelOverride: parsed.modelOverride ?? null,
    agentId: typeof parsed.agentId === 'string' ? parsed.agentId : undefined,
    hermesSessionId:
      typeof parsed.hermesSessionId === 'string' ? parsed.hermesSessionId : undefined,
    forkSourceHermesSessionId:
      typeof parsed.forkSourceHermesSessionId === 'string'
        ? parsed.forkSourceHermesSessionId
        : undefined,
  }
}

/** Delete the conversation file and its index entry (idempotent). */
export async function deleteConversation(
  app: App,
  aiFolder: string | undefined,
  id: string,
): Promise<void> {
  // Delete the conversation's bound attachments first (files added from
  // outside the vault, tracked on the conversation) — the message keeps the
  // path for traceability, but the file itself goes (追加⑱ 补刀).
  const conv = await loadConversation(app, aiFolder, id)
  if (conv?.attachments && conv.attachments.length > 0) {
    await Promise.all(
      conv.attachments.map((p) => removePath(app, p).catch(() => undefined)),
    )
  }
  await removePath(app, conversationFilePath(aiFolder, id))
  const entries = await loadIndex(app, aiFolder)
  const next = entries.filter((e) => e.id !== id)
  if (next.length !== entries.length) await writeIndex(app, aiFolder, next)
}

/* ── tree ───────────────────────────────────────────────────────────── */

export interface ConversationTreeNode {
  meta: ConversationMeta
  depth: number
}

/**
 * Flatten the conversation forest for the picker (DFS pre-order). Roots are
 * most-recently-updated first; children are in creation order (the story
 * reads top-down). A conversation whose parent no longer exists is treated
 * as a root — deleting never orphans the display.
 */
export function flattenConversationTree(
  metas: ConversationMeta[],
): ConversationTreeNode[] {
  const byId = new Map(metas.map((m) => [m.id, m]))
  const isRoot = (m: ConversationMeta): boolean =>
    m.parentId === null || !byId.has(m.parentId)
  const childrenOf = (id: string | null): ConversationMeta[] =>
    metas
      .filter((m) => (id === null ? isRoot(m) : m.parentId === id))
      .sort((a, b) =>
        id === null
          ? b.updatedAt - a.updatedAt
          : a.createdAt - b.createdAt,
      )
  const out: ConversationTreeNode[] = []
  const visit = (m: ConversationMeta, depth: number): void => {
    out.push({ meta: m, depth })
    for (const child of childrenOf(m.id)) visit(child, depth + 1)
  }
  for (const root of childrenOf(null)) visit(root, 0)
  return out
}

/** Depth of a conversation in the tree (0 = root); cycle-safe. */
export function conversationDepth(
  metas: ConversationMeta[],
  id: string,
): number {
  const byId = new Map(metas.map((m) => [m.id, m]))
  const seen = new Set<string>()
  let depth = 0
  let cur = byId.get(id)
  while (cur && cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id)
    depth += 1
    cur = byId.get(cur.parentId)
  }
  return depth
}
