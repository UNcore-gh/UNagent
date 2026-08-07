// Attachment helpers: link-format rules (embed vs link), extension/name
// sanitizing, collision-safe naming, and the paste/upload → vault save
// round trip (adapter.writeBinary + folder resolution shared with generated
// images). The fake vault exposes only adapter-level I/O plus getConfig, so
// saving under a dot-prefixed folder works the same as anywhere else.

import { App } from 'obsidian'
import {
  extFromMime,
  extFromName,
  isEmbeddableExt,
  isImageExt,
  linkForPath,
  pasteStamp,
  sanitizeBaseName,
  saveAttachment,
  stripExt,
  uniqueAttachmentName,
} from '../attachments'

describe('link formats', () => {
  it('embeds images inline (case-insensitive extension)', () => {
    expect(linkForPath('assets/photo.png')).toBe('![[assets/photo.png]]')
    expect(linkForPath('x.JPG')).toBe('![[x.JPG]]')
    expect(linkForPath('anim.webp')).toBe('![[anim.webp]]')
  })

  it('embeds pdf too (Obsidian renders a preview)', () => {
    expect(linkForPath('a/b.pdf')).toBe('![[a/b.pdf]]')
  })

  it('links markdown and everything else plainly', () => {
    expect(linkForPath('Note.md')).toBe('[[Note.md]]')
    expect(linkForPath('data.csv')).toBe('[[data.csv]]')
    expect(linkForPath('README')).toBe('[[README]]')
  })

  it('embeds audio, video and canvas too', () => {
    expect(linkForPath('a/music.mp3')).toBe('![[a/music.mp3]]')
    expect(linkForPath('clip.mp4')).toBe('![[clip.mp4]]')
    expect(linkForPath('board.canvas')).toBe('![[board.canvas]]')
    expect(isEmbeddableExt('canvas')).toBe(true)
    expect(isEmbeddableExt('mp4')).toBe(true)
    expect(isEmbeddableExt('flac')).toBe(true)
  })

  it('classifies extensions', () => {
    expect(isImageExt('png')).toBe(true)
    expect(isImageExt('PNG')).toBe(true)
    expect(isImageExt('pdf')).toBe(false)
    expect(isEmbeddableExt('pdf')).toBe(true)
    expect(isEmbeddableExt('md')).toBe(false)
  })
})

