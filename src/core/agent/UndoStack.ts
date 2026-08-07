// A tiny "undo last step" stack. Editing tools push a revert closure; the UI
// offers an undo action that pops and runs the most recent one. v1 keeps this
// in-memory and single-level-deep per PLAN ("至少支持 editNote 的内容回滚").
// 追加62: entries carry a conversation + turn tag so /rewind can offer to
// roll back every AI edit made from that turn on (rollbackFrom).
// Task #6: entries may additionally carry serializable UndoData so the stack
// can be persisted (setPersist) and rebuilt after restart (hydrate). The
// closure semantics are unchanged — data is a parallel payload bound to the
// same entry, removed whenever the entry is consumed or evicted.

import { Notice } from 'obsidian'
import type { UndoData } from '../../utils/undoStore'

/** 写入条目的归属标签：哪个会话、第几轮（1-based user turn）。 */
export interface UndoMeta {
  convId?: string
  turnNo?: number
}

interface UndoEntry {
  label: string
  revert: () => Promise<void>
  meta: UndoMeta
  /** Serializable snapshot for persistence (optional — runtime-only pushes
   *  may omit it). Travels with the entry through pop/rollback/eviction. */
  data?: UndoData
}

export class UndoStack {
  private entries: UndoEntry[] = []
  private listeners = new Set<() => void>()
  private persist: ((entries: UndoData[]) => Promise<void>) | null = null

  push(
    label: string,
    revert: () => Promise<void>,
    meta: UndoMeta = {},
    data?: UndoData,
  ): void {
    this.entries.push({ label, revert, meta, data })
    // Bound memory; only recent history is meaningfully undoable.
    if (this.entries.length > 20) this.entries.shift()
    this.emit()
    this.firePersist()
  }

  canUndo(): boolean {
    return this.entries.length > 0
  }

  lastLabel(): string | undefined {
    return this.entries[this.entries.length - 1]?.label
  }

  async undoLast(): Promise<void> {
    const entry = this.entries.pop()
    this.emit()
    this.firePersist()
    if (!entry) return
    try {
      await entry.revert()
      new Notice(`已撤销：${entry.label}`)
    } catch (err) {
      new Notice(`撤销失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  /** 该会话第 turnNo 轮及之后 push 的条目数（回溯询问用）。 */
  countFor(convId: string, turnNo: number): number {
    return this.entries.filter(
      (e) => e.meta.convId === convId && (e.meta.turnNo ?? 0) >= turnNo,
    ).length
  }

  /** 回滚该会话 turnNo 及之后的条目（逆序执行 revert），其他条目原位保留；
   *  返回成功回滚的条数。 */
  async rollbackFrom(convId: string, turnNo: number): Promise<number> {
    const isTarget = (e: UndoEntry): boolean =>
      e.meta.convId === convId && (e.meta.turnNo ?? 0) >= turnNo
    const mine = this.entries.filter(isTarget)
    this.entries = this.entries.filter((e) => !isTarget(e))
    this.emit()
    this.firePersist()
    let n = 0
    for (const e of [...mine].reverse()) {
      try {
        await e.revert()
        n += 1
      } catch (err) {
        new Notice(
          `回滚失败：${e.label}（${err instanceof Error ? err.message : '未知错误'}）`,
        )
      }
    }
    return n
  }

  /**
   * Install (or clear, with null) the persistence callback. After every
   * push/undoLast/rollbackFrom the callback is invoked fire-and-forget with
   * the current persistable entries.
   */
  setPersist(fn: ((entries: UndoData[]) => Promise<void>) | null): void {
    this.persist = fn
  }

  /** Current persistable entries (stack order, oldest first). */
  currentData(): UndoData[] {
    const out: UndoData[] = []
    for (const e of this.entries) if (e.data) out.push(e.data)
    return out
  }

  /**
   * Rebuild stack entries from persisted data (startup hydration). The
   * revert closure cannot be serialized, so `rebuild` reconstructs it from
   * each entry's data — returning null skips that entry (e.g. its note no
   * longer resolves). Hydrated entries participate in undoLast/rollbackFrom/
   * countFor exactly like runtime pushes. Label/meta come from the data.
   */
  hydrate(
    entries: UndoData[],
    rebuild: (data: UndoData) => (() => Promise<void>) | null,
  ): void {
    const hydrated: UndoEntry[] = []
    for (const data of entries) {
      const revert = rebuild(data)
      if (!revert) continue
      hydrated.push({
        label: data.label,
        revert,
        meta: { convId: data.convId, turnNo: data.turnNo },
        data,
      })
    }
    // Same memory bound as runtime pushes (keep the newest).
    this.entries = hydrated.length > 20 ? hydrated.slice(hydrated.length - 20) : hydrated
    this.emit()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Fire-and-forget persistence. The .catch() is deliberate: on mobile an
   * unhandled rejection here (e.g. adapter write failure mid-sync) has
   * historically been enough to drag the whole plugin down — persistence is
   * best-effort and must never break the undo flow itself.
   */
  private firePersist(): void {
    const fn = this.persist
    if (!fn) return
    fn(this.currentData()).catch(() => {})
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
