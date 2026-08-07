// Folder-exclusion helpers: Obsidian userIgnoreFilters + plugin custom list
// merge, path normalization, and prefix matching.

import type { App } from 'obsidian'
import {
  aiFolderExclusion,
  effectiveExclusions,
  getObsidianExcludedFolders,
  isExcludedPath,
  normalizeFolder,
} from '../exclusions'

/** Fake app whose vault.getConfig returns the given userIgnoreFilters value. */
const mkApp = (userIgnoreFilters?: unknown): App =>
  ({
    vault:
      userIgnoreFilters === undefined
        ? {}
        : {
            getConfig: (key: string) =>
              key === 'userIgnoreFilters' ? userIgnoreFilters : undefined,
          },
  }) as unknown as App

describe('normalizeFolder', () => {
  it('trims whitespace and surrounding slashes', () => {
    expect(normalizeFolder(' archive ')).toBe('archive')
    expect(normalizeFolder('/archive/')).toBe('archive')
    expect(normalizeFolder('a/b/')).toBe('a/b')
    expect(normalizeFolder('')).toBe('')
  })
})

describe('getObsidianExcludedFolders', () => {
  it('returns the vault config list verbatim', () => {
    expect(getObsidianExcludedFolders(mkApp(['Templates', 'archive']))).toEqual([
      'Templates',
      'archive',
    ])
  })

  it('tolerates a missing getConfig (older runtimes)', () => {
    expect(getObsidianExcludedFolders(mkApp(undefined))).toEqual([])
  })

  it('tolerates non-array config and filters non-strings', () => {
    expect(getObsidianExcludedFolders(mkApp('nope'))).toEqual([])
    expect(getObsidianExcludedFolders(mkApp(['a', 42, null]))).toEqual(['a'])
  })
})

describe('effectiveExclusions', () => {
  it('merges Obsidian list + custom list, normalized and deduped', () => {
    const app = mkApp(['a/', 'b'])
    expect(effectiveExclusions(app, ['/b', 'c ', ''])).toEqual(['a', 'b', 'c'])
  })

  it('is just the Obsidian list when no custom folders are set', () => {
    expect(effectiveExclusions(mkApp(['x']))).toEqual(['x'])
  })

  it('is empty when neither source has anything', () => {
    expect(effectiveExclusions(mkApp(undefined), [])).toEqual([])
  })

  it('merges the extra contributions too (auto-hidden AI folder)', () => {
    const app = mkApp(['a'])
    expect(effectiveExclusions(app, ['b'], ['.obsidian-ai'])).toEqual([
      'a',
      'b',
      '.obsidian-ai',
    ])
    // Extras are normalized + deduped against the other sources.
    expect(effectiveExclusions(app, ['x'], ['x/', '/x'])).toEqual(['a', 'x'])
  })
})

describe('aiFolderExclusion', () => {
  it('contributes the folder when the hide toggle is on', () => {
    expect(aiFolderExclusion(true, '.obsidian-ai')).toEqual(['.obsidian-ai'])
    expect(aiFolderExclusion(true, '/my-ai/')).toEqual(['my-ai'])
  })

  it('contributes nothing when off or blank', () => {
    expect(aiFolderExclusion(false, '.obsidian-ai')).toEqual([])
    expect(aiFolderExclusion(true, '   ')).toEqual([])
  })
})

describe('isExcludedPath', () => {
  const ex = ['archive', 'deep/nested']

  it('matches files inside an excluded folder', () => {
    expect(isExcludedPath('archive/x.md', ex)).toBe(true)
    expect(isExcludedPath('deep/nested/a/b.md', ex)).toBe(true)
  })

  it('matches the excluded folder path itself', () => {
    expect(isExcludedPath('archive', ex)).toBe(true)
  })

  it('does NOT match mere string prefixes (archive2 ≠ archive)', () => {
    expect(isExcludedPath('archive2/x.md', ex)).toBe(false)
    expect(isExcludedPath('archives.md', ex)).toBe(false)
  })

  it('tolerates a leading slash on the path', () => {
    expect(isExcludedPath('/archive/x.md', ex)).toBe(true)
  })

  it('short-circuits on an empty exclusion list', () => {
    expect(isExcludedPath('anything/at/all.md', [])).toBe(false)
  })
})
