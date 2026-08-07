// OpenAI Images adapter: POST {baseUrl}/images/generations.
// Handles both dall-e-3 (accepts response_format=b64_json) and gpt-image-1
// (always returns b64_json; takes output_format instead). Native fetch only.

import { LLMError } from '../llm/errors'
import { fetchStream } from '../llm/http'
import { GeneratedImage, GenerateImageOptions, ImageProvider } from './base'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export interface OpenAIImagesConfig {
  baseUrl: string
  apiKey: string
  model: string
  size: string
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function extFromContentType(ct: string | null): string {
  if (!ct) return 'png'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  return 'png'
}

export class OpenAIImagesProvider implements ImageProvider {
  readonly id = 'openai-images'

  constructor(private readonly config: OpenAIImagesConfig) {}

  async generate(
    prompt: string,
    options?: GenerateImageOptions,
  ): Promise<GeneratedImage[]> {
    const apiKey = this.config.apiKey.trim()
    const model = this.config.model.trim()
    if (!apiKey) {
      throw new LLMError('api-key-missing', '请先在设置中填写生图 API Key')
    }
    if (!model) {
      throw new LLMError('model-missing', '请先在设置中填写生图模型名')
    }
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      throw new LLMError('unknown', '生图提示词不能为空')
    }

    const baseUrl = (this.config.baseUrl.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
    const url = `${baseUrl}/images/generations`
    const isGptImage = model.startsWith('gpt-image')
    const n = options?.n && options.n > 0 ? Math.floor(options.n) : 1
    const size = (options?.size ?? this.config.size).trim()

    const body: Record<string, unknown> = { model, prompt, n }
    if (size) body.size = size
    if (isGptImage) {
      // gpt-image-1 always returns b64_json; choose the output encoding.
      body.output_format = 'png'
    } else {
      body.response_format = 'b64_json'
    }

    const response = await fetchStream(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.signal,
    )

    let json: any
    try {
      json = await response.json()
    } catch {
      throw new LLMError('http', '生图接口返回了无法解析的响应')
    }

    const items: any[] = Array.isArray(json?.data) ? json.data : []
    if (items.length === 0) {
      throw new LLMError('http', json?.error?.message ?? '生图接口未返回图片')
    }

    const results: GeneratedImage[] = []
    for (const item of items) {
      if (typeof item.b64_json === 'string' && item.b64_json) {
        results.push({
          bytes: base64ToArrayBuffer(item.b64_json),
          ext: 'png',
        })
      } else if (typeof item.url === 'string' && item.url) {
        const res = await fetch(item.url, { signal: options?.signal })
        if (!res.ok) {
          throw new LLMError('http', `下载生成的图片失败（${res.status}）`)
        }
        results.push({
          bytes: await res.arrayBuffer(),
          ext: extFromContentType(res.headers.get('content-type')),
        })
      }
    }

    if (results.length === 0) {
      throw new LLMError('http', '生图接口未返回可用的图片数据')
    }
    return results
  }
}
