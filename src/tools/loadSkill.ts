// load_skill: the progressive-disclosure entry point for lazy skills. The
// system prompt lists skills by name + one-line description; when a task
// matches, the model calls this tool to fetch the full instruction body.
// Skills are prompt text only — this tool just returns markdown, never code.

import type { Tool, ToolRunResult } from '../core/agent/types'

export const loadSkillTool: Tool = {
  metadata: {
    name: 'load_skill',
    description:
      'Load the full guide of a skill by name. The 【Skills】 section of the system prompt lists available skill names and when each applies — call this tool to load the matching skill before handling such a task.',
    category: 'read',
    destructive: false,
    requiresVault: false,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name exactly as listed in the system prompt, e.g. "image-generator".',
        },
      },
      required: ['name'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) {
      return {
        ok: false,
        summary: '未提供技能名称',
        output: { error: 'missing-name' },
      }
    }

    const registry = ctx.skills
    if (!registry) {
      return {
        ok: false,
        summary: '技能功能不可用',
        output: { error: 'no-registry' },
      }
    }

    const skill = registry.getByName(name)
    if (!skill) {
      if (ctx.disabledSkills?.includes(name)) {
        return {
          ok: false,
          summary: `技能「${name}」已被用户在设置中禁用`,
          output: { error: 'skill-disabled', name },
        }
      }
      const available = registry
        .getAll()
        .map((s) => s.metadata.name)
        .sort()
      if (available.length === 0) {
        return {
          ok: false,
          summary: '当前没有可用技能（可能已在设置中关闭技能功能）',
          output: { error: 'no-skills' },
        }
      }
      return {
        ok: false,
        summary: `未找到技能「${name}」`,
        output: { error: 'not-found', name, available },
      }
    }

    return {
      ok: true,
      summary: `已载入技能「${skill.metadata.name}」`,
      output: {
        name: skill.metadata.name,
        mode: skill.metadata.mode,
        body: skill.body,
      },
    }
  },
}
