// Skill system types. A skill is a markdown capability pack: frontmatter
// metadata + an instruction body. Four sources:
//   builtin       — official skills shipped with the plugin (one per note tool)
//   user          — *.md files the user drops into the configured vault folder
//   hermes        — skills living on the hermes side (~/.hermes/skills), surfaced
//                   read-only into the '//' picker while a hermes conversation
//                   is active (never registered into the plugin SkillRegistry);
//                   builtin/official-sourced hermes skills map here
//   hermes-local  — hermes skills the user installed/placed themselves
//                   (Source=local in `hermes skills list`); the picker badges
//                   these as 用户 to distinguish self-installed skills from
//                   the bundled official ones

// Two disclosure modes (progressive disclosure keeps the context light):
//   always — body injected into the system prompt up front
//   lazy   — listed by name+description; full body fetched via load_skill

export type SkillSource = 'builtin' | 'user' | 'hermes' | 'hermes-local'
export type SkillMode = 'always' | 'lazy'

export interface SkillMetadata {
  /** Canonical identifier (kebab-case for builtins; user-chosen otherwise). */
  name: string
  /** One-line pitch shown to the LLM so it knows when to load the skill. */
  description: string
  mode: SkillMode
  /** Optional display emoji. */
  emoji?: string
  /** Optional semantic version. */
  version?: string
  /** Names of note tools this skill is about (informational). */
  tools?: string[]
}

export interface Skill {
  metadata: SkillMetadata
  /** Markdown instructions (frontmatter stripped). */
  body: string
  source: SkillSource
  /** Vault path for user skills; undefined for builtins. */
  path?: string
}
