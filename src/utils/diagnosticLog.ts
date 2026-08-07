// User-opt-in diagnostic log (诊断日志). Shipped disabled: when the switch is
// OFF this module is a pure no-op — no buffer growth, no disk I/O, a single
// boolean check per call. When the user enables it (设置 → 通用 → 诊断与反馈)
// lines are buffered in memory and flushed to
// <configDir>/plugins/<id>/diag-log.txt (same invisible config dir as
// boot-log.txt — never pollutes the user's note list), and can be exported to
// a visible note + clipboard so the user can send it to the developer.
//
// Privacy contract (must hold for every call site, present and future):
// - NEVER log API keys, request bodies, note CONTENTS or user message text.
//   Log metadata only: endpoint host, HTTP status, model id, tool name,
//   error classifications, file paths of plugin-owned data.
// - The export header restates this contract so recipients know what they got.
//
// Future features plug in with one line: dlog('info'|'warn'|'error', scope,
// msg). console.error lines tagged '[UNagent]' are also mirrored here by
// the main.ts console hook, so the existing error convention keeps working.

import type { App } from 'obsidian'
import { PLUGIN_ID } from '../constants'

export type DiagLevel = 'info' | 'warn' | 'error'

/** Max lines buffered in memory before a forced flush. */
export const DIAG_BUFFER_MAX = 80
/** Idle debounce (ms) before the buffer is written to disk. */
export const DIAG_FLUSH_DELAY_MS = 1_500
/** The on-disk file keeps only the most recent N lines. */
export const DIAG_FILE_MAX_LINES = 1_500
/** Single lines are truncated beyond this many characters. */
export const DIAG_LINE_MAX = 500

interface DiagState {
  app: App | null
  enabled: boolean
  buffer: string[]
  timer: ReturnType<typeof setTimeout> | null
}

// Module-level singleton: exactly one log per webview, survives
// disable→enable cycles, and — crucially — starts DISABLED so a fresh install
// performs zero work per dlog call.
const state: DiagState = { app: null, enabled: false, buffer: [], timer: null }

/** Pure: format one log line. `timestamp` injectable for tests. */
export function formatLine(
  level: DiagLevel,
  scope: string,
  message: string,
  timestamp: string = new Date().toISOString(),
): string {
  const clean = message.replace(/\s+/g, ' ').trim().slice(0, DIAG_LINE_MAX)
  return `${timestamp}\t${level.toUpperCase()}\t[${scope}] ${clean}`
}

/** Pure: keep only the most recent `max` lines. */
export function trimLines(lines: string[], max: number): string[] {
  return lines.length > max ? lines.slice(-max) : lines
}

export function diagLogPath(app: App): string {
  return `${app.vault.configDir}/plugins/${PLUGIN_ID}/diag-log.txt`
}

export function diagnosticsEnabled(): boolean {
  return state.enabled
}

/**
 * Wire the logger to the vault and set the switch. Called from main.ts after
 * loadSettings (initial value) and again whenever the settings toggle flips.
 * Turning OFF flushes whatever is buffered (already-recorded lines are kept
 * on disk for the user to export) and stops all further recording.
 */
export function setDiagnostics(app: App, enabled: boolean): void {
  state.app = app
  if (state.enabled === enabled) return
  state.enabled = enabled
  if (!enabled) {
    // Flush the remainder so enabling→disabling loses nothing already seen.
    void flushDiagBuffer()
  }
}

/**
 * Log one line. NO-OP (single boolean check) when diagnostics are off — the
 * "彻底静默" guarantee. Never throws; a failed diagnostic must never break
 * the plugin. Message formatting happens AFTER the enabled check so disabled
 * callers pay nothing beyond the call itself.
 */
export function dlog(level: DiagLevel, scope: string, message: string): void {
  if (!state.enabled) return
  try {
    state.buffer.push(formatLine(level, scope, message))
    if (state.buffer.length >= DIAG_BUFFER_MAX) {
      void flushDiagBuffer()
    } else if (state.timer === null) {
      state.timer = setTimeout(() => {
        state.timer = null
        void flushDiagBuffer()
      }, DIAG_FLUSH_DELAY_MS)
    }
  } catch {
    // Logging must never throw.
  }
}

/** Write the buffer to disk (read-modify-write, capped at DIAG_FILE_MAX_LINES). */
export async function flushDiagBuffer(): Promise<void> {
  if (state.timer !== null) {
    clearTimeout(state.timer)
    state.timer = null
  }
  const app = state.app
  if (!app || state.buffer.length === 0) return
  const lines = state.buffer
  state.buffer = []
  try {
    const path = diagLogPath(app)
    let existing = ''
    try {
      existing = await app.vault.adapter.read(path)
    } catch {
      // First flush (file absent) or unreadable — start fresh.
    }
    const all = existing
      .split('\n')
      .filter((l) => l.length > 0)
      .concat(lines)
    await app.vault.adapter.write(path, trimLines(all, DIAG_FILE_MAX_LINES).join('\n') + '\n')
  } catch {
    // Diagnostics must never break the plugin.
  }
}

/** Read the persisted log ('' when absent/unreadable). */
export async function readDiagnosticLog(app: App): Promise<string> {
  try {
    return await app.vault.adapter.read(diagLogPath(app))
  } catch {
    return ''
  }
}

/** Delete the persisted log file (no-op when missing). */
export async function clearDiagnosticLog(app: App): Promise<void> {
  try {
    const path = diagLogPath(app)
    if (await app.vault.adapter.exists(path)) {
      await app.vault.adapter.remove(path)
    }
  } catch {
    // Best-effort.
  }
}
