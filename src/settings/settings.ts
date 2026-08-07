// Settings schema + defaults.
//   llm    — Phase 1 (chat provider) → 追加⑨: multi-vendor model PROFILES
//   image  — Phase 3 (image generation provider)
//   safety — Phase 4 (confirmation behavior)
//   skills — Phase 6 (skill framework: master toggle, folder, per-skill disables)
// Persisted via plugin.saveData into data.json (API keys land there in
// plaintext — accepted for v1, see HANDOFF; data.json is gitignored).

import type { ApprovalModeId } from '../core/agent/approval'

/**
 * One configured chat model: vendor protocol + endpoint + credentials.
 * Users keep any number (e.g. DeepSeek via the Anthropic protocol AND an
 * OpenAI-compatible relay) and switch per conversation via /model.
 */
export interface ModelProfile {
  /** Stable id (genProfileId); what session overrides reference. */
  id: string
  /** Display name shown in the /model picker and chips. */
  name: string
  /** Wire protocol: 'openai-compatible' | 'anthropic' (PROVIDER_PRESETS). */
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/**
 * One concrete model under a vendor (追加⑱ 补刀: settings are now
 * VENDOR → MODELS — a vendor carries the protocol/endpoint/key once, and any
 * number of models share them).
 */
/** Per-model capability flags. All optional — semantics are capability-specific
 *  (see CAPABILITY_DEFAULTS): tools/reasoning default true (backward compat);
 *  webSearch/vision/imageGen/embedding/jsonMode/fileUnderstanding default false (opt-in). */
export interface ModelCapabilities {
  /** Can understand images (multimodal vision). Routes to this model when the
   *  user attaches images. undefined = false. */
  vision?: boolean
  /** Supports function/tool calling. undefined = true (most OpenAI-compatible
   *  models do; explicit false strips body.tools). */
  tools?: boolean
  /** Supports deep thinking / reasoning_effort. undefined = true. */
  reasoning?: boolean
  /** Can generate images. undefined = false. */
  imageGen?: boolean
  /** Text-embedding model for the semantic retrieval channel (remote
   *  `/embeddings` only — 铁律2 修订版：向量计算永远在远程). undefined = false. */
  embedding?: boolean
  /** Server-side web search. For vendors in Responses API mode this injects
   *  the standard `{"type":"web_search"}` built-in tool (百炼/OpenAI
   *  Responses execute it server-side). Under Chat Completions mode the flag
   *  stays informational (enable_search was deliberately removed, 追加㉒).
   *  Undefined = false. */
  webSearch?: boolean
  /** Supports JSON structured output (response_format). undefined = false. */
  jsonMode?: boolean
  /** Natively understands uploaded files (PDF/docs). undefined = false. */
  fileUnderstanding?: boolean
}

/** Wire API mode under the OpenAI-compatible protocol (追加㉒): the classic
 *  Chat Completions endpoint or the newer Responses API. Anthropic vendors
 *  ignore this (they always speak Messages). Undefined = chat-completions. */
export type ApiMode = 'chat-completions' | 'responses'

export interface VendorModel {
  id: string
  /** The model identifier sent to the API (e.g. "gpt-4o"). */
  name: string
  /** Capability flags — what this model can do. When absent, capabilities are
   *  derived at resolve time (preset map + name heuristic) so old data.json
   *  entries work without re-configuration. */
  capabilities?: ModelCapabilities
  /** Context window in tokens. undefined → heuristic fallback. */
  contextWindow?: number
  /** Max output tokens the model supports; caps request max_tokens. */
  maxOutputTokens?: number
}

/** A configured vendor: shared protocol/endpoint/credentials + its models. */
export interface ModelVendor {
  id: string
  /** Vendor display name (e.g. "OpenAI", "DeepSeek"). */
  name: string
  /** Wire protocol: 'openai-compatible' | 'anthropic' (PROVIDER_PRESETS). */
  provider: string
  /** API mode for openai-compatible vendors (追加㉒); undefined =
   *  'chat-completions'. Ignored for anthropic. */
  apiMode?: ApiMode
  baseUrl: string
  apiKey: string
  models: VendorModel[]
  /** Which vendor preset this was created from (if any). Kept so
   *  resolveCapabilities can still consult preset-authored capabilities. */
  presetId?: string
}

export interface LLMSettings {
  /** Configured vendors (protocol + endpoint + key), each with models. */
  vendors: ModelVendor[]
  /** Which vendor-model is the global default; null/unknown → first model. */
  activeModelId: string | null
  /** Default vision model (for image understanding). null → use activeModelId. */
  activeVisionModelId: string | null
  /** Default embedding model (semantic retrieval). null → first model with
   *  the embedding capability. 与视觉/生图同款：统一厂商列表里挑选。 */
  activeEmbeddingModelId: string | null
  /**
   * Legacy v1 flat profiles. Migration source: loadSettings lifts profiles
   * into vendors (migrateLlmVendors). Kept in the schema so old data.json
   * merges cleanly and as the last-resort fallback when vendors are empty.
   */
  profiles: ModelProfile[]
  /** Legacy: which profile was the default (migration input). */
  activeProfileId: string | null
  /**
   * Legacy v1 single-provider fields. Same role as profiles, older.
   */
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/** A fully resolved model ready for createLLMProvider (+ a display name). */
export interface ResolvedModel {
  provider: string
  /** API mode (openai-compatible only); undefined = chat-completions. */
  apiMode?: ApiMode
  model: string
  baseUrl: string
  apiKey: string
  /** Human label for chips / notes (profile name, else the model id). */
  displayName: string
  /** Resolved capabilities (derived from model + preset + heuristic). */
  capabilities?: ModelCapabilities
  /** Per-model context window (explicit or heuristic). */
  contextWindow?: number
  /** Per-model max output tokens cap. */
  maxOutputTokens?: number
}

/** Short unique id for profiles (persisted; session overrides reference it). */
export function genProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Short unique id for a vendor (persisted). */
export function genVendorId(): string {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Short unique id for a vendor's model. */
export function genModelId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The default vendor-model: the active one (any vendor), else the first. */
export function activeModel(llm: LLMSettings): {
  vendor: ModelVendor
  model: VendorModel
} | null {
  if (llm.activeModelId) {
    const found = findVendorModel(llm, llm.activeModelId)
    if (found) return found
  }
  for (const v of llm.vendors) {
    if (v.models.length > 0) return { vendor: v, model: v.models[0] }
  }
  return null
}

const displayNameOf = (p: ModelProfile): string =>
  p.name.trim() || p.model.trim() || p.provider

/** The global default legacy profile: the active one, else the first (or
 *  null) — used as a fallback when no vendors exist yet. */
export function activeProfile(llm: LLMSettings): ModelProfile | null {
  if (llm.profiles.length === 0) return null
  const hit = llm.activeProfileId
    ? llm.profiles.find((p) => p.id === llm.activeProfileId)
    : undefined
  return hit ?? llm.profiles[0]
}

const vendorDisplayName = (v: ModelVendor, m: VendorModel): string => {
  // 用户指示: 不要显示提供商名字，只显示模型名
  return m.name.trim() || v.name.trim()
}

/** 插件已配置的模型名集合（小写）——hermes 模型清单的过滤依据：只露出
 *  用户实际配置（启用）的模型，没配的不显示。vendors 的模型名 + 旧
 *  profiles 的 model/name 都收。 */
export function configuredModelNameSet(llm: LLMSettings): Set<string> {
  const names = new Set<string>()
  for (const v of llm.vendors) {
    for (const m of v.models) {
      const n = m.name.trim().toLowerCase()
      if (n) names.add(n)
    }
  }
  for (const p of llm.profiles) {
    const n = (p.model || p.name || '').trim().toLowerCase()
    if (n) names.add(n)
  }
  return names
}

/** Resolve the GLOBAL default (what a conversation with no override uses). */
export function resolveActiveModel(llm: LLMSettings): ResolvedModel {
  const active = activeModel(llm)
  if (active) {
    return {
      provider: active.vendor.provider,
      apiMode: active.vendor.apiMode,
      model: active.model.name,
      baseUrl: active.vendor.baseUrl,
      apiKey: active.vendor.apiKey,
      displayName: vendorDisplayName(active.vendor, active.model),
      capabilities: resolveCapabilities(active.vendor, active.model),
      contextWindow: active.model.contextWindow,
      maxOutputTokens: active.model.maxOutputTokens,
    }
  }
  // No vendors — fall back to the legacy flat profiles.
  const profile = activeProfile(llm)
  if (profile) {
    return {
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      displayName: displayNameOf(profile),
    }
  }
  // And finally the legacy single-provider block.
  return {
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    displayName: llm.model.trim() || llm.provider,
  }
}

/** Find a vendor-model by id across every vendor. */
export function findVendorModel(
  llm: LLMSettings,
  modelId: string,
): { vendor: ModelVendor; model: VendorModel } | null {
  for (const v of llm.vendors) {
    const m = v.models.find((m) => m.id === modelId)
    if (m) return { vendor: v, model: m }
  }
  return null
}

/**
 * Resolve a per-conversation override on top of the global default. The
 * override may be a vendor-model id (picker), a vendor name + model, a model
 * id (hand-typed "/model gpt-4o"), or any raw model string (then it rides on
 * the active vendor's protocol + endpoint + key).
 */
export function resolveSessionModel(
  llm: LLMSettings,
  override: string | null,
): ResolvedModel {
  const o = (override ?? '').trim()
  if (!o) return resolveActiveModel(llm)

  // A vendor-model id.
  const byId = findVendorModel(llm, o)
  if (byId) {
    return {
      provider: byId.vendor.provider,
      apiMode: byId.vendor.apiMode,
      model: byId.model.name,
      baseUrl: byId.vendor.baseUrl,
      apiKey: byId.vendor.apiKey,
      displayName: vendorDisplayName(byId.vendor, byId.model),
      capabilities: resolveCapabilities(byId.vendor, byId.model),
      contextWindow: byId.model.contextWindow,
      maxOutputTokens: byId.model.maxOutputTokens,
    }
  }
  // "vendor · model" or "vendor:model" — vendor name + model id.
  const sep = o.split(/\s*[·:]\s*/)
  if (sep.length === 2) {
    const vendor = llm.vendors.find(
      (v) => v.name.trim() === sep[0] || v.id === sep[0],
    )
    if (vendor) {
      const model =
        vendor.models.find((m) => m.name === sep[1]) ??
        vendor.models.find((m) => m.id === sep[1])
      if (model) {
        return {
          provider: vendor.provider,
          apiMode: vendor.apiMode,
          model: model.name,
          baseUrl: vendor.baseUrl,
          apiKey: vendor.apiKey,
          displayName: vendorDisplayName(vendor, model),
          capabilities: resolveCapabilities(vendor, model),
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
        }
      }
    }
  }

  // Legacy profiles (id / name / model).
  const byProfile = llm.profiles.find((p) => p.id === o)
  if (byProfile) {
    return {
      provider: byProfile.provider,
      model: byProfile.model,
      baseUrl: byProfile.baseUrl,
      apiKey: byProfile.apiKey,
      displayName: displayNameOf(byProfile),
    }
  }
  const byProfileName = llm.profiles.find(
    (p) => p.name.trim() === o || p.model.trim() === o,
  )
  if (byProfileName) {
    return {
      provider: byProfileName.provider,
      model: byProfileName.model,
      baseUrl: byProfileName.baseUrl,
      apiKey: byProfileName.apiKey,
      displayName: displayNameOf(byProfileName),
    }
  }

  // A bare model id — ride on the active vendor's endpoint + key.
  const base = resolveActiveModel(llm)
  return { ...base, model: o, displayName: o }
}

/**
 * Heuristic context-window size (tokens) for the header usage chip (追加⑯),
 * keyed on the model name: Claude → 200k, Gemini → 1M, anything else
 * (OpenAI-compatible relays, DeepSeek, …) a conservative 128k. Guesses only
 * — the chip signals headroom, not a contract.
 */
export function resolveContextWindow(
  model: string,
  explicit?: number,
): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const m = (model ?? '').toLowerCase()
  if (/claude/.test(m)) return 200_000
  if (/gemini/.test(m)) return 1_000_000
  return 128_000
}

/**
 * Name-pattern heuristic: infer capability flags from a model name. Returns
 * ONLY matched flags (sparse) — undefined means "no opinion". Used for fetched
 * / unknown models so the user gets sensible defaults they can override.
 */
export function inferCapabilities(
  modelName: string,
): Partial<ModelCapabilities> {
  const m = (modelName ?? '').toLowerCase()
  const caps: Partial<ModelCapabilities> = {}
  if (/vl|vision|gpt-4o|claude-3|gemini.*pro|multimodal|qwenvl/.test(m)) {
    caps.vision = true
  }
  if (/reasoner|r1|o1|o3|thinking|deepseek-r/.test(m)) {
    caps.reasoning = true
  }
  if (/image|dall|flux|sd-|stable-diffusion/.test(m)) {
    caps.imageGen = true
  }
  if (/embedding|bge-|m3e|gte-|e5-/.test(m)) {
    caps.embedding = true
  }
  if (/search/.test(m)) {
    caps.webSearch = true
  }
  return caps
}

/** Look up a preset's authored capabilities for a model name (if any). */
function presetCapabilities(
  presetId: string | undefined,
  modelName: string,
): Partial<ModelCapabilities> | undefined {
  if (!presetId) return undefined
  const preset = VENDOR_PRESETS.find((p) => p.id === presetId)
  if (!preset) return undefined
  const mp = preset.models.find((m) => m.name === modelName)
  return mp?.capabilities
}

/**
 * Migration-free capability derivation: if the model has explicit capabilities,
 * use them; otherwise derive from the preset map ∪ name heuristic. This lets
 * already-saved models (no capabilities field) behave correctly without
 * re-opening the vendor config — e.g. a saved qwen-vl-plus still routes for
 * vision, a saved qwen-plus still carries the webSearch flag through.
 */
export function resolveCapabilities(
  vendor: ModelVendor,
  model: VendorModel,
): ModelCapabilities | undefined {
  if (model.capabilities) return model.capabilities
  const fromPreset = presetCapabilities(vendor.presetId, model.name)
  const fromHeuristic = inferCapabilities(model.name)
  const merged: ModelCapabilities = { ...fromPreset, ...fromHeuristic }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Resolve a vision-capable model for image-attachment messages. Priority:
 * 1. llm.activeVisionModelId — if it resolves to a model with vision:true
 *    (explicit or derived), use it.
 * 2. The first vision-capable model across all vendors.
 * 3. null — no vision model configured; caller falls back to the default.
 *
 * Returns the vendor-model id (usable as a session override) or null. Pure —
 * testable without an App.
 */
export function resolveVisionModel(
  llm: LLMSettings,
): string | null {
  // 1. The configured default vision model, if it's actually vision-capable.
  if (llm.activeVisionModelId) {
    const hit = findVendorModel(llm, llm.activeVisionModelId)
    if (hit && resolveCapabilities(hit.vendor, hit.model)?.vision) {
      return hit.model.id
    }
  }
  // 2. First vision-capable model across all vendors.
  for (const v of llm.vendors) {
    for (const m of v.models) {
      if (resolveCapabilities(v, m)?.vision) return m.id
    }
  }
  return null
}

/**
 * Resolve the embedding model for semantic retrieval (与视觉/生图同款：
 * 统一厂商列表)。优先级：
 * 1. llm.activeEmbeddingModelId — 若该模型带 embedding 能力（显式或推断）；
 * 2. 全部厂商里第一个带 embedding 能力的模型；
 * 3. null — 未配置任何检索模型（语义通道保持未就绪）。
 * Pure — testable without an App.
 */
export function resolveEmbeddingModel(llm: LLMSettings): ResolvedModel | null {
  const toResolved = (vendor: ModelVendor, model: VendorModel): ResolvedModel => ({
    provider: vendor.provider,
    apiMode: vendor.apiMode,
    model: model.name,
    baseUrl: vendor.baseUrl,
    apiKey: vendor.apiKey,
    displayName: vendorDisplayName(vendor, model),
    capabilities: resolveCapabilities(vendor, model),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  })
  // 1. Explicit selection, if it actually carries the embedding capability.
  if (llm.activeEmbeddingModelId) {
    const hit = findVendorModel(llm, llm.activeEmbeddingModelId)
    if (hit && resolveCapabilities(hit.vendor, hit.model)?.embedding) {
      return toResolved(hit.vendor, hit.model)
    }
  }
  // 2. First embedding-capable model across all vendors.
  for (const v of llm.vendors) {
    for (const m of v.models) {
      if (resolveCapabilities(v, m)?.embedding) return toResolved(v, m)
    }
  }
  return null
}

/**
 * One-time migration for v1 data.json: when the legacy single-provider block
 * is filled but no profiles exist yet, lift it into a profile so existing
 * setups show up in the profile editor and the /model picker. Pure — returns
 * a (possibly new) settings object; the legacy fields are kept as-is.
 */
export function migrateLlmBlock(llm: LLMSettings): LLMSettings {
  if (llm.profiles.length > 0) return llm
  if (!llm.model.trim() && !llm.apiKey.trim() && !llm.baseUrl.trim()) {
    return llm // nothing configured — leave the clean default alone
  }
  const profile: ModelProfile = {
    id: genProfileId(),
    name: llm.model.trim() || llm.provider || '默认模型',
    provider: llm.provider || 'openai-compatible',
    model: llm.model,
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
  }
  return { ...llm, profiles: [profile], activeProfileId: profile.id }
}

/**
 * Migration to the VENDOR → MODELS shape (追加⑱ 补刀): lift legacy flat
 * profiles into vendors (each profile becomes a vendor with one model, so the
 * old activeProfileId maps to that model). Pure — old fields stay as-is.
 */
export function migrateLlmVendors(llm: LLMSettings): LLMSettings {
  if (llm.vendors.length > 0) return llm
  if (llm.profiles.length === 0) return llm
  const vendors: ModelVendor[] = llm.profiles.map((p) => ({
    id: genVendorId(),
    name: p.name.trim() || p.provider,
    provider: p.provider,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    models: [{ id: genModelId(), name: p.model }],
  }))
  const defaultModel =
    (() => {
      const idx = llm.profiles.findIndex((p) => p.id === llm.activeProfileId)
      if (idx < 0) return vendors[0]?.models[0]?.id ?? null
      return vendors[idx]?.models[0]?.id ?? null
    })()
  return { ...llm, vendors, activeModelId: defaultModel }
}

/** Migration for the image block: lift the legacy single image provider into
 *  a vendor so the new VENDOR → MODELS image editor sees it. */
export function migrateImageVendors(image: ImageSettings): ImageSettings {
  if (image.vendors.length > 0) return image
  if (!image.model.trim()) return image
  return {
    ...image,
    vendors: [
      {
        id: genVendorId(),
        name: '默认生图厂商',
        provider: image.provider || 'openai-images',
        baseUrl: image.baseUrl,
        apiKey: image.apiKey,
        models: [{ id: genModelId(), name: image.model }],
      },
    ],
    activeModelId: null,
  }
}

/**
 * 追加㉗：生图厂商与对话厂商合并为一份统一列表。
 *
 * image.vendors（以及用户真正填过的旧扁平生图块）整体搬进 llm.vendors，
 * 每个模型强制打上 imageGen 能力标记（供 resolveActiveImage 与「默认生图
 * 模型」选择器检索）；搬完后 image.vendors 清空——迁移幂等，只生效一次。
 * 空配置的默认扁平块（apiKey/baseUrl 全空）不搬，避免新装用户凭空多出
 * 一个「默认生图厂商」。image.activeModelId 按模型 id 保留，继续有效。
 */
export function mergeImageVendorsIntoLlm(
  llm: LLMSettings,
  image: ImageSettings,
): { llm: LLMSettings; image: ImageSettings } {
  let toMove = image.vendors
  if (
    toMove.length === 0 &&
    image.model.trim() &&
    (image.apiKey.trim() || image.baseUrl.trim())
  ) {
    toMove = [
      {
        id: genVendorId(),
        name: '默认生图厂商',
        provider: image.provider || 'openai-images',
        baseUrl: image.baseUrl,
        apiKey: image.apiKey,
        models: [{ id: genModelId(), name: image.model }],
      },
    ]
  }
  if (toMove.length === 0) {
    return { llm, image: { ...image, vendors: [] } }
  }
  // 旧版 migrateImageVendors 会给每个用户凭空造一个空地址空密钥的「默认
  // 生图厂商」（默认 model 名非空即提升）——这种从未配置过的幽灵厂商
  // 直接丢弃，不搬进统一列表。
  toMove = toMove.filter((v) => v.apiKey.trim() || v.baseUrl.trim())
  if (toMove.length === 0) {
    return { llm, image: { ...image, vendors: [] } }
  }
  // 追加㊹：按厂商 id 去重——多实例保存竞争等极端路径可能把未迁移完的
  // image.vendors 与已含同一厂商的 llm.vendors 拼在一起，重复搬运只会
  // 堆出同 id 的孪生厂商，一律跳过。
  const existing = new Set(llm.vendors.map((v) => v.id))
  toMove = toMove.filter((v) => !existing.has(v.id))
  if (toMove.length === 0) {
    return { llm, image: { ...image, vendors: [] } }
  }
  const moved: ModelVendor[] = toMove.map((v) => ({
    ...v,
    models: v.models.map((m) => ({
      ...m,
      capabilities: { ...(m.capabilities ?? {}), imageGen: true },
    })),
  }))
  return {
    llm: { ...llm, vendors: [...llm.vendors, ...moved] },
    image: { ...image, vendors: [] },
  }
}

export interface ImageSettings {
  /** Configured vendors for image generation (shared shape with chat). */
  vendors: ModelVendor[]
  /** Which vendor-model is the image model. */
  activeModelId: string | null
  /** e.g. "1024x1024". Empty = provider default. */
  size: string
  /** Vault folder for generated images. Empty = Obsidian's attachment folder. */
  attachmentFolder: string
  /**
   * Legacy single-image-provider fields (migration source / fallback).
   */
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/**
 * Resolve the image-generation model (追加㉗：统一厂商列表)。优先级：
 * 1. image.activeModelId 指定的模型（在 llm.vendors 里按 id 找）；
 * 2. 全部厂商里第一个带 imageGen 能力的模型；
 * 3. 旧 data.json 未迁移完的 image.vendors / 扁平块兼容兜底（Key 空时
 *    复用对话模型 Key）。size/保存文件夹仍在 ImageSettings 里。
 */
export function resolveActiveImage(
  image: ImageSettings,
  llm: LLMSettings,
): ResolvedModel {
  // 1. Explicit selection across the unified vendor list.
  if (image.activeModelId) {
    for (const v of llm.vendors) {
      const m = v.models.find((m) => m.id === image.activeModelId)
      if (m) return vendorModelToResolved(v, m)
    }
  }
  // 2. First imageGen-capable model anywhere.
  for (const v of llm.vendors) {
    for (const m of v.models) {
      if (resolveCapabilities(v, m)?.imageGen) return vendorModelToResolved(v, m)
    }
  }
  // 3. Legacy image-only vendors (pre-merge data).
  for (const v of image.vendors) {
    if (v.models.length === 0) continue
    const m = image.activeModelId
      ? v.models.find((m) => m.id === image.activeModelId)
      : undefined
    const hit = m ?? v.models[0]
    if (hit) return vendorModelToResolved(v, hit)
  }
  // 4. Legacy flat block.
  const legacyKey = image.apiKey || resolveActiveModel(llm).apiKey
  return {
    provider: image.provider,
    model: image.model,
    baseUrl: image.baseUrl,
    apiKey: legacyKey,
    displayName: image.model,
  }
}

function vendorModelToResolved(v: ModelVendor, m: VendorModel): ResolvedModel {
  return {
    provider: v.provider,
    apiMode: v.apiMode,
    model: m.name,
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    displayName: m.name,
    capabilities: resolveCapabilities(v, m),
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
  }
}

/* ═══ 远程 MCP 服务设置 ════════════════════════════════════════════════
 * 有意识的边界（对「v1 不做 MCP」决策的修订）：只支持 streamableHttp
 * 传输 + tools 面（initialize / tools/list / tools/call 三个方法）。
 * 不做 stdio/WebSocket、OAuth、resources/prompts/sampling、会话恢复。
 * ════════════════════════════════════════════════════════════════════ */

/** Cached metadata of one remote MCP tool (from the last tools/list). */
export interface McpToolMeta {
  name: string
  description?: string
  /** JSON Schema of the tool's arguments as declared by the server. */
  inputSchema?: Record<string, unknown>
}

/** One configured streamableHttp MCP service. */
export interface McpService {
  id: string
  /** Display name; also prefixes the registered tool names. */
  name: string
  baseUrl: string
  /** Full Authorization header value, e.g. `Bearer sk-xxx`. */
  authHeader: string
  enabled: boolean
  /** Tool metadata cached from the last successful tools/list refresh. */
  tools?: McpToolMeta[]
  /**
   * Official (plugin-shipped) service: can be toggled and edited (fill in
   * the key) but NEVER deleted from the UI. Matched by baseUrl on load.
   */
  official?: boolean
}

export interface McpSettings {
  services: McpService[]
}

/**
 * Plugin-shipped MCP services. Seeded on FIRST launch only (data.json has no
 * mcp block yet); once the block exists it is never re-seeded — deleting an
 * official service stays deleted (same no-resurrect discipline as brain
 * files). Existing installs get their manually-added copy adopted (marked
 * official) via baseUrl match.
 */
export const OFFICIAL_MCP_SERVICES: McpService[] = [
  {
    id: 'official-bailian-websearch',
    name: 'bailian-websearch',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp',
    authHeader: '',
    enabled: true,
    official: true,
  },
]

/**
 * Idempotent adoption: mark configured services whose baseUrl matches an
 * official endpoint as official (covers users who added the same service by
 * hand before official seeding existed). Pure — testable.
 */
export function adoptOfficialMcpServices(mcp: McpSettings): McpSettings {
  for (const service of mcp.services) {
    if (service.official) continue
    const hit = OFFICIAL_MCP_SERVICES.find(
      (o) => o.baseUrl === service.baseUrl,
    )
    if (hit) {
      service.official = true
      service.id = hit.id
    }
  }
  return mcp
}

/** Hard cap on TOTAL registered MCP tools across all services — every tool
 *  schema rides along in each LLM request, so a bloated server must not be
 *  able to tax every turn. Excess tools are dropped at registration time. */
export const MAX_MCP_TOOLS = 8

/** Short unique id for an MCP service (persisted). */
export function genMcpServiceId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ── Retrieval (混合检索) ──────────────────────────────────────────── */
/* 铁律2 修订版：关键词+元数据仍是主通道；允许远程 embedding API + 本地向量
 * 存储的混合检索，但 embedding 计算必须走远程 HTTP（禁本地算力）。 */

/** Default OpenAI-compatible embedding endpoint (百炼兼容模式). */
export const DEFAULT_EMBEDDING_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** Default embedding model (百炼 text-embedding-v4，1024 维). */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v4'

export interface RetrievalSettings {
  /** Master switch for the semantic (vector) retrieval channel. */
  semanticEnabled: boolean
  /** Legacy 扁平 embedding 三字段——已并入统一厂商列表（模型页挑「默认
   *  检索模型」，migrateRetrievalEmbeddingIntoLlm 幂等搬运）。字段保留以
   *  保数据迁移安全，UI 不再暴露；迁移后恢复默认空值。 */
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
}

/**
 * 一次性迁移：旧 retrieval 扁平三字段（端点/密钥/模型）提升进统一厂商
 * 列表——与 mergeImageVendorsIntoLlm（追加㉗）同款纪律。仅当用户真正填过
 * embeddingApiKey 才搬（空默认块不搬，避免新装用户凭空多出一个厂商）；
 * 模型强制打上 embedding 能力并设为默认检索模型。搬完三字段恢复默认值，
 * 迁移幂等（key 空即不再触发）；semanticEnabled 原样保留。
 */
export function migrateRetrievalEmbeddingIntoLlm(
  llm: LLMSettings,
  retrieval: RetrievalSettings,
): { llm: LLMSettings; retrieval: RetrievalSettings } {
  if (!retrieval.embeddingApiKey.trim()) return { llm, retrieval }
  const model: VendorModel = {
    id: genModelId(),
    name: retrieval.embeddingModel.trim() || DEFAULT_EMBEDDING_MODEL,
    capabilities: { embedding: true },
  }
  const vendor: ModelVendor = {
    id: genVendorId(),
    name: '检索 Embedding 厂商',
    provider: 'openai-compatible',
    baseUrl: retrieval.embeddingBaseUrl.trim() || DEFAULT_EMBEDDING_BASE_URL,
    apiKey: retrieval.embeddingApiKey.trim(),
    models: [model],
  }
  return {
    llm: {
      ...llm,
      vendors: [...llm.vendors, vendor],
      activeEmbeddingModelId: model.id,
    },
    retrieval: {
      semanticEnabled: retrieval.semanticEnabled,
      embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL,
      embeddingApiKey: '',
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
    },
  }
}

/**
 * 桌面专属 hermes 集成设置。两个入口共用此块：/hermes 任务分发
 * （把复杂任务交给本机 hermes ACP 会话，结果进对话历史）与
 * engine: hermes 子代理会话。铁律一修订版：本地进程仅限桌面端
 * （Platform.isMobile 门控 + ACP 连接层懒加载 require 守卫），移动端
 * 代码路径永远不触碰 Node API。
 * 历史：补刀·五十四曾在此块上挂 `hermes -z` one-shot 工具
 * run_local_agent，能力门控收口时已移除（/hermes 任务分发取代它）；
 * 设置字段全部保留（ACP 会话仍在用，旧 data.json 无缝兼容）。
 */

/** 交互式会话的审批策略（hermes session/set_mode）——与主 agent 共用同一
 *  套模式枚举（core/agent/approval.ts，M2-T8 还原）。
 *  default = 危险操作与文件编辑每次都问；
 *  accept_edits = vault 内的文件编辑自动放行，危险命令仍问；
 *  dont_ask = 除敏感路径（.git/.ssh/.env/密钥）外全自动放行。 */
export type HermesApprovalMode = ApprovalModeId

export interface LocalAgentSettings {
  /** 总开关。关闭后 /hermes / hermes 引擎会话直接报不可用；右上角的
   *  Hermes 模式按钮（固定「Hermes」字样，点击切换 Hermes ⇄ 主对话模式）
   *  也只在此开关开启时出现——按钮与集成开关保持一致，不随 Hermes
   *  窗口是否打开变化。 */
  enabled: boolean
  /** hermes CLI 命令或完整路径；'' = 用 PATH 里的 `hermes`。 */
  command: string
  /** 墙钟超时（毫秒）。hermes 自身没有内置超时，必须由父进程兜底。 */
  timeoutMs: number
  /** 交互式会话的审批策略（hermes session/set_mode）：
   *  default = 危险操作与文件编辑每次都问；
   *  accept_edits = vault 内的文件编辑自动放行，危险命令仍问；
   *  dont_ask = 除敏感路径（.git/.ssh/.env/密钥）外全自动放行。 */
  approvalMode: HermesApprovalMode
  /** 交互式会话的默认模型覆盖（'provider:model' 形式）；'' = 用 hermes
   *  自己 config.yaml 配置的模型。 */
  model: string
  /** M2-T3 首次认证引导：无凭据时展示的配置指引入口（URL 或文档地址）。
   *  '' = 指引只含本机终端自助步骤。**为 M3 托管端点预留**——代码里禁止
   *  硬编码任何指引 URL，指引文案构造（core/hermes/authGuide.ts）只读
   *  这个设置项。旧 data.json 无此键时经按块 spread 合并取缺省 ''。 */
  guidedEndpoint: string
  /** 项目会话 ID。首次连接 hermes 时自动创建，之后所有插件触发的 hermes
   *  对话都通过 session/fork 从该项目派生。存储在 settings 而非对话文件，
   *  因为它是 vault 级而非对话级。 */
  projectSessionId: string
  /** 启动后台预热（补刀·六十）：开 = Obsidian 启动后立即后台连接 hermes
   *  并预备会话（状态灯几秒后变绿，首次发送零等待）；关 = 按需连接——
   *  重启后保持灰色（未连接），切入 Hermes 模式/开始使用时才连接（首次
   *  使用多等几秒，但不用 hermes 时不拉起进程）。仅管启动时那一次；
   *  交互触发的预热（切模式/打开会话/输入）不受此开关影响。 */
  autoWarmup: boolean
}

export const DEFAULT_LOCAL_AGENT_TIMEOUT_MS = 10 * 60 * 1000

export interface ObsidianAISettings {
  llm: LLMSettings
  image: ImageSettings
  safety: SafetySettings
  skills: SkillSettings
  agents: AgentSettings
  general: GeneralSettings
  mcp: McpSettings
  retrieval: RetrievalSettings
  localAgent: LocalAgentSettings
}

/** Top-level settings blocks, used for blockwise save merging (追加㊹). */
export const SETTINGS_BLOCKS: Array<keyof ObsidianAISettings> = [
  'llm',
  'image',
  'safety',
  'skills',
  'agents',
  'general',
  'mcp',
  'retrieval',
  'localAgent',
]

/** Settings are plain JSON — a JSON round-trip is a cheap deep clone. */
export function cloneSettings<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 追加㊹：保存前按块合并，根治「默认生图模型自动失效」这类多实例覆盖
 * 问题。插件可能同时跑在多个实例里（另一个 vault 窗口、iCloud 同步的
 * iPad/Mac），旧实现把整个内存对象盖写回 data.json——别的实例内存里是
 * 加载时的旧快照，它那边任何一次保存都会把自己那份旧值（如空的
 * image.activeModelId）整体盖回来。
 *
 * 规则：加载后本实例**没改动过**的块取磁盘最新值（尊重别的实例的写
 * 入）；改动过的块以本实例内存为准。snapshot = loadSettings 完成时的深
 * 拷贝，current = 当前内存，disk = 保存前刚读的 data.json。
 */
export function mergeSettingsForSave(
  snapshot: ObsidianAISettings,
  current: ObsidianAISettings,
  disk: Partial<ObsidianAISettings> | null | undefined,
): ObsidianAISettings {
  const out = cloneSettings(current)
  if (!disk) return out
  for (const key of SETTINGS_BLOCKS) {
    const diskBlock = disk[key]
    if (!diskBlock) continue
    const untouched =
      JSON.stringify(snapshot[key]) === JSON.stringify(current[key])
    if (untouched) {
      // 键序一致时 JSON.stringify 结果稳定；块对象从同一合并模板构造，
      // 原地修改不改变键序，比较可靠。
      ;(out as unknown as Record<string, unknown>)[key] = cloneSettings(diskBlock)
    }
  }
  return out
}

export interface GeneralSettings {
  /**
   * Extra vault folders excluded from the @-mention picker and search_notes.
   * Obsidian's own "Excluded files" list (userIgnoreFilters) ALWAYS applies
   * on top of this — this is custom additions only.
   */
  excludedFolders: string[]
  /**
   * Base folder for AI data: the three evolution files (agent.md / user.md /
   * memory.md) and the persisted conversation history (conversations/) live
   * under it. Relative to the vault root. VISIBLE by default ("AI 助手",
   * 追加⑲) so the user can browse and edit the evolution files directly;
   * legacy installs used the hidden ".obsidian-ai" (auto-migrated on load).
   * The skills folder defaults to sitting under this but has its own setting
   * (技能面板) and does NOT move automatically when this changes.
   */
  aiFolder: string
  /**
   * Auto-exclude aiFolder from the @-mention picker and search_notes so AI
   * data files (memory, conversations, skills) don't pollute note results.
   */
  hideAiFolder: boolean
  /**
   * Chat bubble role labels (default 你 / AI), 追加⑱. Pure UI — the LLM still
   * receives the plain message content regardless of these.
   */
  userName: string
  assistantName: string
  /**
   * Max substantive tool turns per agent run (Task #8). Clamped to 4–24 at
   * the call site; the runner still grants a few budget-free todo_write
   * turns and a soft wrap-up beyond this.
   */
  maxToolTurns: number
  /**
   * How @-mentioned notes ([[笔记]]) travel to the LLM (Task #8):
   * 'link' = keep the bare link (the model reads it itself via read_note);
   * 'excerpt' / 'full' = inline the note body into the sent user message
   * (budgeted, see utils/refContext.ts). Persisted message content is never
   * touched — the expansion only decorates the copy handed to the LLM.
   */
  mentionInline: 'link' | 'excerpt' | 'full'
  /**
   * Diagnostic log master switch (诊断日志). DEFAULT FALSE = the logger in
   * utils/diagnosticLog.ts is a complete no-op (zero disk I/O, zero buffer).
   * When enabled, runtime activity is recorded to the plugin's own config dir
   * and can be exported as a note for bug reports. Privacy contract: never
   * logs API keys, request bodies, note contents or user message text.
   */
  diagnostics: boolean
  /**
   * 进化 B 案（AI 反思建议）：实质对话轮结束后按节流频率（见
   * utils/reflect.ts REFLECT_TURN_GAP）跑一次低成本复盘，模型可以**建议**
   * 记忆/画像/技能条目——但绝不自动写盘：建议出现在输入框上方的确认面板，
   * 用户点确认才落盘（记忆走 save_memory 同款 store，技能走 /learn 结晶）。
   * 每次反思 = 一次额外 LLM 调用，故默认节流且可整体关闭（移动端成本）。
   */
  reflectSuggestions: boolean
  /**
   * M2-T4 命令面板隐藏名单（按引擎，用户自定义层）：命令名清单——core 引擎
   * 藏插件命令（id），hermes 引擎藏插件命令与 hermes 通告命令（name）。
   * 硬编码层（hermes 通告里对插件场景无意义的命令）在
   * core/hermes/advertisedCommands.ts，用户层只做加法、不能解禁硬编码项。
   * 旧 data.json 无此键经按块 spread 合并取缺省空名单。
   */
  hiddenCommands: { core: string[]; hermes: string[] }
}

export interface SafetySettings {
  /**
   * 审批模式（主 agent；与 hermes 同套语义，/mode 命令双引擎可切）：
   * default = 破坏性操作每次弹审批面板；accept_edits = 编辑类（category
   * 'write'）自动放行，删除/移动等仍弹；dont_ask = 全部放行。
   * delete_note 永远强制确认（forceConfirm 铁律，任何模式不豁免）。
   */
  approvalMode: ApprovalModeId
  /**
   * Legacy v1 布尔开关（「破坏性操作是否确认」）。被 approvalMode 取代后
   * 不再被 UI 读写；schema 保留供旧 data.json 无缝合并，迁移
   * （migrateSafetyApprovalMode）一次性把 false 语义搬进
   * approvalMode='dont_ask' 并复位为 true（防二次迁移覆盖用户新选择）。
   */
  confirmDestructive: boolean
}

/**
 * 一次性迁移：旧 confirmDestructive 布尔 → 审批模式。false（旧「不确认」
 * 语义）提升为 dont_ask 并复位布尔为 true——幂等：迁移后布尔已 true，
 * 重复加载不再触发，用户之后用 /mode 或设置页切换任意模式都有效。
 * 纯函数；旧字段保留在 schema（降级回退兼容）。
 */
export function migrateSafetyApprovalMode(
  safety: SafetySettings,
): SafetySettings {
  if (safety.confirmDestructive !== false) return safety
  return { ...safety, approvalMode: 'dont_ask', confirmDestructive: true }
}

export interface SkillSettings {
  /** Master switch: expose skills to the AI at all. */
  enabled: boolean
  /** Names of skills (builtin or user) the user turned off. */
  disabled: string[]
}

/**
 * Settings key of the MAIN agent — the conversation agent that has no
 * agentId (every sub-agent is keyed by its persona-note name instead).
 * The main agent ships with the plugin, cannot be deleted, and defaults
 * to every globally-enabled tool.
 */
export const MAIN_AGENT_KEY = '__main__'

/** Per-agent overrides on top of the global pools (keyed by agent name,
 *  MAIN_AGENT_KEY for the main agent). */
export interface AgentOverrides {
  /** Tool names this agent additionally turns off (subset of the global pool). */
  disabledTools?: string[]
  /** Skill names this agent additionally turns off (on top of the global list). */
  disabledSkills?: string[]
  /** 追加87: MCP 服务 id 名单——该 agent 额外关闭的远程 MCP 服务
   *  （服务级开关，服务下全部工具随之失效；全局开关在 mcp.services[].enabled）。 */
  disabledMcp?: string[]
}

export interface AgentSettings {
  /** Master switch: expose sub-agents (agents/ persona notes) at all. */
  enabled: boolean
  /** Names of sub-agents the user turned off. */
  disabled: string[]
  /**
   * Tools turned off GLOBALLY — the 通用 tool pool every agent picks from.
   * An agent's effective tool set = all tools − this list − its own
   * disabledTools override. The main agent defaults to the full pool.
   */
  disabledTools: string[]
  /** Per-agent overrides keyed by agent name (MAIN_AGENT_KEY = main agent). */
  perAgent: Record<string, AgentOverrides>
}

/** The override block for one agent (empty object when unset). */
export function agentOverrides(
  agents: AgentSettings,
  agentKey: string,
): AgentOverrides {
  return agents.perAgent[agentKey] ?? {}
}

/**
 * Effective tool switch for one agent: the global pool first (通用), then
 * the agent's own narrowed-down selection on top. Pure — testable.
 */
export function isToolEnabledForAgent(
  agents: AgentSettings,
  agentKey: string,
  toolName: string,
): boolean {
  if (agents.disabledTools.includes(toolName)) return false
  return !(agents.perAgent[agentKey]?.disabledTools ?? []).includes(toolName)
}

/** Per-agent skill switch (does NOT re-check the global skills list — the
 *  caller composes the two). */
export function isSkillEnabledForAgent(
  agents: AgentSettings,
  agentKey: string,
  skillName: string,
): boolean {
  return !(agents.perAgent[agentKey]?.disabledSkills ?? []).includes(skillName)
}

/** Mutate one agent's tool override in place (settings object is live). */
export function setAgentTool(
  agents: AgentSettings,
  agentKey: string,
  toolName: string,
  on: boolean,
): void {
  const entry = (agents.perAgent[agentKey] ??= {})
  const list = new Set(entry.disabledTools ?? [])
  if (on) list.delete(toolName)
  else list.add(toolName)
  entry.disabledTools = Array.from(list)
}

/** Mutate one agent's skill override in place (settings object is live). */
export function setAgentSkill(
  agents: AgentSettings,
  agentKey: string,
  skillName: string,
  on: boolean,
): void {
  const entry = (agents.perAgent[agentKey] ??= {})
  const list = new Set(entry.disabledSkills ?? [])
  if (on) list.delete(skillName)
  else list.add(skillName)
  entry.disabledSkills = Array.from(list)
}

/** 追加87: Per-agent MCP service switch (does NOT re-check the global
 *  service toggle — the caller composes the two, mirroring skills). */
export function isMcpEnabledForAgent(
  agents: AgentSettings,
  agentKey: string,
  serviceId: string,
): boolean {
  return !(agents.perAgent[agentKey]?.disabledMcp ?? []).includes(serviceId)
}

/** 追加87: Mutate one agent's MCP service override in place — idempotent,
 *  same shape as setAgentTool/setAgentSkill. */
export function setAgentMcp(
  agents: AgentSettings,
  agentKey: string,
  serviceId: string,
  on: boolean,
): void {
  const entry = (agents.perAgent[agentKey] ??= {})
  const list = new Set(entry.disabledMcp ?? [])
  if (on) list.delete(serviceId)
  else list.add(serviceId)
  entry.disabledMcp = Array.from(list)
}

export const DEFAULT_SETTINGS: ObsidianAISettings = {
  llm: {
    vendors: [],
    activeModelId: null,
    activeVisionModelId: null,
    activeEmbeddingModelId: null,
    profiles: [],
    activeProfileId: null,
    provider: 'openai-compatible',
    model: '',
    baseUrl: '',
    apiKey: '',
  },
  image: {
    vendors: [],
    activeModelId: null,
    provider: 'openai-images',
    model: 'gpt-image-1',
    baseUrl: '',
    apiKey: '',
    size: '1024x1024',
    attachmentFolder: '',
  },
  safety: {
    approvalMode: 'default',
    confirmDestructive: true,
  },
  skills: {
    enabled: true,
    disabled: [],
  },
  agents: {
    enabled: true,
    disabled: [],
    disabledTools: [],
    perAgent: {},
  },
  general: {
    excludedFolders: [],
    aiFolder: 'AI 助手',
    hideAiFolder: true,
    userName: '你',
    assistantName: 'AI',
    maxToolTurns: 8,
    mentionInline: 'excerpt',
    diagnostics: false,
    reflectSuggestions: true,
    hiddenCommands: { core: [], hermes: [] },
  },
  mcp: {
    services: [],
  },
  retrieval: {
    semanticEnabled: false,
    embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL,
    embeddingApiKey: '',
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
  },
  localAgent: {
    enabled: true,
    command: '',
    timeoutMs: DEFAULT_LOCAL_AGENT_TIMEOUT_MS,
    approvalMode: 'default',
    model: '',
    guidedEndpoint: '',
    projectSessionId: '',
    autoWarmup: true,
  },
}

/** Provider options shown in the settings dropdown, with sensible base URLs. */
export interface ProviderPreset {
  id: string
  label: string
  defaultBaseUrl: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  // 追加㉗：生图协议并入统一厂商列表（原 IMAGE_PROVIDER_PRESETS 合并于此）。
  {
    id: 'openai-images',
    label: 'OpenAI 生图',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
]

/** API mode options for openai-compatible vendors (追加㉒). */
export const API_MODE_PRESETS: ProviderPreset[] = [
  {
    id: 'chat-completions',
    label: 'Chat Completions',
    defaultBaseUrl: '',
  },
  {
    id: 'responses',
    label: 'Responses API',
    defaultBaseUrl: '',
  },
]

/* 追加㉗：IMAGE_PROVIDER_PRESETS 已并入 PROVIDER_PRESETS（openai-images 项），
 * 导出保留为别名以免外部引用断裂。 */
export const IMAGE_PROVIDER_PRESETS: ProviderPreset[] = [
  PROVIDER_PRESETS.find((p) => p.id === 'openai-images')!,
]

/* ════════════════════════════════════════════════════════════════════════
 *  厂商预设 (Vendor Presets)
 *  预置 7 个国内厂商，每个带可选 Base URL、常用模型、以及 extra params
 *  定义。VendorModal 读取这些预设来提供下拉选择和快捷添加。
 * ════════════════════════════════════════════════════════════════════════ */

/** A selectable Base URL option for a vendor preset. */
export interface BaseUrlOption {
  label: string
  url: string
}

/** A model preset for quick-add in the vendor modal. */
export interface ModelPreset {
  /** Model identifier sent to the API (e.g. "qwen-turbo"). */
  name: string
  /** Short description shown in the quick-add list. */
  desc?: string
  /** Known capabilities (preset-authored). */
  capabilities?: ModelCapabilities
  /** Known context window. */
  contextWindow?: number
  /** Known max output tokens. */
  maxOutputTokens?: number
}

/** A vendor preset: pre-configured name, protocol, URLs and models. */
export interface VendorPreset {
  /** Stable identifier (e.g. "bailian"). */
  id: string
  /** Display name (e.g. "百炼"). */
  name: string
  /** Wire protocol. */
  provider: string
  /** Available Base URLs. */
  baseUrls: BaseUrlOption[]
  /** Quick-add model presets (suggestion seeds for the combobox). */
  models: ModelPreset[]
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrls: [{ label: '官方', url: 'https://api.deepseek.com' }],
    models: [
      { name: 'deepseek-chat', desc: '通用对话 (V3)', capabilities: { tools: true }, contextWindow: 64000 },
      { name: 'deepseek-reasoner', desc: '推理模型 (R1)', capabilities: { reasoning: true }, contextWindow: 64000 },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱',
    provider: 'openai-compatible',
    baseUrls: [{ label: '官方', url: 'https://open.bigmodel.cn/api/paas/v4' }],
    models: [
      { name: 'glm-4-plus', desc: '旗舰', capabilities: { tools: true }, contextWindow: 128000 },
      { name: 'glm-4-air', desc: '轻量', capabilities: { tools: true }, contextWindow: 128000 },
      { name: 'glm-4-flash', desc: '免费', capabilities: { tools: true }, contextWindow: 128000 },
      { name: 'glm-4v', desc: '视觉', capabilities: { vision: true, tools: true }, contextWindow: 128000 },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    provider: 'openai-compatible',
    baseUrls: [{ label: '官方', url: 'https://api.moonshot.cn/v1' }],
    models: [
      { name: 'moonshot-v1-8k', desc: '8K 上下文', capabilities: { tools: true }, contextWindow: 8192 },
      { name: 'moonshot-v1-32k', desc: '32K 上下文', capabilities: { tools: true }, contextWindow: 32768 },
      { name: 'moonshot-v1-128k', desc: '128K 长文本', capabilities: { tools: true }, contextWindow: 131072 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    provider: 'openai-compatible',
    baseUrls: [{ label: '官方', url: 'https://api.minimax.chat/v1' }],
    models: [
      { name: 'MiniMax-Text-01', desc: '旗舰', capabilities: { tools: true }, contextWindow: 1000000 },
      { name: 'abab6.5s-chat', desc: '对话', capabilities: { tools: true }, contextWindow: 245760 },
    ],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    provider: 'openai-compatible',
    baseUrls: [{ label: '官方', url: 'https://api.siliconflow.cn/v1' }],
    models: [
      { name: 'deepseek-ai/DeepSeek-V3', desc: 'DeepSeek V3', capabilities: { tools: true }, contextWindow: 64000 },
      { name: 'Qwen/Qwen2.5-72B-Instruct', desc: '通义千问 72B', capabilities: { tools: true }, contextWindow: 131072 },
      { name: 'Qwen/Qwen2.5-Coder-32B-Instruct', desc: '代码 32B', capabilities: { tools: true }, contextWindow: 131072 },
    ],
  },
  {
    id: 'bailian',
    name: '百炼',
    provider: 'openai-compatible',
    baseUrls: [
      { label: '兼容模式（国内）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: '兼容模式（国际）', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    ],
    models: [
      { name: 'qwen-turbo', desc: '快速 · 1M 上下文', capabilities: { tools: true, webSearch: true }, contextWindow: 1000000 },
      { name: 'qwen-plus', desc: '均衡 · 1M 上下文', capabilities: { tools: true, webSearch: true }, contextWindow: 1000000 },
      { name: 'text-embedding-v4', desc: '文本向量化（语义检索）', capabilities: { embedding: true } },
      { name: 'qwen-max', desc: '旗舰', capabilities: { tools: true, webSearch: true }, contextWindow: 32768 },
      { name: 'qwen-max-latest', desc: '旗舰最新版', capabilities: { tools: true, webSearch: true }, contextWindow: 32768 },
      // Responses API 仅支持 qwen3 系列旗舰（官方文档口径）；联网搜索需将
      // 厂商协议模式切到 Responses API，webSearch 能力位会注入 web_search 内置工具。
      { name: 'qwen3-max', desc: '旗舰 · Responses 联网搜索', capabilities: { tools: true, webSearch: true } },
      { name: 'qwen3.7-max', desc: '支持 Responses 联网搜索', capabilities: { tools: true, webSearch: true } },
      { name: 'qwen-long', desc: '长文本 · 1M 上下文', capabilities: { tools: true, webSearch: true }, contextWindow: 10000000 },
      { name: 'qwen-vl-plus', desc: '视觉理解', capabilities: { vision: true, tools: true }, contextWindow: 131072 },
      { name: 'qwen-vl-max', desc: '视觉旗舰', capabilities: { vision: true, tools: true }, contextWindow: 32768 },
    ],
  },
  {
    id: 'qwen',
    name: '千问',
    provider: 'openai-compatible',
    baseUrls: [
      { label: '兼容模式（国内）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: '兼容模式（国际）', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    ],
    models: [
      { name: 'qwen2.5-7b-instruct', desc: '7B 开源', capabilities: { tools: true, webSearch: true }, contextWindow: 32768 },
      { name: 'qwen2.5-72b-instruct', desc: '72B 开源', capabilities: { tools: true, webSearch: true }, contextWindow: 131072 },
      { name: 'qwen2.5-coder-32b-instruct', desc: '代码 32B', capabilities: { tools: true }, contextWindow: 131072 },
    ],
  },
]
