// embedClient — OpenAI-compatible `/embeddings` client, plain fetch (no SDK).
//
// 铁律2 修订版边界：embedding 计算只发生在远程 API，这里只是 JSON-over-HTTP
// 调用 + Float32Array 封装。错误映射风格沿用 mcpClient（401=凭据、
// TypeError=网络/CORS）。

/** Max texts per one /embeddings request (servers cap batch size). */
export const EMBED_BATCH_SIZE = 10

/** Per-request timeout; embedding batches are small, 10s is generous. */
const EMBED_TIMEOUT_MS = 10_000

export interface EmbedConfig {
  baseUrl: string
  apiKey: string
  model: string
}

interface EmbeddingItem {
  index?: number
  embedding?: number[]
}

/** POST one batch (≤ EMBED_BATCH_SIZE texts) and return vectors in input order. */
export async function embedBatch(
  cfg: EmbedConfig,
  texts: string[],
): Promise<Float32Array[]> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/embeddings'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`

  let response: Response
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: controller.signal,
    })
    clearTimeout(timer)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Embedding 请求超时（10 秒），请稍后重试')
    }
    throw new Error(
      '网络连接失败——请检查 embedding 端点是否可达，以及服务端是否允许浏览器跨域（CORS）',
    )
  }

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      // Body unreadable — status code alone still pinpoints the problem.
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Embedding 凭据无效（401/403）——请检查设置页里的 API Key')
    }
    throw new Error(`Embedding 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Embedding 服务返回了非法 JSON')
  }

  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) {
    throw new Error('Embedding 响应缺少 data 数组')
  }
  const items = data as EmbeddingItem[]
  // Sort by server-reported index so output aligns with input order.
  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const out: Float32Array[] = []
  for (const item of items) {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error('Embedding 响应中存在空向量')
    }
    out.push(Float32Array.from(item.embedding))
  }
  if (out.length !== texts.length) {
    throw new Error(
      `Embedding 数量不匹配：发送 ${texts.length} 条，返回 ${out.length} 条`,
    )
  }
  return out
}

/** Embed any number of texts, internally batched by EMBED_BATCH_SIZE. */
export async function embedTexts(
  cfg: EmbedConfig,
  texts: string[],
): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    out.push(...(await embedBatch(cfg, batch)))
  }
  return out
}
