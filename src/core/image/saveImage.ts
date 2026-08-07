// Save generated image bytes into the vault under the plugin's data folder
// (default 'AI 助手/images/'). Uses adapter.writeBinary — pure plugin JS,
// mobile-safe, and works for dot-prefixed folders too.

import { App, normalizePath } from 'obsidian'
import { DEFAULT_AI_FOLDER } from '../../utils/memoryStore'
import { writeBinary } from '../../utils/vaultIO'

// vault.getConfig exists at runtime but is not declared in every obsidian.d.ts.
interface VaultWithConfig {
  getConfig(key: 'attachmentFolderPath'): string | undefined
}

/**
 * Resolve the target folder from an explicit setting or the vault config.
 * Exported so pasted/uploaded attachments (utils/attachments) share the exact
 * same folder rules.
 */
export function resolveAttachmentFolder(app: App, configured: string): string {
  const explicit = configured.trim()
  if (explicit) return normalizePath(explicit.replace(/^\/+|\/+$/g, ''))

  const cfg =
    (app.vault as unknown as VaultWithConfig).getConfig('attachmentFolderPath') ??
    '/'
  const cleaned = cfg.replace(/^\.?\/*/, '').replace(/\/+$/g, '')
  return normalizePath(cleaned)
}

/** The stored image: vault-relative path + file name (for wiki embeds). */
export interface SavedImage {
  path: string
  name: string
}

/**
 * Save a generated image into the plugin's data folder under `images/`.
 * The folder path resolves from the plugin's aiFolder setting.
 */
export async function saveGeneratedImage(
  app: App,
  bytes: ArrayBuffer,
  ext: string,
  aiFolder: string,
): Promise<SavedImage> {
  const base = (aiFolder || DEFAULT_AI_FOLDER).trim().replace(/^\/+|\/+$/g, '')
  const folder = normalizePath(`${base}/images`)

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  const name = `AI-image-${stamp}.${ext}`
  const path = normalizePath(`${folder}/${name}`)

  await writeBinary(app, path, bytes)
  return { path, name }
}
