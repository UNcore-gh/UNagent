// Adapter-level vault I/O for the plugin's OWN data files (memory note,
// conversation history, user skills, attachments under the AI data folder).
//
// Why not the usual vault APIs? Obsidian does not index dot-prefixed folders
// (users may point the AI data folder at one, and legacy installs used
// `.obsidian-ai/`): `vault.getFiles()`, `vault.getMarkdownFiles()` and
// `vault.getAbstractFileByPath()` never see anything in there, and
// `vault.createFolder()` throws "Folder already exists" for a
// real-but-unindexed folder — which silently broke conversation history,
// memory and user-skill discovery. The raw adapter (`app.vault.adapter`)
// operates on paths directly and works the same for indexed and unindexed
// locations, so every plugin-internal store goes through it. All pure plugin
// JS — mobile-safe (no fs, no local processes).

import { App, normalizePath } from 'obsidian'

function norm(path: string): string {
  return normalizePath(path)
}

/** True when a file OR folder exists at the path. */
export async function pathExists(app: App, path: string): Promise<boolean> {
  const p = norm(path)
  if (!p) return false
  return app.vault.adapter.exists(p)
}

/** Read a text file; null when missing or unreadable (never throws). */
export async function readText(app: App, path: string): Promise<string | null> {
  const p = norm(path)
  try {
    if (!(await app.vault.adapter.exists(p))) return null
    return await app.vault.adapter.read(p)
  } catch {
    return null
  }
}

/** Create the folder (and all parents) unless it already exists. */
export async function ensureDir(app: App, dir: string): Promise<void> {
  const d = norm(dir)
  if (!d || d === '/') return
  if (await app.vault.adapter.exists(d)) return
  try {
    await app.vault.adapter.mkdir(d) // recursive: creates missing parents too
  } catch {
    // Race or platform quirk: the folder appeared between exists() and
    // mkdir() (iCloud sync, another writer). Non-fatal — the writeText call
    // that follows surfaces any REAL permission failure. Swallowing here
    // keeps a transient sync race from becoming an unhandled rejection up
    // the call chain (mobile repeated-reload bug), while genuinely bad
    // writes still fail loudly for the caller's own catch.
  }
}

/** Write text, creating the parent folder chain first. */
export async function writeText(
  app: App,
  path: string,
  data: string,
): Promise<void> {
  const p = norm(path)
  const slash = p.lastIndexOf('/')
  if (slash > 0) await ensureDir(app, p.slice(0, slash))
  await app.vault.adapter.write(p, data)
}

/** Write binary bytes, creating the parent folder chain first. */
export async function writeBinary(
  app: App,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const p = norm(path)
  const slash = p.lastIndexOf('/')
  if (slash > 0) await ensureDir(app, p.slice(0, slash))
  await app.vault.adapter.writeBinary(p, data)
}

/** Read a binary file as ArrayBuffer; null when missing or unreadable. */
export async function readBinary(
  app: App,
  path: string,
): Promise<ArrayBuffer | null> {
  const p = norm(path)
  try {
    if (!(await app.vault.adapter.exists(p))) return null
    return await app.vault.adapter.readBinary(p)
  } catch {
    return null
  }
}

/** Delete a file if present (idempotent; folders are never removed here). */
export async function removePath(app: App, path: string): Promise<void> {
  const p = norm(path)
  if (!(await app.vault.adapter.exists(p))) return
  try {
    await app.vault.adapter.remove(p)
  } catch {
    // Missing by the time we removed (concurrent delete) — fine.
  }
}

/** Direct children of a folder; empty lists when the folder is absent. */
export async function listDir(
  app: App,
  folder: string,
): Promise<{ files: string[]; folders: string[] }> {
  const d = norm(folder)
  const empty = { files: [], folders: [] }
  if (!d) return empty
  try {
    if (!(await app.vault.adapter.exists(d))) return empty
    const listed = await app.vault.adapter.list(d)
    return {
      files: listed.files.map(norm),
      folders: listed.folders.map(norm),
    }
  } catch {
    return empty
  }
}

/** Every file under a folder, recursively (depth-first; missing → []). */
export async function listAllFiles(app: App, folder: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const { files, folders } = await listDir(app, dir)
    out.push(...files)
    for (const sub of folders) await walk(sub)
  }
  await walk(folder)
  return out
}

/**
 * Recursively remove a folder tree ONLY where it holds no files any more
 * (empty subfolders collapse bottom-up, then the folder itself). Used to
 * sweep the husk of a migrated data folder. A folder that still contains
 * any file is left completely alone. Idempotent.
 */
export async function removeEmptyDirs(app: App, dir: string): Promise<void> {
  const d = norm(dir)
  if (!d || d === '/') return
  if (!(await app.vault.adapter.exists(d))) return
  const { files } = await listDir(app, d)
  if (files.length > 0) return // still holds data — never touch it
  const { folders } = await listDir(app, d)
  for (const sub of folders) await removeEmptyDirs(app, sub)
  const after = await listDir(app, d)
  if (after.files.length > 0 || after.folders.length > 0) return
  try {
    // Already verified empty above — recursive flag stays false (belt and
    // braces: a recursive rmdir would swallow data on a race).
    await app.vault.adapter.rmdir(d, false)
  } catch {
    // Concurrent change or platform quirk — an empty leftover folder is
    // harmless; leave it.
  }
}
