// Pure markdown/frontmatter helpers used by the note tools. These back
// edit_note (replace_section) and the frontmatter tools, so their edge cases
// matter even though the tools themselves need a live vault to exercise.

import {
  asString,
  asStringArray,
  collectTags,
  findOccurrences,
  findSimilarPassage,
  normalizeForComparison,
  parentFolderOf,
  replaceSection,
  splitFrontmatter,
  strReplace,
} from '../util'

describe('splitFrontmatter', () => {
  it('splits a leading YAML block from the body', () => {
    const src = '---\ntitle: T\ntags: [a]\n---\n# Hi\nbody'
    const { frontmatter, body } = splitFrontmatter(src)
    expect(frontmatter).toBe('---\ntitle: T\ntags: [a]\n---\n')
    expect(body).toBe('# Hi\nbody')
  })

  it('returns empty frontmatter when there is none', () => {
    expect(splitFrontmatter('# Hi')).toEqual({ frontmatter: '', body: '# Hi' })
  })

  it('only treats --- as frontmatter at the very start', () => {
    expect(splitFrontmatter('\n---\nx\n---\nbody').frontmatter).toBe('')
  })
})

describe('replaceSection', () => {
  const doc = 'intro\n## A\nold a\n### A1\nsub\n## B\nold b'

  it('replaces a section up to the next same-or-higher heading', () => {
    // '### A1' is deeper, so it's swallowed by section A; '## B' terminates.
    expect(replaceSection(doc, 'A', 'new a')).toBe(
      'intro\n## A\nnew a\n\n## B\nold b',
    )
  })

  it('replaces the final section through end of file', () => {
    expect(replaceSection(doc, 'B', 'new b')).toBe(
      'intro\n## A\nold a\n### A1\nsub\n## B\nnew b\n',
    )
  })

  it('matches heading titles case-insensitively', () => {
    expect(replaceSection(doc, 'b', 'X')).toContain('## B\nX')
  })

  it('returns null when the heading is not found', () => {
    expect(replaceSection(doc, 'Z', 'x')).toBeNull()
  })
})

describe('path / value helpers', () => {
  it('parentFolderOf', () => {
    expect(parentFolderOf('a/b/c.md')).toBe('a/b')
    expect(parentFolderOf('note.md')).toBe('')
  })

  it('asString', () => {
    expect(asString('x')).toBe('x')
    expect(asString(42, 'fb')).toBe('fb')
  })

  it('asStringArray', () => {
    expect(asStringArray(['a', 1, 'b'])).toEqual(['a', 'b'])
    expect(asStringArray('solo')).toEqual(['solo'])
    expect(asStringArray(undefined)).toEqual([])
  })
})

describe('collectTags', () => {
  it('merges frontmatter + inline tags, strips #, de-dupes', () => {
    const cache = {
      frontmatter: { tags: '#one, two' },
      tags: [{ tag: '#three' }, { tag: '#one' }],
    } as never
    expect(collectTags(cache).sort()).toEqual(['one', 'three', 'two'])
  })

  it('handles null cache', () => {
    expect(collectTags(null)).toEqual([])
  })
})

describe('findOccurrences', () => {
  it('finds every occurrence with start offsets', () => {
    expect(findOccurrences('ababab', 'ab')).toEqual([0, 2, 4])
  })

  it('is non-overlapping: skips past each matched span', () => {
    // 'aaa' holds two overlapping 'aa' spans (0 and 1), but non-overlap
    // scanning resumes after the match, so only offset 0 is reported.
    expect(findOccurrences('aaa', 'aa')).toEqual([0])
    expect(findOccurrences('aaaa', 'aa')).toEqual([0, 2])
  })

  it('returns [] for empty needle or no match', () => {
    expect(findOccurrences('abc', '')).toEqual([])
    expect(findOccurrences('abc', 'z')).toEqual([])
  })
})

