// Persistent undo entries (Task #6). The in-memory UndoStack holds revert
// closures; this store holds the SERIALIZABLE counterpart so undo survives
// app restarts. undo.json is plugin-internal data → it lives under the AI
// data folder and MUST go through the adapter-level vaultIO helpers
// (Obsidian never indexes dot-prefixed folders, so vault-level APIs are
// blind there). Pure plugin JS — mobile-safe.

import type { App } from 'obsidian'
import { readText, writeText } from './vaultIO'

/** One serializable undo entry (snapshot of what a revert needs). */
export interface UndoData {
  /** Unique entry id (genUndoId). */
  id: string
  /** Human label, same wording as the in-memory stack entry. */
  label: string
  /** Owning conversation (filled by the agent layer, optional here). */
  convId?: string
  /** 1-based user turn inside the conversation (optional, see convId). */
  turnNo?: number
  /** Epoch ms when the entry was recorded. */
  at: number
  /** 'modify' = note content changed; 'delete' = note trashed. */
  kind: 'modify' | 'delete'
  /** Note path the entry applies to. */
  path: string
  /** Full note content BEFORE the change (used to restore). */
  before: string
}

/** Max entries persisted to undo.json (older ones are dropped). */
export const MAX_UNDO_PERSISTED = 10
/**
 * Max snapshot size (in CHARACTERS) eligible for persistence. Entries with a
 * larger `before` are DROPPED from the persisted set — never truncated: a
 * truncated snapshot would corrupt the note if rolled back. In-memory undo
 * of oversized entries still works for the current session.
 */
export const MAX_SNAPSHOT_CHARS = 100 * 1024

/** Short collision-resistant id (no crypto dependency — mobile-safe). */
export function genUndoId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export function serializeEntries(entries: UndoData[]): string {
  return JSON.stringify(entries)
}

function isValidEntry(value: unknown): value is UndoData {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id) return false
  if (typeof v.label !== 'string') return false
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false
  if (v.kind !== 'modify' && v.kind !== 'delete') return false
  if (typeof v.path !== 'string' || !v.path) return false
  if (typeof v.before !== 'string') return false
  if (v.convId !== undefined && typeof v.convId !== 'string') return false
  if (v.turnNo !== undefined && typeof v.turnNo !== 'number') return false
  return true
}

/** Parse a persisted undo.json payload; bad JSON / bad entries self-heal to []. */
export function parseEntries(json: string | null): UndoData[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidEntry)
  } catch {
    return []
  }
}

/**
 * Persistence-side limits: drop entries whose snapshot exceeds
 * MAX_SNAPSHOT_CHARS (see its doc — truncation would corrupt notes), then
 * keep only the newest `maxCount` entries.
 */
export function applyLimits(entries: UndoData[], maxCount = MAX_UNDO_PERSISTED): UndoData[] {
  const eligible = entries.filter((e) => e.before.length <= MAX_SNAPSHOT_CHARS)
  return eligible.length > maxCount ? eligible.slice(eligible.length - maxCount) : eligible
}

/** Load persisted undo entries; missing/corrupt store → []. */
export async function loadUndoStore(app: App, aiFolder: string): Promise<UndoData[]> {
  const json = await readText(app, `${aiFolder}/undo.json`)
  return parseEntries(json)
}

/** Save undo entries (caller applies applyLimits first). */
export async function saveUndoStore(
  app: App,
  aiFolder: string,
  entries: UndoData[],
): Promise<void> {
  await writeText(app, `${aiFolder}/undo.json`, serializeEntries(entries))
}
