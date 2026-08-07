// Per-model capability system: heuristic inference, migration-free resolution,
// vision model resolution, and pass-through to ResolvedModel.
//
// Design:
// - tools/reasoning default TRUE (undefined = true) for backward compat
// - vision/imageGen/webSearch/jsonMode/fileUnderstanding default FALSE (opt-in)
// - resolveCapabilities: model.capabilities → preset map → name heuristic
// - Old data.json entries without capabilities fields still work correctly

import {
  LLMSettings,
  ModelVendor,
  VendorModel,
  inferCapabilities,
  resolveCapabilities,
  resolveVisionModel,
  resolveActiveModel,
  resolveSessionModel,
} from '../settings'

/* ── inferCapabilities — name-pattern heuristic ────────────────── */

describe('inferCapabilities', () => {
  it('detects vision models by name pattern', () => {
    expect(inferCapabilities('gpt-4o')).toEqual({ vision: true })
    expect(inferCapabilities('qwen-vl-plus')).toEqual({ vision: true })
    expect(inferCapabilities('claude-3-opus')).toEqual({ vision: true })
    expect(inferCapabilities('gemini-2.5-pro')).toEqual({ vision: true })
  })

  it('detects reasoning models by name pattern', () => {
    expect(inferCapabilities('deepseek-reasoner')).toEqual({ reasoning: true })
    expect(inferCapabilities('o1-preview')).toEqual({ reasoning: true })
    expect(inferCapabilities('deepseek-r1')).toEqual({ reasoning: true })
  })

  it('detects image generation models', () => {
    expect(inferCapabilities('dall-e-3')).toEqual({ imageGen: true })
    expect(inferCapabilities('gpt-image-1')).toEqual({ imageGen: true })
  })

  it('detects web search models', () => {
    expect(inferCapabilities('qwen-plus-search')).toEqual({ webSearch: true })
  })

  it('returns empty object for unremarkable names', () => {
    expect(inferCapabilities('deepseek-chat')).toEqual({})
    expect(inferCapabilities('qwen-turbo')).toEqual({})
    expect(inferCapabilities('')).toEqual({})
  })
})

/* ── resolveCapabilities — migration-free derivation ──────────── */

const mkVendor = (over: Partial<ModelVendor> = {}): ModelVendor => ({
  id: 'v1',
  name: 'TestVendor',
  provider: 'openai-compatible',
  baseUrl: 'https://api.test.com/v1',
  apiKey: 'k',
  models: [],
  ...over,
})

const mkModel = (over: Partial<VendorModel> = {}): VendorModel => ({
  id: 'm1',
  name: 'test-model',
  ...over,
})

describe('resolveCapabilities', () => {
  it('returns model.capabilities when present (explicit override)', () => {
    const vendor = mkVendor({ presetId: 'deepseek' })
    const model = mkModel({ name: 'deepseek-chat', capabilities: { tools: false } })
    expect(resolveCapabilities(vendor, model)).toEqual({ tools: false })
  })

  it('falls back to preset map when model has no capabilities', () => {
    const vendor = mkVendor({ presetId: 'deepseek' })
    const model = mkModel({ name: 'deepseek-chat' })
    // deepseek-chat preset has { tools: true }
    const caps = resolveCapabilities(vendor, model)
    expect(caps?.tools).toBe(true)
  })

  it('falls back to heuristic when preset has no match', () => {
    const vendor = mkVendor({ presetId: 'deepseek' })
    const model = mkModel({ name: 'gpt-4o' })
    // gpt-4o is not in DeepSeek preset, but heuristic detects vision
    const caps = resolveCapabilities(vendor, model)
    expect(caps?.vision).toBe(true)
    // tools is undefined — defaults to true at the provider level (caps?.tools !== false)
    expect(caps?.tools).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    const vendor = mkVendor() // no presetId
    const model = mkModel({ name: 'unknown-model' })
    expect(resolveCapabilities(vendor, model)).toBeUndefined()
  })

  it('old data.json entries work without capabilities fields', () => {
    // Simulates an old vendor config that has no capabilities on any model
    const vendor = mkVendor({ presetId: 'bailian' })
    const model = mkModel({ name: 'qwen-turbo' })
    const caps = resolveCapabilities(vendor, model)
    // qwen-turbo is in the 百炼 preset with tools + webSearch
    expect(caps?.tools).toBe(true)
    expect(caps?.webSearch).toBe(true)
  })
})

