// chunker: heading-anchored chunking + djb2 hashing + hard long-split.
// Pure functions — sections are fabricated with real offsets.

import { chunkNote, djb2Hash, splitLong, MAX_CHUNK_CHARS } from '../chunker'

/** Build sections from literal content using indexOf (no hand math). */
function secs(
  content: string,
  parts: Array<{ type: string; text: string }>,
): Array<{ type: string; start: number; end: number }> {
  const out: Array<{ type: string; start: number; end: number }> = []
  let cursor = 0
  for (const p of parts) {
    const start = content.indexOf(p.text, cursor)
    expect(start).toBeGreaterThanOrEqual(cursor)
    out.push({ type: p.type, start, end: start + p.text.length })
    cursor = start + p.text.length
  }
  return out
}

describe('djb2Hash', () => {
  it('is deterministic and order-sensitive', () => {
    expect(djb2Hash('hello')).toBe(djb2Hash('hello'))
    expect(djb2Hash('hello')).not.toBe(djb2Hash('Hello'))
    expect(djb2Hash('ab')).not.toBe(djb2Hash('ba'))
  })

  it('returns a 32-bit int', () => {
    const h = djb2Hash('中文内容也可以'.repeat(50))
    expect(Number.isInteger(h)).toBe(true)
  })
})

describe('splitLong', () => {
  it('hard-splits into MAX_CHUNK_CHARS slices', () => {
    const text = 'x'.repeat(MAX_CHUNK_CHARS * 2 + 100)
    const parts = splitLong(text)
    expect(parts).toHaveLength(3)
    expect(parts[0]).toHaveLength(MAX_CHUNK_CHARS)
    expect(parts[1]).toHaveLength(MAX_CHUNK_CHARS)
    expect(parts[2]).toHaveLength(100)
  })

  it('drops whitespace-only slices', () => {
    const parts = splitLong('a'.repeat(10), 10)
    expect(parts).toEqual(['a'.repeat(10)])
    expect(splitLong(' '.repeat(30), 10)).toEqual([])
  })
})

describe('chunkNote', () => {
  it('gives preamble chunks heading=null and splits at headings', () => {
    const content = 'intro line\n## Alpha\nalpha body\n## Beta\nbeta body'
    const sections = secs(content, [
      { type: 'paragraph', text: 'intro line' },
      { type: 'heading', text: '## Alpha' },
      { type: 'paragraph', text: 'alpha body' },
      { type: 'heading', text: '## Beta' },
      { type: 'paragraph', text: 'beta body' },
    ])
    const chunks = chunkNote('N.md', content, sections)
    expect(chunks.map((c) => c.heading)).toEqual([null, 'Alpha', 'Beta'])
    // Every chunk text carries the context header (path › heading).
    expect(chunks[0].text).toBe('N.md\nintro line')
    expect(chunks[1].text).toBe('N.md › Alpha\nalpha body')
    expect(chunks.every((c) => c.path === 'N.md')).toBe(true)
    expect(chunks.every((c) => c.hash === djb2Hash(c.text))).toBe(true)
  })

  it('accumulates multiple paragraphs under one heading into one chunk', () => {
    const content = '## A\nfirst\nsecond'
    const sections = secs(content, [
      { type: 'heading', text: '## A' },
      { type: 'paragraph', text: 'first' },
      { type: 'paragraph', text: 'second' },
    ])
    const chunks = chunkNote('N.md', content, sections)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe('N.md › A\nfirst\nsecond')
  })

  it('hard-splits oversized heading sections (body capped, context extra)', () => {
    const big = 'z'.repeat(MAX_CHUNK_CHARS + 500)
    const content = `## Big\n${big}`
    const sections = secs(content, [
      { type: 'heading', text: '## Big' },
      { type: 'paragraph', text: big },
    ])
    const chunks = chunkNote('N.md', content, sections)
    expect(chunks.length).toBe(3)
    expect(chunks.every((c) => c.heading === 'Big')).toBe(true)
    expect(chunks.every((c) => c.text.startsWith('N.md › Big\n'))).toBe(true)
    // The BODY of each chunk stays under the cap (context line excluded).
    const bodies = chunks.map((c) => c.text.slice('N.md › Big\n'.length))
    expect(bodies.every((b) => b.length <= MAX_CHUNK_CHARS)).toBe(true)
  })

  it('drops whitespace-only chunks and handles empty input', () => {
    const content = '## Only'
    const sections = secs(content, [{ type: 'heading', text: '## Only' }])
    expect(chunkNote('N.md', content, sections)).toEqual([])
    expect(chunkNote('N.md', '', [])).toEqual([])
  })
})
