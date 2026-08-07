// Attachments pasted or uploaded from the composer: save the bytes into the
// vault (same folder rules as generated images) and produce the wiki-link /
// embed text to insert. Pure plugin JS + adapter.writeBinary — mobile-safe.
//
// Insertion convention: embeddable types (images, pdf) become `![[path]]`
// embeds so they render inline in the chat note reference; everything else
// becomes a plain `[[path]]` link. Full paths are used — never ambiguous,
// no basename-collision bookkeeping at insertion time.

import { App, normalizePath } from 'obsidian'
import { resolveAttachmentFolder } from '../core/image/saveImage'
import { pathExists, readBinary, writeBinary } from './vaultIO'

/** Extensions Obsidian renders as inline image embeds. */
export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
] as const

/** Audio Obsidian renders as an inline player. */
export const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'flac',
  'aac',
  'opus',
  'aiff',
  'wma',
] as const

/** Video Obsidian renders as an inline player. */
export const VIDEO_EXTENSIONS = [
  'mp4',
  'webm',
  'ogv',
  'mov',
  'm4v',
  'mkv',
  'm3u8',
] as const

/** Obsidian Canvas — an interactive `![[…]]` embed. */
export const CANVAS_EXTENSIONS = ['canvas'] as const

/** Everything worth embedding inline (`![[…]]`): images, pdf, audio, video,
 *  canvas (用户指示: 引用里也要有 canvas 这类更多文件类型). */
export const EMBED_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  'pdf',
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...CANVAS_EXTENSIONS,
] as const

export function isImageExt(ext: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

export function isAudioExt(ext: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

export function isVideoExt(ext: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

export function isCanvasExt(ext: string): boolean {
  return (CANVAS_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** Types inserted as `![[…]]` embeds rather than plain links. */
export function isEmbeddableExt(ext: string): boolean {
  return (EMBED_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** Wiki link for a vault path: embed renderable types, link the rest. */
export function linkForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1) : ''
  return isEmbeddableExt(ext) ? `![[${path}]]` : `[[${path}]]`
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'application/json': 'json',
}

/** Best-effort extension from a MIME type ('' when unknown). */
export function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase().trim()] ?? ''
}

/** Extension from a file name, lowercased and alnum-only ('' when none). */
export function extFromName(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
}

/** File name minus its final extension. */
export function stripExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

/**
 * A paste/upload-safe base name: drop path separators and characters that
 * break wiki links, collapse whitespace. Returns '' when nothing survives —
 * callers then fall back to a timestamp name.
 */
export function sanitizeBaseName(raw: string): string {
  return raw
    .replace(/[[\]#^|\\/:*?"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** `YYYYMMDD-HHmmss` from a Date, for readable pasted-file names. */
export function pasteStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * First free path for `${folder}/${base}.${ext}`, appending -1/-2/… on
 * collision (capped; the cap is unreachable in practice). `exists` is
 * injected (async — it hits the adapter) so the naming stays testable.
 */
export async function uniqueAttachmentName(
  folder: string,
  base: string,
  ext: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const prefix = folder ? `${folder}/` : ''
  const first = `${prefix}${base}.${ext}`
  if (!(await exists(first))) return first
  for (let i = 1; i <= 100; i++) {
    const p = `${prefix}${base}-${i}.${ext}`
    if (!(await exists(p))) return p
  }
  return `${prefix}${base}-101.${ext}`
}

export interface SavedAttachment {
  /** Vault-relative path of the stored file. */
  path: string
  /** Wiki link / embed text ready to insert into the composer. */
  insert: string
}

/**
 * Save pasted or uploaded bytes into the vault and return the path plus the
 * text to insert. Folder = explicit image setting, else Obsidian's attachment
 * folder (same resolution as generated images). Name = sanitized original
 * name, or `pasted-<stamp>` when the source has none (clipboard images),
 * deduped against existing files.
 */
export async function saveAttachment(
  app: App,
  bytes: ArrayBuffer,
  fileName: string,
  mime: string,
  configuredFolder: string,
): Promise<SavedAttachment> {
  const folder = resolveAttachmentFolder(app, configuredFolder)
  const ext = extFromName(fileName) || extFromMime(mime) || 'bin'
  const base = sanitizeBaseName(stripExt(fileName)) || `pasted-${pasteStamp(new Date())}`

  const path = normalizePath(
    await uniqueAttachmentName(folder, base, ext, (p) => pathExists(app, p)),
  )
  await writeBinary(app, path, bytes)
  return { path, insert: linkForPath(path) }
}

/** Reverse of MIME_EXT: extension → MIME type (for reading images back). */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

/** Chunked ArrayBuffer → base64 (avoids call-stack overflow on large images
 *  that a spread `String.fromCharCode(...new Uint8Array(buf))` would hit). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(binary)
}

/** Read a vault image file as a `data:` URL ready for an `image_url` wire part.
 *  Returns null when the file is missing, unreadable, not an image ext, or
 *  (when `maxBytes` is given) larger than the cap.
 *  Pure plugin JS (adapter.readBinary + btoa) — mobile-safe. */
export async function readImageAsDataUrl(
  app: App,
  path: string,
  maxBytes?: number,
): Promise<string | null> {
  const ext = extFromName(path)
  if (!ext || !isImageExt(ext)) return null
  const mime = EXT_MIME[ext] ?? 'image/png'
  const buf = await readBinary(app, normalizePath(path))
  if (!buf) return null
  // Mobile memory guard: oversized images are dropped BEFORE base64 (which
  // inflates ~1.33×) — a huge phone photo can otherwise spike webview
  // memory mid-request and get the whole app process killed.
  if (maxBytes && buf.byteLength > maxBytes) return null
  return `data:${mime};base64,${arrayBufferToBase64(buf)}`
}

/** Regex for `![[path]]` embeds (Obsidian wiki-link embed syntax). Captures
 *  the inner path. Global — use with matchAll. */
const EMBED_RE = /!\[\[([^\]]+)\]\]/g

/** Extract vault paths from all `![[…]]` embeds in `text` whose extension is
 *  an image. Pure — testable without an App. */
export function extractImageEmbedPaths(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(EMBED_RE)) {
    const raw = m[1].trim()
    // Obsidian embeds may carry a `|alias` or `#heading` suffix — strip it.
    const path = raw.split(/[|#]/)[0].trim()
    if (!path) continue
    const ext = extFromName(path)
    if (ext && isImageExt(ext)) out.push(path)
  }
  return out
}

/** True when `text` contains at least one `![[…]]` image embed. */
export function hasImageEmbeds(text: string): boolean {
  return extractImageEmbedPaths(text).length > 0
}
