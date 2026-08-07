// Skill parsing + vault scanning. parseSimpleYaml / parseSkillContent are
// pure; findSkillFiles / loadUserSkills run against an adapter-level fake
// App (no getMarkdownFiles) — the default skill folder lives under the
// dot-prefixed .obsidian-ai/, which Obsidian's indexed APIs never see.

import { App } from 'obsidian'
import {
  findSkillFiles,
  loadUserSkills,
  parseSimpleYaml,
  parseSkillContent,
} from '../skillLoader'

describe('parseSimpleYaml', () => {
  it('parses scalars, booleans and quoted strings', () => {
    const out = parseSimpleYaml(
      ['name: weekly-report', 'always: true', 'off: false', 'emoji: "📊"', "desc: 'hi'"].join('\n'),
    )
    expect(out.name).toBe('weekly-report')
    expect(out.always).toBe(true)
    expect(out.off).toBe(false)
    expect(out.emoji).toBe('📊')
    expect(out.desc).toBe('hi')
  })

  it('parses inline arrays and block lists', () => {
    const inline = parseSimpleYaml('tools: [create_note, read_note]')
    expect(inline.tools).toEqual(['create_note', 'read_note'])

    const block = parseSimpleYaml(
      ['tools:', '  - search_notes', '  - "read_note"'].join('\n'),
    )
    expect(block.tools).toEqual(['search_notes', 'read_note'])
  })

  it('drops keys that opened an empty list and skips comments', () => {
    const out = parseSimpleYaml(['# comment', '', 'tools:', 'name: x'].join('\n'))
    expect(out.tools).toBeUndefined()
    expect(out.name).toBe('x')
  })
})

describe('parseSkillContent', () => {
  it('parses a full frontmatter skill', () => {
    const content = [
      '---',
      'name: weekly-report',
      'description: 生成周报',
      'mode: always',
      'emoji: 📊',
      'tools: [create_note, read_note]',
      '---',
      '',
      '# 周报指南',
      '正文内容',
    ].join('\n')
    const skill = parseSkillContent(content, { source: 'user', path: 'a.md', fallbackName: 'ignored' })
    expect(skill).not.toBeNull()
    expect(skill?.metadata.name).toBe('weekly-report')
    expect(skill?.metadata.description).toBe('生成周报')
    expect(skill?.metadata.mode).toBe('always')
    expect(skill?.metadata.emoji).toBe('📊')
    expect(skill?.metadata.tools).toEqual(['create_note', 'read_note'])
    expect(skill?.body).toBe('# 周报指南\n正文内容')
    expect(skill?.source).toBe('user')
    expect(skill?.path).toBe('a.md')
  })

  it('defaults mode to lazy and supports block-list tools', () => {
    const content = [
      '---',
      'name: x',
      'description: d',
      'tools:',
      '  - search_notes',
      '  - read_note',
      '---',
      'body',
    ].join('\n')
    const skill = parseSkillContent(content, { source: 'builtin', fallbackName: 'f' })
    expect(skill?.metadata.mode).toBe('lazy')
    expect(skill?.metadata.tools).toEqual(['search_notes', 'read_note'])
  })

  it('falls back to the first body line when description is missing', () => {
    const skill = parseSkillContent('---\nname: x\n---\n# 我的标题\n内容', {
      source: 'user',
      fallbackName: 'f',
    })
    expect(skill?.metadata.description).toBe('我的标题')
  })

  it('falls back to fallbackName when frontmatter has no name (or none at all)', () => {
    const noName = parseSkillContent('---\ndescription: d\n---\nbody', {
      source: 'user',
      fallbackName: 'from-file',
    })
    expect(noName?.metadata.name).toBe('from-file')

    const noFm = parseSkillContent('# 只有正文', { source: 'user', fallbackName: 'bare' })
    expect(noFm?.metadata.name).toBe('bare')
    expect(noFm?.metadata.description).toBe('只有正文')
  })

  it('returns null when there is nothing usable', () => {
    expect(parseSkillContent('', { source: 'user', fallbackName: '' })).toBeNull()
    expect(parseSkillContent('---\nname: only-meta\n---\n', { source: 'user', fallbackName: '' })).toBeNull()
  })
})

