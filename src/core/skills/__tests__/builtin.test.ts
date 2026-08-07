// Sanity contract for the official builtin skills.

import { BUILTIN_SKILLS } from '../builtin'
import { ALL_TOOLS } from '../../../tools'

const EXPECTED = [
  'search-notes',
  'read-note',
  'create-note',
  'edit-note',
  'frontmatter-editor',
  'tag-manager',
  'note-mover',
  'note-deleter',
  'image-generator',
  'skill-creator',
  'agent-creator',
  'agent-editor',
  'skill-editor',
  'add-mcp',
  'self-evolution',
]

describe('BUILTIN_SKILLS', () => {
  it('ships the expected one-per-tool skill set', () => {
    expect(BUILTIN_SKILLS.map((s) => s.metadata.name).sort()).toEqual([...EXPECTED].sort())
  })

  it('has unique names, all builtin + lazy', () => {
    const names = BUILTIN_SKILLS.map((s) => s.metadata.name)
    expect(new Set(names).size).toBe(names.length)
    for (const s of BUILTIN_SKILLS) {
      expect(s.source).toBe('builtin')
      expect(s.metadata.mode).toBe('lazy')
    }
  })

  it('has non-empty descriptions and bodies', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.metadata.description.length).toBeGreaterThan(5)
      expect(s.body.length).toBeGreaterThan(10)
    }
  })

  it('only references real tool names', () => {
    const toolNames = new Set(ALL_TOOLS.map((t) => t.metadata.name))
    for (const s of BUILTIN_SKILLS) {
      for (const tool of s.metadata.tools ?? []) {
        expect(toolNames.has(tool)).toBe(true)
      }
    }
  })
})