/* ── resolveVisionModel — find first vision-capable model ──────── */

describe('resolveVisionModel', () => {
  it('returns the first vision-capable model id', () => {
    const vendor1 = mkVendor({
      id: 'v1',
      models: [
        mkModel({ id: 'm1', name: 'qwen-turbo' }),
        mkModel({ id: 'm2', name: 'qwen-vl-plus' }),
      ],
    })
    const vendor2 = mkVendor({
      id: 'v2',
      models: [mkModel({ id: 'm3', name: 'gpt-4o' })],
    })
    const llm: LLMSettings = {
      vendors: [vendor1, vendor2],
      activeModelId: 'm1',
      activeVisionModelId: null,
      activeEmbeddingModelId: null,
      profiles: [],
      activeProfileId: null,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    }
    // qwen-vl-plus has vision in the 百炼 preset, but this vendor has no presetId.
    // However, the heuristic detects 'vl' → vision.
    expect(resolveVisionModel(llm)).toBe('m2')
  })

  it('returns null when no vision model exists', () => {
    const vendor = mkVendor({
      models: [mkModel({ id: 'm1', name: 'deepseek-chat' })],
    })
    const llm: LLMSettings = {
      vendors: [vendor],
      activeModelId: 'm1',
      activeVisionModelId: null,
      activeEmbeddingModelId: null,
      profiles: [],
      activeProfileId: null,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    }
    expect(resolveVisionModel(llm)).toBeNull()
  })

  it('respects explicit capabilities override', () => {
    const vendor = mkVendor({
      models: [
        mkModel({ id: 'm1', name: 'plain-model', capabilities: { vision: true } }),
      ],
    })
    const llm: LLMSettings = {
      vendors: [vendor],
      activeModelId: 'm1',
      activeVisionModelId: null,
      activeEmbeddingModelId: null,
      profiles: [],
      activeProfileId: null,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    }
    expect(resolveVisionModel(llm)).toBe('m1')
  })
})

/* ── ResolvedModel pass-through ────────────────────────────────── */

describe('resolveActiveModel capabilities pass-through', () => {
  it('passes capabilities, contextWindow, maxOutputTokens to ResolvedModel', () => {
    const vendor = mkVendor({
      models: [
        mkModel({
          id: 'm1',
          name: 'test-model',
          capabilities: { vision: true, tools: false },
          contextWindow: 32000,
          maxOutputTokens: 4096,
        }),
      ],
    })
    const llm: LLMSettings = {
      vendors: [vendor],
      activeModelId: 'm1',
      activeVisionModelId: null,
      activeEmbeddingModelId: null,
      profiles: [],
      activeProfileId: null,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    }
    const r = resolveActiveModel(llm)
    expect(r.capabilities).toEqual({ vision: true, tools: false })
    expect(r.contextWindow).toBe(32000)
    expect(r.maxOutputTokens).toBe(4096)
  })
})

describe('resolveSessionModel capabilities pass-through', () => {
  it('passes capabilities through when matching by model id', () => {
    const vendor = mkVendor({
      models: [
        mkModel({
          id: 'm1',
          name: 'vision-model',
          capabilities: { vision: true },
          contextWindow: 128000,
        }),
      ],
    })
    const llm: LLMSettings = {
      vendors: [vendor],
      activeModelId: 'm1',
      activeVisionModelId: null,
      activeEmbeddingModelId: null,
      profiles: [],
      activeProfileId: null,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    }
    const r = resolveSessionModel(llm, 'm1')
    expect(r.capabilities?.vision).toBe(true)
    expect(r.contextWindow).toBe(128000)
  })

  it('passes capabilities through when matching by vendor · model', () => {
    const vendor = mkVendor({
      id: 'v1',
      name: 'TestVendor',
      models: [
        mkModel({
          id: 'm1',
          name: 'vision-model',
          capabilities: { vision: true, tools: true },
        }),
      ],
    })
    const llm: LLMSettings = {
      vendors: [vendor],
      activeModelId: 'm1',
      activeVisionModelId: null,
      activeEmbeddingModelId: null,
      profiles: [],
      activeProfileId: null,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    }
    const r = resolveSessionModel(llm, 'TestVendor · vision-model')
    expect(r.capabilities?.vision).toBe(true)
    expect(r.capabilities?.tools).toBe(true)
  })
})
