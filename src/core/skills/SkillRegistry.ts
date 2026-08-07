// Skill registry: holds builtin + user skills by name. Owned by the plugin
// (main.ts); the agent receives a filtered per-run view (master toggle +
// per-skill disabled list applied in useAgent).

import type { Skill } from './types'

export class SkillRegistry {
  private skills = new Map<string, Skill>()

  register(skill: Skill): void {
    this.skills.set(skill.metadata.name, skill)
  }

  registerAll(skills: Skill[]): void {
    for (const s of skills) this.register(s)
  }

  /** Remove every skill from a given source (used when reloading user skills). */
  removeBySource(source: Skill['source']): void {
    for (const [name, skill] of this.skills) {
      if (skill.source === source) this.skills.delete(name)
    }
  }

  getByName(name: string): Skill | undefined {
    return this.skills.get(name.trim())
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values())
  }

  clear(): void {
    this.skills.clear()
  }
}
