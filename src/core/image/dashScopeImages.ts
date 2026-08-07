// DashScope (阿里云百炼) image provider.
//
// 百炼的 OpenAI 兼容模式（compatible-mode）不支持图片生成——qwen-image 系列
// 官方明确「通过 DashScope 原生接口调用，不支持 OpenAI 兼容模式」，
// /images/generations 在该网关返回 404 且不带 CORS 头（浏览器 fetch 直接抛
// TypeError，被归类为"网络问题"）。因此生图必须走原生协议：
//   POST /api/v1/services/aigc/text2image/image-synthesis （X-DashScope-Async: enable）
//   GET  /api/v1/tasks/{task_id} 轮询直至 SUCCEEDED
// 图片以 URL（OSS 直链，24h 有效，带 Access-Control-Allow-Origin: *）返回，
// 需下载后落盘。Native fetch only。

import { LLMError } from '../llm/errors'
import { fetchStream } from '../llm/http'
import { GeneratedImage, GenerateImageOptions, ImageProvider } from './base'

const DASHSCOPE_HOST = 'https://dashscope.aliyuncs.com'
const SYNTHESIS_URL = `${DASHSCOPE_HOST}/api/v1/services/aigc/text2image/image-synthesis`
const DEFAULT_POLL_MS = 3000
const DEFAULT_TIMEOUT_MS = 120_000

export interface DashScopeImagesConfig {
  apiKey: string
  model: string
  size: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** OpenAI 风格 "1024x1024" → DashScope 风格 "1024*1024"。 */
function toDashScopeSize(size: string): string {
  const trimmed = size.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase().replace(/x/g, '*')
}

export class DashScopeImagesProvider implements ImageProvider {
  readonly id = 'dashscope-images'

  constructor(
    private readonly config: DashScopeImagesConfig,
    private readonly timing: { pollMs?: number; timeoutMs?: number } = {},
  ) {}

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

    const size = toDashScopeSize(options?.size ?? this.config.size)
    const n = options?.n && options.n > 0 ? Math.floor(options.n) : 1
    const body: Record<string, unknown> = {
      model,
      input: { prompt: trimmedPrompt },
      parameters: { n },
    }
    if (size) (body.parameters as Record<string, unknown>).size = size

    // 1) 异步提交任务
    const submitRes = await fetchStream(
      SYNTHESIS_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.signal,
    )
    let submitJson: any
    try {
      submitJson = await submitRes.json()
    } catch {
      throw new LLMError('http', '生图接口返回了无法解析的响应')
    }
    const taskId: string | undefined = submitJson?.output?.task_id
    if (!taskId) {
      throw new LLMError(
        'http',
        submitJson?.message ?? '生图任务提交失败（未返回任务 ID）',
      )
    }

    // 2) 轮询任务状态（DashScope 原生生图为异步任务）
    const pollMs = this.timing.pollMs ?? DEFAULT_POLL_MS
    const deadline = Date.now() + (this.timing.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    for (;;) {
      if (options?.signal?.aborted) {
        throw new LLMError('aborted', '已停止')
      }
      await sleep(pollMs)
      const pollRes = await fetchStream(
        `${DASHSCOPE_HOST}/api/v1/tasks/${taskId}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: options?.signal,
        },
        options?.signal,
      )
      let pollJson: any
      try {
        pollJson = await pollRes.json()
      } catch {
        throw new LLMError('http', '查询生图任务状态失败')
      }
      const status = pollJson?.output?.task_status
      if (status === 'SUCCEEDED') {
        const urls: string[] = (pollJson?.output?.results ?? [])
          .map((r: any) => r?.url)
          .filter((u: unknown): u is string => typeof u === 'string' && u.length > 0)
        if (urls.length === 0) {
          throw new LLMError('http', '生图任务已完成，但未返回图片')
        }
        const results: GeneratedImage[] = []
        for (const url of urls) {
          const res = await fetch(url, { signal: options?.signal })
          if (!res.ok) {
            throw new LLMError('http', `下载生成的图片失败（${res.status}）`)
          }
          results.push({
            bytes: await res.arrayBuffer(),
            // DashScope 原生接口固定返回 PNG
            ext: 'png',
          })
        }
        return results
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        const detail = pollJson?.message ?? ''
        throw new LLMError(
          'http',
          status === 'FAILED'
            ? `生图任务失败${detail ? `：${detail}` : ''}`
            : '生图任务已取消',
        )
      }
      if (Date.now() > deadline) {
        throw new LLMError('http', '生图任务超时，请稍后重试')
      }
    }
  }
}