describe('extension / name helpers', () => {
  it('maps known mime types; unknown → empty', () => {
    expect(extFromMime('image/png')).toBe('png')
    expect(extFromMime('IMAGE/JPEG')).toBe('jpg')
    expect(extFromMime('application/pdf')).toBe('pdf')
    expect(extFromMime('application/octet-stream')).toBe('')
  })

  it('reads + sanitizes the extension from a file name', () => {
    expect(extFromName('photo.PNG')).toBe('png')
    expect(extFromName('archive.tar.gz')).toBe('gz')
    expect(extFromName('noext')).toBe('')
    expect(extFromName('.hidden')).toBe('')
    expect(extFromName('bad.p@n!g')).toBe('png')
  })

  it('strips only the final extension', () => {
    expect(stripExt('a.b.txt')).toBe('a.b')
    expect(stripExt('name')).toBe('name')
  })

  it('sanitizes base names against wiki-link breakers', () => {
    expect(sanitizeBaseName('a/b:c*d?')).toBe('a-b-c-d')
    expect(sanitizeBaseName('  my  photo ')).toBe('my-photo')
    expect(sanitizeBaseName('[[#^|]]')).toBe('')
  })

  it('stamps dates compactly with zero padding', () => {
    expect(pasteStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })
})

describe('uniqueAttachmentName', () => {
  it('returns the plain name when free', async () => {
    expect(
      await uniqueAttachmentName('assets', 'img', 'png', async () => false),
    ).toBe('assets/img.png')
  })

  it('walks -1, -2, … on collisions', async () => {
    const taken = new Set(['assets/img.png', 'assets/img-1.png'])
    expect(
      await uniqueAttachmentName('assets', 'img', 'png', async (p) =>
        taken.has(p),
      ),
    ).toBe('assets/img-2.png')
  })

  it('works at the vault root (empty folder)', async () => {
    expect(await uniqueAttachmentName('', 'x', 'txt', async () => false)).toBe(
      'x.txt',
    )
  })

  it('gives up gracefully after 100 collisions', async () => {
    expect(await uniqueAttachmentName('a', 'x', 'txt', async () => true)).toBe(
      'a/x-101.txt',
    )
  })
})

function mkVaultApp(
  opts: { existing?: string[]; attachmentConfig?: string } = {},
): { app: App; created: Map<string, ArrayBuffer> } {
  const created = new Map<string, ArrayBuffer>()
  const existing = new Set(opts.existing ?? [])
  const app = {
    vault: {
      getConfig: (key: string) =>
        key === 'attachmentFolderPath' ? opts.attachmentConfig : undefined,
      adapter: {
        exists: async (p: string) => existing.has(p) || created.has(p),
        read: async (p: string) => {
          throw new Error(`missing: ${p}`)
        },
        write: async (_p: string, _data: string) => undefined,
        writeBinary: async (p: string, data: ArrayBuffer) => {
          created.set(p, data)
        },
        mkdir: async (_p: string) => undefined,
        remove: async (p: string) => {
          created.delete(p)
          existing.delete(p)
        },
        list: async (_p: string) => ({ files: [], folders: [] }),
      },
    },
  } as unknown as App
  return { app, created }
}

const bytes = new TextEncoder().encode('data').buffer as ArrayBuffer

describe('saveAttachment', () => {
  it('honors the explicit configured folder and embeds images', async () => {
    const { app, created } = mkVaultApp()
    const r = await saveAttachment(app, bytes, 'photo.png', 'image/png', 'assets')
    expect(r.path).toBe('assets/photo.png')
    expect(r.insert).toBe('![[assets/photo.png]]')
    expect(created.has('assets/photo.png')).toBe(true)
  })

  it('falls back to the vault attachment folder ("./pics" → pics)', async () => {
    const { app } = mkVaultApp({ attachmentConfig: './pics' })
    const r = await saveAttachment(app, bytes, 'a.png', '', '')
    expect(r.path).toBe('pics/a.png')
  })

  it('saves at the vault root when nothing is configured', async () => {
    const { app } = mkVaultApp({ attachmentConfig: '/' })
    const r = await saveAttachment(app, bytes, 'a.png', '', '')
    expect(r.path).toBe('a.png')
  })

  it('sanitizes messy names and dedupes collisions', async () => {
    const { app } = mkVaultApp({ existing: ['assets/my-photo.png'] })
    const r = await saveAttachment(app, bytes, 'my:photo?.png', 'image/png', 'assets')
    expect(r.path).toBe('assets/my-photo-1.png')
  })

  it('uses a stamped pasted- name when the source has none (clipboard)', async () => {
    const { app } = mkVaultApp()
    const r = await saveAttachment(app, bytes, '', 'image/jpeg', '')
    expect(r.path).toMatch(/^pasted-\d{8}-\d{6}\.jpg$/)
    expect(r.insert).toBe(`![[${r.path}]]`)
  })

  it('derives the extension from the mime when the name lacks one', async () => {
    const { app } = mkVaultApp()
    const r = await saveAttachment(app, bytes, 'blob', 'image/webp', '')
    expect(r.path).toBe('blob.webp')
  })

  it('falls back to .bin for totally unknown types', async () => {
    const { app } = mkVaultApp()
    const r = await saveAttachment(app, bytes, '', 'application/x-weird', '')
    expect(r.path).toMatch(/\.bin$/)
    expect(r.insert.startsWith('[[')).toBe(true)
  })

  it('links non-embeddable uploads plainly', async () => {
    const { app } = mkVaultApp()
    const r = await saveAttachment(app, bytes, 'data.csv', 'text/csv', '')
    expect(r.insert).toBe('[[data.csv]]')
  })

  it('saves under a dot-prefixed folder the indexed vault APIs cannot see', async () => {
    // Regression: adapter-level write + dedupe work for unindexed folders
    // (e.g. .obsidian-ai/attachments) exactly like visible ones.
    const { app, created } = mkVaultApp()
    const first = await saveAttachment(app, bytes, 'a.png', 'image/png', '.obsidian-ai/attachments')
    expect(first.path).toBe('.obsidian-ai/attachments/a.png')
    expect(first.insert).toBe('![[.obsidian-ai/attachments/a.png]]')
    expect(created.has(first.path)).toBe(true)
    const second = await saveAttachment(app, bytes, 'a.png', 'image/png', '.obsidian-ai/attachments')
    expect(second.path).toBe('.obsidian-ai/attachments/a-1.png')
  })
})

/* ── extractImageEmbedPaths / hasImageEmbeds ──────────────────── */

import {
  extractImageEmbedPaths,
  hasImageEmbeds,
  arrayBufferToBase64,
} from '../attachments'

describe('extractImageEmbedPaths', () => {
  it('extracts image embed paths from wiki-link syntax', () => {
    const text = 'Look at ![[photo.png]] and ![[assets/diagram.jpg]]'
    expect(extractImageEmbedPaths(text)).toEqual(['photo.png', 'assets/diagram.jpg'])
  })

  it('filters out non-image embeds', () => {
    const text = '![[note.md]] ![[photo.png]] ![[data.csv]] ![[pic.jpeg]]'
    expect(extractImageEmbedPaths(text)).toEqual(['photo.png', 'pic.jpeg'])
  })

  it('handles case-insensitive extensions', () => {
    const text = '![[PHOTO.PNG]] and ![[Pic.JPEG]] and ![[anim.WEBP]]'
    expect(extractImageEmbedPaths(text)).toEqual(['PHOTO.PNG', 'Pic.JPEG', 'anim.WEBP'])
  })

  it('returns empty array when no image embeds', () => {
    expect(extractImageEmbedPaths('just text')).toEqual([])
    expect(extractImageEmbedPaths('![[note.md]]')).toEqual([])
    expect(extractImageEmbedPaths('')).toEqual([])
  })
})

describe('hasImageEmbeds', () => {
  it('returns true when image embeds exist', () => {
    expect(hasImageEmbeds('![[photo.png]]')).toBe(true)
    expect(hasImageEmbeds('text ![[a.jpg]] more')).toBe(true)
  })

  it('returns false when no image embeds', () => {
    expect(hasImageEmbeds('just text')).toBe(false)
    expect(hasImageEmbeds('![[note.md]]')).toBe(false)
    expect(hasImageEmbeds('')).toBe(false)
  })
})

describe('arrayBufferToBase64', () => {
  it('encodes a small buffer correctly', () => {
    const data = new TextEncoder().encode('Hello')
    const result = arrayBufferToBase64(data.buffer as ArrayBuffer)
    // "Hello" in base64 is "SGVsbG8="
    expect(result).toBe('SGVsbG8=')
  })

  it('encodes empty buffer as empty string', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('')
  })

  it('handles large buffers without stack overflow', () => {
    // Create a 100KB buffer — exercises the chunked encoding path
    const large = new Uint8Array(100_000)
    for (let i = 0; i < large.length; i++) large[i] = i % 256
    const result = arrayBufferToBase64(large.buffer as ArrayBuffer)
    // Should be a valid base64 string (length divisible by 4)
    expect(result.length % 4).toBe(0)
    // Decode to verify round-trip
    const decoded = Buffer.from(result, 'base64')
    expect(decoded.length).toBe(100_000)
    expect(decoded[0]).toBe(0)
    expect(decoded[255]).toBe(255)
    expect(decoded[256]).toBe(0)
  })
})
