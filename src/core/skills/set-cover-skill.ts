// Custom skill template for "设置笔记封面" (set-cover). This is no longer a
// builtin skill — it's seeded as a user-custom skill in the skills folder so
// the user can edit or remove it freely. The seed runs only when the skill
// file doesn't already exist (idempotent).

import { App } from 'obsidian'
import { pathExists, writeText } from '../../utils/vaultIO'

export const SET_COVER_SKILL_BODY = `---
name: 设置封面
description: 把一张图片设为一篇笔记的 frontmatter cover 字段（封面图）。
mode: lazy
tools: [update_frontmatter, generate_image, read_note, search_notes]
---

# 设置笔记封面

【何时使用】用户想把某张图片设为笔记封面，设置 frontmatter 的 cover 字段。

【步骤】
1. 确认用户想设封面的笔记是哪篇（不确定时先 search_notes 或 read_note 定位）。
2. 如果图片还未生成，用 generate_image 先生成图片（无需 asCover 参数）。
3. 用 update_frontmatter 将笔记的 cover 字段设为图片路径：updates: {cover: "<图片路径>"}。
4. 告知用户封面已设置完成。

【注意】
- 图片路径是 vault 相对路径（如 "AI 助手/images/AI-image-2026-08-01_120000.png"）。
- 若用户已有图片但未在 vault 中，先解释需要将图片放入 vault 后再设置封面。
- 设置封面不会修改笔记正文，只改 YAML frontmatter。
`

/** Seed the set-cover custom skill into the user's skills folder, only when
 *  the file doesn't already exist. Idempotent — safe to call on every load. */
export async function seedSetCoverSkill(app: App, aiFolder: string): Promise<void> {
  const base = aiFolder.trim().replace(/^\/+|\/+$/g, '') || 'AI 助手'
  const skillPath = `${base}/skills/set-cover/SKILL.md`
  if (await pathExists(app, skillPath)) return
  // Ensure the parent folder exists (writeText creates intermediate dirs).
  await writeText(app, skillPath, SET_COVER_SKILL_BODY)
}