// load_skill tool: progressive disclosure entry point, exercised directly.

import type { ToolContext } from '../../core/agent/types'
import { SkillRegistry } from '../../core/skills/SkillRegistry'
import type { Skill } from '../../core/skills/types'
import { loadSkillTool } from '../loadSkill'

const sample: Skill = {
  metadata: { name: 'demo', description: '示例技能', mode: 'lazy' },
  body: '# Demo\n做某事的完整指南。',
  source: 'builtin',
}

function makeCtx(
  skills?: SkillRegistry,
  disabledSkills?: string[],
): ToolContext {
  return {
    app: {} as ToolContext['app'],
    confirm: async () => true,
    pushUndo: () => {},
    imageProvider: { id: 'fake', generate: async () => [] },
    skills,
    disabledSkills,
  }
}

describe('load_skill', () => {
  it('loads a registered skill body', async () => {
    const reg = new SkillRegistry()
    reg.register(sample)
    const res = await loadSkillTool.run({ name: 'demo' }, makeCtx(reg))
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({
      name: 'demo',
      mode: 'lazy',
      body: sample.body,
    })
  })

  it('rejects a missing name', async () => {
    const res = await loadSkillTool.run({}, makeCtx(new SkillRegistry()))
    expect(res.ok).toBe(false)
    expect((res.output as { error: string }).error).toBe('missing-name')
  })

  it('reports when the caller never wired a registry', async () => {
    const res = await loadSkillTool.run({ name: 'demo' }, makeCtx(undefined))
    expect(res.ok).toBe(false)
    expect((res.output as { error: string }).error).toBe('no-registry')
  })

  it('distinguishes user-disabled from unknown, and lists available skills', async () => {
    const reg = new SkillRegistry()
    reg.register(sample)

    const disabled = await loadSkillTool.run(
      { name: 'ghost' },
      makeCtx(reg, ['ghost']),
    )
    expect(disabled.ok).toBe(false)
    expect((disabled.output as { error: string }).error).toBe('skill-disabled')

    const unknown = await loadSkillTool.run(
      { name: 'ghost' },
      makeCtx(reg, []),
    )
    expect(unknown.ok).toBe(false)
    expect((unknown.output as { error: string }).error).toBe('not-found')
    expect((unknown.output as { available: string[] }).available).toEqual(['demo'])
  })

  it('treats an empty registry as skills-off', async () => {
    const res = await loadSkillTool.run({ name: 'demo' }, makeCtx(new SkillRegistry()))
    expect(res.ok).toBe(false)
    expect((res.output as { error: string }).error).toBe('no-skills')
  })
})
