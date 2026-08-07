// Folder exclusions shared by the @-mention picker and the search_notes
// tool. The effective list = Obsidian's own "Files & Links → Excluded files"
// (vault config `userIgnoreFilters`, always honored — that's the "same as
// Obsidian" default) PLUS the plugin's custom list from settings.

import type { App } from 'obsidian'

// vault.getConfig exists at runtime but is missing from some d.ts builds
// (same treatment as metadataCache.getTags — see HANDOFF pitfall ⑦).
interface VaultWithConfig {
  getConfig?: (key: string) => unknown
}

/** Read Obsidian's vault-level "Excluded files" list (may be absent). */
export function getObsidianExcludedFolders(app: App): string[] {
  const cfg = (app.vault as unknown as VaultWithConfig).getConfig?.(
    'userIgnoreFilters',
  )
  return Array.isArray(cfg)
    ? cfg.filter((x): x is string => typeof x === 'string')
    : []
}

/** Normalize a folder path: trim + strip leading/trailing slashes. */
export function normalizeFolder(raw: string): string {
  return raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Effective exclusion folders: Obsidian's list merged with the plugin's
 * custom list (and any extra callers contribute, e.g. the auto-hidden AI
 * data folder), normalized, de-duplicated, empties dropped.
 */
export function effectiveExclusions(
  app: App,
  custom: string[] = [],
  extra: string[] = [],
): string[] {
  const merged = [...getObsidianExcludedFolders(app), ...custom, ...extra]
  return Array.from(
    new Set(merged.map(normalizeFolder).filter((x) => x !== '')),
  )
}

/**
 * The AI data folder as an exclusion contribution: `[folder]` when the
 * "hide AI folder" toggle is on (and the folder is non-empty), else `[]`.
 */
export function aiFolderExclusion(
  hideAiFolder: boolean,
  aiFolder: string,
): string[] {
  const folder = normalizeFolder(aiFolder)
  return hideAiFolder && folder ? [folder] : []
}

/**
 * True when `path` (a file path OR folder path) is inside any exclusion
 * folder — exact match or proper prefix. A leading '/' on the path is
 * tolerated. An empty exclusion list always returns false (hot path).
 */
export function isExcludedPath(path: string, exclusions: string[]): boolean {
  if (exclusions.length === 0) return false
  const p = path.replace(/^\/+/, '')
  return exclusions.some((f) => p === f || p.startsWith(f + '/'))
}
