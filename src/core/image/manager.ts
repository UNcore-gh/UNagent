// Image provider factory: turn image settings (VENDOR → MODELS) into a
// concrete provider.

import { ImageSettings, LLMSettings, resolveActiveImage } from '../../settings/settings'
import { ImageProvider } from './base'
import { LLMError } from '../llm/errors'
import { OpenAIImagesProvider } from './openaiImages'
import { DashScopeImagesProvider } from './dashScopeImages'

export function createImageProvider(
  image: ImageSettings,
  llm: LLMSettings,
): ImageProvider {
  const r = resolveActiveImage(image, llm)
  // 追加㊾：百炼（DashScope）的 OpenAI 兼容模式不支持图片生成——
  // /images/generations 在 compatible-mode 网关返回 404 且无 CORS 头，
  // 浏览器 fetch 抛 TypeError 被误判为「网络问题」；生图必须走原生协议。
  if ((r.baseUrl || '').toLowerCase().includes('dashscope.aliyuncs.com')) {
    return new DashScopeImagesProvider({
      apiKey: r.apiKey,
      model: r.model,
      size: image.size,
    })
  }
  switch (r.provider) {
    case 'openai-images':
    // 追加㉗：统一厂商列表后，对话厂商（OpenAI 兼容）里勾了「图片生成」
    // 能力的模型也走 /images/generations——同一端点同一协议。
    case 'openai-compatible':
      return new OpenAIImagesProvider({
        baseUrl: r.baseUrl,
        apiKey: r.apiKey,
        model: r.model,
        size: image.size,
      })
    default:
      throw new LLMError('unknown', `该厂商协议不支持生图：${r.provider}`)
  }
}