describe('strReplace', () => {
  it('replaces a unique occurrence', () => {
    const src = '# T\nhello world\ntail'
    expect(strReplace(src, 'hello world', 'bye')).toEqual({
      next: '# T\nbye\ntail',
    })
  })

  it('returns not_found when oldText is absent or empty', () => {
    expect(strReplace('abc', 'xyz', 'N')).toEqual({ error: 'not_found' })
    // Documented choice: empty oldText has no anchor, so it's treated as
    // not_found rather than a distinct error variant.
    expect(strReplace('abc', '', 'N')).toEqual({ error: 'not_found' })
  })

  it('not_found carries a fuzzy suggestion for a whitespace near-miss', () => {
    // The single most common str_replace failure: stray whitespace. The
    // suggestion must be VERBATIM content (so it's copy-ready as old_text).
    const src = '# T\n今天 天气不错\nend'
    const res = strReplace(src, '今天天气不错', 'X')
    expect('next' in res).toBe(false)
    if ('error' in res && res.error === 'not_found') {
      expect(res.suggestion).toBeDefined()
      expect(res.suggestion?.startLine).toBe(2)
      expect(res.suggestion?.endLine).toBe(2)
      expect(res.suggestion?.text).toBe('今天 天气不错')
      expect(res.suggestion?.similarity).toBeGreaterThan(0.5)
    } else {
      throw new Error('expected not_found')
    }
  })

  it('not_found without any plausible candidate keeps the bare shape', () => {
    expect(strReplace('# Post\nhello', 'absent text', 'N')).toEqual({
      error: 'not_found',
    })
  })

  it('returns ambiguous with count and first 3 candidates on duplicates', () => {
    // Long padded lines keep each hit's ±40 context window within its line.
    const mk = (n: string) => `${'q'.repeat(40)} ${n} foo ${n} ${'q'.repeat(40)}`
    const src = ['one', 'two', 'three', 'four'].map(mk).join('\n')
    const res = strReplace(src, 'foo', 'bar')
    expect('next' in res).toBe(false)
    if ('error' in res && res.error === 'ambiguous') {
      expect(res.count).toBe(4)
      expect(res.candidates).toHaveLength(3)
      expect(res.candidates.map((c) => c.line)).toEqual([1, 2, 3])
      expect(res.candidates[0].context).toContain('one foo one')
      expect(res.candidates[1].context).toContain('two foo two')
      expect(res.candidates[2].context).toContain('three foo three')
    }
  })

  it('candidate line numbers are 1-based and context collapses newlines', () => {
    const src = 'alpha\nbeta GAMMA delta\nepsilon'
    const res = strReplace(src, 'GAMMA', 'X')
    if ('error' in res && res.error === 'ambiguous') {
      throw new Error('unexpected ambiguous')
    }
    // Single match on line 2.
    expect(res).toEqual({ next: 'alpha\nbeta X delta\nepsilon' })

    const dup = 'GAMMA\nrest\n\nGAMMA'
    const res2 = strReplace(dup, 'GAMMA', 'X')
    if ('error' in res2 && res2.error === 'ambiguous') {
      expect(res2.candidates.map((c) => c.line)).toEqual([1, 4])
      // Context around the 2nd hit spans the blank line -> spaces collapsed.
      expect(res2.candidates[1].context).toBe('GAMMA rest GAMMA')
    } else {
      throw new Error('expected ambiguous')
    }
  })

  it('truncates overlong context', () => {
    const pad = 'x'.repeat(60)
    const src = `${pad}NEEDLE${pad} and ${pad}NEEDLE${pad}`
    const res = strReplace(src, 'NEEDLE', 'N')
    if ('error' in res && res.error === 'ambiguous') {
      for (const c of res.candidates) {
        expect(c.context.length).toBeLessThanOrEqual(80)
        expect(c.context).toContain('NEEDLE')
      }
    } else {
      throw new Error('expected ambiguous')
    }
  })
})

describe('normalizeForComparison', () => {
  it('folds full-width punctuation to half-width', () => {
    expect(normalizeForComparison('今天，天气真好。')).toBe('今天,天气真好.')
    expect(normalizeForComparison('（注意）：Ａ？')).toContain('(注意):')
  })

  it('collapses whitespace runs (incl. full-width space) and lowercases', () => {
    expect(normalizeForComparison('A　 B\t\tC')).toBe('a b c')
    expect(normalizeForComparison('  x  ')).toBe('x')
  })
})

describe('findSimilarPassage', () => {
  it('locates a single line with a stray space and returns it verbatim', () => {
    const res = findSimilarPassage('# 标题\n今天 天气不错\n结尾', '今天天气不错')
    expect(res).not.toBeNull()
    expect(res?.startLine).toBe(2)
    expect(res?.endLine).toBe(2)
    expect(res?.text).toBe('今天 天气不错')
    expect(res?.similarity).toBeGreaterThan(0.5)
  })

  it('treats full/half-width punctuation differences as near-exact', () => {
    const res = findSimilarPassage('前言\n今天天气不错。\n后记', '今天天气不错.')
    expect(res?.startLine).toBe(2)
    expect(res?.text).toBe('今天天气不错。')
    expect(res?.similarity).toBeGreaterThan(0.9)
  })

  it('locates a multi-line passage and reports its full line range', () => {
    const content = [
      'a',
      'b',
      '第一行内容比较长',
      '第二行内容也不短!',
      '第三行收尾',
      'c',
      'd',
    ].join('\n')
    const old = '第一行内容比较长\n第二行内容也不短\n第三行收尾'
    const res = findSimilarPassage(content, old)
    expect(res?.startLine).toBe(3)
    expect(res?.endLine).toBe(5)
    expect(res?.text).toBe('第一行内容比较长\n第二行内容也不短!\n第三行收尾')
    expect(res?.similarity).toBeGreaterThan(0.9)
  })

  it('trims blank edge lines of the requested old_text', () => {
    const res = findSimilarPassage(
      'x\n目标段落在这里\ny',
      '\n\n目标段落在这里\n\n',
    )
    expect(res?.startLine).toBe(2)
    expect(res?.endLine).toBe(2)
    expect(res?.text).toBe('目标段落在这里')
  })

  it('still finds a passage with a typo in one character', () => {
    const content = '这是一个相当长的句子，用来测试模糊匹配的召回能力是否足够好。\n其他行'
    const old = '这是一个相当长的句子，用来测试模糊匹配的召回能力是否足够优秀。'
    const res = findSimilarPassage(content, old)
    expect(res?.startLine).toBe(1)
    expect(res?.similarity).toBeGreaterThan(0.6)
  })

  it('returns null for unrelated text', () => {
    expect(findSimilarPassage('# Post\nhello', 'absent text')).toBeNull()
  })

  it('returns null for degenerate inputs', () => {
    expect(findSimilarPassage('anything', '')).toBeNull()
    expect(findSimilarPassage('anything', '   \n  \n')).toBeNull()
    // old_text taller than the whole content cannot be aligned.
    expect(findSimilarPassage('one', 'one\ntwo')).toBeNull()
  })

  it('respects the guard rails on huge inputs (cheap bail-out)', () => {
    const huge = Array.from({ length: 20001 }, (_, i) => `line ${i}`).join('\n')
    expect(findSimilarPassage(huge, 'line 999')).toBeNull()
    const longOld = Array.from({ length: 201 }, (_, i) => `old ${i}`).join('\n')
    expect(findSimilarPassage('whatever', longOld)).toBeNull()
  })
})
