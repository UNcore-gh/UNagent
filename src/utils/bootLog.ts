// Persistent boot breadcrumbs (启动诊断). The plugin auto-disables on some
// mobile devices after one or two Obsidian reloads. Every JS throw path in
// onload / view-restore is already wrapped in try-catch (see main.ts +
// ChatView.tsx), so a plugin that STILL gets disabled is almost certainly
// dying to something JS cannot catch — a hard WKWebView crash / OOM during
// startup, after which Obsidian disables the plugin as a safety measure.
//
// A live debugger is impractical on a phone, and an in-memory log dies with
// the crash. So we drop a durable breadcrumb to DISK at each startup phase:
// after a crash-then-disable, re-enabling the plugin and exporting this log
// tells us exactly which phase was the LAST one reached — i.e. which phase
// crashed.
//
// Written through the raw adapter to the plugin's own config dir
// (<configDir>/plugins/<id>/boot-log.txt): no dependency on user settings
// (usable before loadSettings), survives reloads, mobile-safe (no fs).

import { App } from 'obsidian'
import { PLUGIN_ID } from '../constants'

/** Keep only the most recent N lines so the log can never grow unbounded. */
const MAX_LINES = 240

function logPath(app: App): string {
  return `${app.vault.configDir}/plugins/${PLUGIN_ID}/boot-log.txt`
}

/**
 * Append one timestamped phase marker to the on-disk boot log, then flush.
 *
 * Stateless (re-reads the file each call) so it behaves identically across a
 * full app reload, a disable→enable cycle, and multiple plugin instances —
 * ordering is preserved by awaiting the write. Callers should AWAIT this at
 * each phase boundary: the whole point is that phase N's marker is durably on
 * disk BEFORE phase N's risky work runs, so a hard crash leaves that marker
 * as the last line. Never throws — a failed diagnostic write must not itself
 * take the plugin down.
 */
export async function bootLog(app: App, phase: string): Promise<void> {
  try {
    const stamp = new Date().toISOString()
    const line = `${stamp}\t${phase}`
    let existing = ''
    try {
      existing = await app.vault.adapter.read(logPath(app))
    } catch {
      // First run (file absent) or unreadable — start fresh.
    }
    const lines = existing.split('\n').filter((l) => l.length > 0)
    lines.push(line)
    const tail = lines.slice(-MAX_LINES)
    await app.vault.adapter.write(logPath(app), tail.join('\n') + '\n')
  } catch {
    // Diagnostics must never break the plugin.
  }
}

/** Read the full boot log ('' when absent/unreadable). */
export async function readBootLog(app: App): Promise<string> {
  try {
    return await app.vault.adapter.read(logPath(app))
  } catch {
    return ''
  }
}

/**
 * Synchronous unload marker via localStorage. The async bootLog() write can
 * lose the race when the webview is hard-killed during teardown — and the
 * mobile reload logs showed exactly that (no 'onunload' line between
 * reloads). localStorage is synchronous, so this marker lands even when the
 * app exits the same tick. Read it at onload start to decide whether the
 * previous instance's onunload actually ran.
 */
const UNLOAD_FLAG_KEY = 'UNagent-unload-mark'

export function markUnload(): void {
  try {
    globalThis.localStorage.setItem(UNLOAD_FLAG_KEY, new Date().toISOString())
  } catch {
    // localStorage unavailable — best-effort diagnostic only.
  }
}

/** Timestamp of the last clean onunload ('' when never/unknown). */
export function lastUnloadMark(): string {
  try {
    return globalThis.localStorage.getItem(UNLOAD_FLAG_KEY) ?? ''
  } catch {
    return ''
  }
}
