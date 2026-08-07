// generate_image: an AI-callable tool that generates an image, saves it into
// the plugin's data folder under images/, and optionally inserts it into a
// note. Image generation is slow (5–30s); the UI shows progress.

import type { Tool, ToolRunResult } from '../core/agent/types'
import { saveGeneratedImage } from '../core/image/saveImage'
import { resolveFile } from './util'

export const generateImageTool: Tool = {
  metadata: {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt and save it into the vault. Optionally insert it into a note (as a wiki embed). Generation can take 5–30 seconds.',
    category: 'write',
    destructive: false,
    requiresVault: true,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A detailed description of the image to generate.',
        },
        size: {
          type: 'string',
          description: 'Optional size like "1024x1024", "1792x1024", "1024x1792".',
        },
        notePath: {
          type: 'string',
          description: 'Optional note to insert the image into (appended as an embed).',
        },
      },
      required: ['prompt'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    const size = typeof args.size === 'string' && args.size.trim() ? args.size.trim() : undefined

    const images = await ctx.imageProvider.generate(prompt, {
      size,
      n: 1,
      signal: ctx.signal,
    })
    const image = images[0]
    const file = await saveGeneratedImage(
      ctx.app,
      image.bytes,
      image.ext,
      ctx.aiFolder ?? '',
    )
    const embed = `![[${file.name}]]`

    let insertedInto: string | undefined
    const notePath = typeof args.notePath === 'string' ? args.notePath.trim() : ''
    if (notePath) {
      const note = resolveFile(ctx.app, notePath)
      if (note) {
        const original = await ctx.app.vault.read(note)
        await ctx.app.vault.modify(note, original.replace(/\s*$/, '') + `\n\n${embed}\n`)
        insertedInto = note.path
        ctx.pushUndo(`在 ${note.basename} 插入图片`, async () => {
          await ctx.app.vault.modify(note, original)
        })
      }
    }

    const parts = [`已生成图片并保存到 ${file.path}`]
    if (insertedInto) parts.push(`已插入到 ${insertedInto}`)

    return {
      ok: true,
      summary: parts.join('，'),
      output: { path: file.path, name: file.name, embed },
    }
  },
}