/** Adapter fake over a path set + content map (folders are implicit). */
function mkApp(paths: string[], contents: Record<string, string> = {}): App {
  const set = new Set(paths)
  const isDir = (p: string): boolean =>
    [...set].some((k) => k.startsWith(`${p}/`))
  return {
    vault: {
      adapter: {
        exists: async (p: string) => set.has(p) || isDir(p),
        read: async (p: string) => {
          const c = contents[p]
          if (c === undefined) throw new Error('enoent')
          return c
        },
        write: async (_p: string, _data: string) => undefined,
        writeBinary: async (_p: string, _data: ArrayBuffer) => undefined,
        mkdir: async (_p: string) => undefined,
        remove: async (p: string) => {
          set.delete(p)
        },
        list: async (p: string) => {
          const files: string[] = []
          const folders = new Set<string>()
          for (const k of set) {
            if (!k.startsWith(`${p}/`)) continue
            const rest = k.slice(p.length + 1)
            const slash = rest.indexOf('/')
            if (slash === -1) files.push(k)
            else folders.add(`${p}/${rest.slice(0, slash)}`)
          }
          return { files, folders: [...folders] }
        },
      },
    },
  } as unknown as App
}

describe('findSkillFiles', () => {
  const paths = [
    '.obsidian-ai/skills/a.md',
    '.obsidian-ai/skills/b/SKILL.md',
    '.obsidian-ai/skills/b/extra.md',
    '.obsidian-ai/skills/b/deep/SKILL.md',
    'other/c.md',
  ]

  it('takes direct children and one-level <sub>/SKILL.md, nothing deeper', async () => {
    const app = mkApp(paths)
    const found = (await findSkillFiles(app, '.obsidian-ai/skills')).map(
      (f) => f.path,
    )
    expect(found).toEqual([
      '.obsidian-ai/skills/a.md',
      '.obsidian-ai/skills/b/SKILL.md',
    ])
  })

  it('tolerates trailing slashes and returns [] for an empty folder', async () => {
    const app = mkApp(paths)
    expect((await findSkillFiles(app, ' .obsidian-ai/skills/ ')).length).toBe(2)
    expect(await findSkillFiles(app, '   ')).toEqual([])
  })

  it('returns [] when the folder does not exist', async () => {
    const app = mkApp(paths)
    expect(await findSkillFiles(app, 'nowhere')).toEqual([])
  })

  it('derives fallback names: basename for files, folder for SKILL.md', async () => {
    const app = mkApp(['sk/bar.md', 'sk/foo/SKILL.md'])
    expect(await findSkillFiles(app, 'sk')).toEqual([
      { path: 'sk/bar.md', fallbackName: 'bar' },
      { path: 'sk/foo/SKILL.md', fallbackName: 'foo' },
    ])
  })
})

describe('loadUserSkills', () => {
  it('parses readable files and skips unreadable ones', async () => {
    const app = mkApp(['sk/good.md', 'sk/bad.md'], {
      'sk/good.md': '---\ndescription: 好技能\n---\n正文',
      // bad.md missing from contents → read() throws → skipped
    })
    const skills = await loadUserSkills(app, 'sk')
    expect(skills).toHaveLength(1)
    expect(skills[0].metadata.name).toBe('good')
    expect(skills[0].source).toBe('user')
  })

  it('derives names from SKILL.md parent folders', async () => {
    const app = mkApp(['sk/my-tool/SKILL.md'], {
      'sk/my-tool/SKILL.md': '指南正文',
    })
    const skills = await loadUserSkills(app, 'sk')
    expect(skills[0].metadata.name).toBe('my-tool')
  })

  it('discovers skills under a dot folder invisible to getMarkdownFiles', async () => {
    // Regression: the fake app has NO indexed-file APIs at all — exactly the
    // situation for .obsidian-ai/skills/ under real Obsidian.
    const app = mkApp(['.obsidian-ai/skills/hidden/SKILL.md'], {
      '.obsidian-ai/skills/hidden/SKILL.md':
        '---\ndescription: 点文件夹里的技能\n---\n正文',
    })
    const skills = await loadUserSkills(app, '.obsidian-ai/skills')
    expect(skills).toHaveLength(1)
    expect(skills[0].metadata.name).toBe('hidden')
    expect(skills[0].path).toBe('.obsidian-ai/skills/hidden/SKILL.md')
  })
})
