// Settings defaults + the loadSettings merge contract: new fields added to
// DEFAULT_SETTINGS must survive loading an OLD data.json (per-block spread
// in main.ts), so upgrades never lose or drop keys. Plus the multi-profile
// model layer (追加⑨): resolution (global default / session override) and
// the legacy single-provider → profile migration.

import {
  DEFAULT_SETTINGS,
  ImageSettings,
  LLMSettings,
  MAIN_AGENT_KEY,
  McpSettings,
  ModelProfile,
  ModelVendor,
  ObsidianAISettings,
  OFFICIAL_MCP_SERVICES,
  RetrievalSettings,
  activeModel,
  activeProfile,
  adoptOfficialMcpServices,
  agentOverrides,
  cloneSettings,
  findVendorModel,
  genProfileId,
  isSkillEnabledForAgent,
  isToolEnabledForAgent,
  isMcpEnabledForAgent,
  mergeImageVendorsIntoLlm,
  mergeSettingsForSave,
  migrateImageVendors,
  migrateLlmBlock,
  migrateLlmVendors,
  migrateRetrievalEmbeddingIntoLlm,
  migrateSafetyApprovalMode,
  resolveActiveImage,
  resolveActiveModel,
  resolveContextWindow,
  resolveEmbeddingModel,
  resolveSessionModel,
  setAgentSkill,
  setAgentTool,
  setAgentMcp,
} from '../settings'

describe('DEFAULT_SETTINGS', () => {
  it('ships every general block field with a sensible default', () => {
    expect(DEFAULT_SETTINGS.general.excludedFolders).toEqual([])
    expect(DEFAULT_SETTINGS.general.aiFolder).toBe('AI 助手')
    expect(DEFAULT_SETTINGS.general.hideAiFolder).toBe(true)
    expect(DEFAULT_SETTINGS.general.userName).toBe('你')
    expect(DEFAULT_SETTINGS.general.assistantName).toBe('AI')
    // Task #8: 新增字段的默认值（工具轮数上限 / @引用内联模式）。
    expect(DEFAULT_SETTINGS.general.maxToolTurns).toBe(8)
    expect(DEFAULT_SETTINGS.general.mentionInline).toBe('excerpt')
    // 诊断日志必须默认关闭（彻底静默，零开销）——这是发布契约。
    expect(DEFAULT_SETTINGS.general.diagnostics).toBe(false)
    // 进化 B 案默认开启：复盘建议节流触发且确认后才写盘，用户可关。
    expect(DEFAULT_SETTINGS.general.reflectSuggestions).toBe(true)
  })

  it('ships the desktop localAgent block with safe defaults (补刀·五十四)', () => {
    expect(DEFAULT_SETTINGS.localAgent.enabled).toBe(true)
    expect(DEFAULT_SETTINGS.localAgent.command).toBe('')
    // 10 分钟墙钟上限——hermes 无内置超时，必须父进程兜底。
    expect(DEFAULT_SETTINGS.localAgent.timeoutMs).toBe(600000)
    // 补刀·五十六：交互式会话默认「每次都问」，模型不覆盖。
    expect(DEFAULT_SETTINGS.localAgent.approvalMode).toBe('default')
    expect(DEFAULT_SETTINGS.localAgent.model).toBe('')
  })

  it('old data.json without a localAgent block falls back to defaults', () => {
    const loaded: Partial<typeof DEFAULT_SETTINGS> = {}
    const merged = {
      ...DEFAULT_SETTINGS.localAgent,
      ...(loaded.localAgent ?? {}),
    }
    expect(merged.enabled).toBe(true)
    expect(merged.command).toBe('')
    expect(merged.timeoutMs).toBe(600000)
    expect(merged.approvalMode).toBe('default')
    expect(merged.model).toBe('')
  })

  it('ships guidedEndpoint default and survives old data.json merge (M2-T3)', () => {
    // 默认空 = 指引只含本机终端自助步骤；端点禁硬编码，只走这个设置项。
    expect(DEFAULT_SETTINGS.localAgent.guidedEndpoint).toBe('')
    // 旧 data.json 的 localAgent 块没有 guidedEndpoint 键 → 缺省合并补齐。
    const legacyBlock = {
      enabled: true,
      command: 'hermes',
      timeoutMs: 600000,
      approvalMode: 'default' as const,
      model: '',
    }
    const merged = { ...DEFAULT_SETTINGS.localAgent, ...legacyBlock }
    expect(merged.guidedEndpoint).toBe('')
    // 用户填过端点的 data.json 不被缺省值覆盖。
    const withEndpoint = { ...legacyBlock, guidedEndpoint: 'docs://setup' }
    const merged2 = { ...DEFAULT_SETTINGS.localAgent, ...withEndpoint }
    expect(merged2.guidedEndpoint).toBe('docs://setup')
  })

  it('per-block spread merge keeps new defaults on old saved data', () => {
    // Simulates main.ts loadSettings for a data.json written before
    // aiFolder / hideAiFolder / role names existed.
    const loaded: { general?: Partial<typeof DEFAULT_SETTINGS.general> } = {
      general: { excludedFolders: ['x'] },
    }
    const merged = {
      ...DEFAULT_SETTINGS.general,
      ...(loaded.general ?? {}),
    }
    expect(merged.excludedFolders).toEqual(['x'])
    expect(merged.aiFolder).toBe('AI 助手')
    expect(merged.hideAiFolder).toBe(true)
    expect(merged.userName).toBe('你')
    expect(merged.assistantName).toBe('AI')
    // Task #8: 旧 data.json（无 maxToolTurns / mentionInline）加载后
    // 必须拿到默认值，而不是 undefined。
    expect(merged.maxToolTurns).toBe(8)
    expect(merged.mentionInline).toBe('excerpt')
    // 旧 data.json 没有 diagnostics 字段时回落「关闭」，而不是 undefined。
    expect(merged.diagnostics).toBe(false)
  })

  it('saved values win over defaults', () => {
    const loaded = {
      general: { aiFolder: 'custom', hideAiFolder: false },
    } as Partial<typeof DEFAULT_SETTINGS>
    const merged = {
      ...DEFAULT_SETTINGS.general,
      ...(loaded.general ?? {}),
    }
    expect(merged.aiFolder).toBe('custom')
    expect(merged.hideAiFolder).toBe(false)
  })

  it('unknown legacy keys in data.json merge in harmlessly', () => {
    // A data.json from a build that had extra keys (e.g. a removed
    // recentModels field) must not break loading — the spread keeps them,
    // and the settings layer simply ignores what it does not declare.
    const loaded = {
      general: {
        ...DEFAULT_SETTINGS.general,
        recentModels: ['gpt-x'],
      },
    }
    const merged = {
      ...DEFAULT_SETTINGS.general,
      ...(loaded.general ?? {}),
    }
    expect(merged.aiFolder).toBe('AI 助手')
  })

  it('the llm block ships profiles + legacy fields together', () => {
    expect(DEFAULT_SETTINGS.llm.profiles).toEqual([])
    expect(DEFAULT_SETTINGS.llm.activeProfileId).toBeNull()
    expect(DEFAULT_SETTINGS.llm.provider).toBe('openai-compatible')
  })
})

describe('migrateSafetyApprovalMode（M2-T8：旧 confirmDestructive 布尔 → 审批模式）', () => {
  it('confirmDestructive=false（旧「不确认」）→ approvalMode=dont_ask 并复位布尔（幂等防二次迁移）', () => {
    const migrated = migrateSafetyApprovalMode({
      approvalMode: 'default',
      confirmDestructive: false,
    })
    expect(migrated.approvalMode).toBe('dont_ask')
    expect(migrated.confirmDestructive).toBe(true)
    // 幂等：再跑一次不再改动（用户之后用 /mode 切别的模式不会被覆盖）。
    const again = migrateSafetyApprovalMode(migrated)
    expect(again.approvalMode).toBe('dont_ask')
    expect(again.confirmDestructive).toBe(true)
  })

  it('confirmDestructive=true（默认/已确认）→ 原样返回，不触碰 approvalMode', () => {
    expect(
      migrateSafetyApprovalMode({
        approvalMode: 'accept_edits',
        confirmDestructive: true,
      }),
    ).toEqual({ approvalMode: 'accept_edits', confirmDestructive: true })
  })

  it('缺省合并后布尔默认 true → 迁移不触发，approvalMode 保持默认 default', () => {
    const merged = {
      ...DEFAULT_SETTINGS.safety,
      ...({} as Partial<typeof DEFAULT_SETTINGS.safety>),
    }
    expect(migrateSafetyApprovalMode(merged).approvalMode).toBe('default')
  })
})

/* ── multi-profile model resolution (追加⑨) ───────────────────── */

const mkProfile = (over: Partial<ModelProfile> & { id: string }): ModelProfile => ({
  name: '',
  provider: 'openai-compatible',
  model: '',
  baseUrl: '',
  apiKey: '',
  ...over,
})

const legacyLlm = (over: Partial<LLMSettings> = {}): LLMSettings => ({
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
  ...over,
})

describe('genProfileId', () => {
  it('is prefixed and unique across calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => genProfileId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id.startsWith('p-')).toBe(true)
  })
})

describe('activeProfile', () => {
  it('is null without profiles', () => {
    expect(activeProfile(legacyLlm())).toBeNull()
  })

  it('resolves activeProfileId, falling back to the first profile', () => {
    const a = mkProfile({ id: 'a', name: 'A' })
    const b = mkProfile({ id: 'b', name: 'B' })
    expect(activeProfile(legacyLlm({ profiles: [a, b], activeProfileId: 'b' }))?.id).toBe('b')
    expect(activeProfile(legacyLlm({ profiles: [a, b], activeProfileId: null }))?.id).toBe('a')
    expect(activeProfile(legacyLlm({ profiles: [a, b], activeProfileId: 'gone' }))?.id).toBe('a')
  })
})

describe('resolveActiveModel', () => {
  it('uses the active profile when one exists', () => {
    const llm = legacyLlm({
      profiles: [
        mkProfile({ id: 'a', name: '甲', provider: 'anthropic', model: 'claude-opus-5', baseUrl: 'https://x', apiKey: 'k1' }),
        mkProfile({ id: 'b', name: '乙', model: 'gpt-4o', apiKey: 'k2' }),
      ],
      activeProfileId: 'b',
      // Legacy fields must be IGNORED once profiles exist.
      model: 'legacy-model',
      apiKey: 'legacy-key',
    })
    expect(resolveActiveModel(llm)).toEqual({
      provider: 'openai-compatible',
      model: 'gpt-4o',
      baseUrl: '',
      apiKey: 'k2',
      displayName: '乙',
    })
  })

  it('falls back to the legacy block when there are no profiles', () => {
    const llm = legacyLlm({ provider: 'anthropic', model: 'claude-opus-5', baseUrl: 'https://api.anthropic.com', apiKey: 'sk' })
    expect(resolveActiveModel(llm)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk',
      displayName: 'claude-opus-5',
    })
  })
})

describe('resolveSessionModel', () => {
  const profiles = [
    mkProfile({ id: 'ds', name: 'DeepSeek 聊天', provider: 'anthropic', model: 'deepseek-v4', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k-ds' }),
    mkProfile({ id: 'gpt', name: 'GPT 中转', model: 'gpt-4o', baseUrl: 'https://relay.example/v1', apiKey: 'k-gpt' }),
  ]
  const llm = legacyLlm({ profiles, activeProfileId: 'ds' })

  it('returns the global default for a null / blank override', () => {
    expect(resolveSessionModel(llm, null).displayName).toBe('DeepSeek 聊天')
    expect(resolveSessionModel(llm, '   ').model).toBe('deepseek-v4')
  })

  it('matches a profile by id (the picker path)', () => {
    const r = resolveSessionModel(llm, 'gpt')
    expect(r.model).toBe('gpt-4o')
    expect(r.apiKey).toBe('k-gpt')
    expect(r.displayName).toBe('GPT 中转')
  })

  it('matches a profile by display name or model id (hand-typed)', () => {
    expect(resolveSessionModel(llm, 'GPT 中转').apiKey).toBe('k-gpt')
    expect(resolveSessionModel(llm, 'deepseek-v4').provider).toBe('anthropic')
  })

  it('treats anything else as a raw model on the active profile', () => {
    const r = resolveSessionModel(llm, 'some-new-model')
    expect(r.model).toBe('some-new-model')
    expect(r.displayName).toBe('some-new-model')
    expect(r.provider).toBe('anthropic') // rides on the active profile
    expect(r.apiKey).toBe('k-ds')
  })
})

describe('resolveContextWindow', () => {
  it('recognizes the Claude and Gemini families (any casing)', () => {
    expect(resolveContextWindow('claude-opus-5')).toBe(200_000)
    expect(resolveContextWindow('Claude Sonnet 4')).toBe(200_000)
    expect(resolveContextWindow('gemini-2.5-pro')).toBe(1_000_000)
  })

  it('falls back to a conservative 128k for everything else', () => {
    expect(resolveContextWindow('gpt-4o')).toBe(128_000)
    expect(resolveContextWindow('deepseek-v4')).toBe(128_000)
    expect(resolveContextWindow('')).toBe(128_000)
  })
})

describe('migrateLlmBlock', () => {
  it('lifts a filled legacy block into one profile', () => {
    // The shape of a real pre-profiles data.json (DeepSeek via Anthropic
    // protocol): exactly what the migration must preserve.
    const legacy = legacyLlm({
      provider: 'anthropic',
      model: 'DeepSeek-v4-flash',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-97a9',
    })
    const migrated = migrateLlmBlock(legacy)
    expect(migrated.profiles).toHaveLength(1)
    expect(migrated.activeProfileId).toBe(migrated.profiles[0].id)
    expect(migrated.profiles[0]).toMatchObject({
      name: 'DeepSeek-v4-flash',
      provider: 'anthropic',
      model: 'DeepSeek-v4-flash',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-97a9',
    })
    // Legacy fields survive the migration (downgrade fallback).
    expect(migrated.model).toBe('DeepSeek-v4-flash')
    expect(migrated.apiKey).toBe('sk-97a9')
  })

  it('is a no-op when profiles already exist', () => {
    const llm = legacyLlm({
      profiles: [mkProfile({ id: 'x' })],
      activeProfileId: 'x',
      model: 'legacy',
    })
    expect(migrateLlmBlock(llm)).toBe(llm)
  })

  it('leaves a pristine default untouched (nothing configured)', () => {
    const llm = legacyLlm()
    expect(migrateLlmBlock(llm)).toBe(llm)
    expect(migrateLlmBlock(llm).profiles).toEqual([])
  })

  it('makes the migrated setup resolve identically to the old behavior', () => {
    const legacy = legacyLlm({
      provider: 'anthropic',
      model: 'claude-opus-5',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-x',
    })
    const before = resolveActiveModel(legacy)
    const after = resolveActiveModel(migrateLlmBlock(legacy))
    expect(after.provider).toBe(before.provider)
    expect(after.model).toBe(before.model)
    expect(after.baseUrl).toBe(before.baseUrl)
    expect(after.apiKey).toBe(before.apiKey)
  })
})

describe('vendor → models (追加⑱ 补刀)', () => {
  const vendor = (id: string, name: string, models: string[]): ModelVendor => ({
    id,
    name,
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'k',
    models: models.map((m, i) => ({ id: `m-${id}-${i}`, name: m })),
  })
  const llm = (over: Partial<LLMSettings> = {}): LLMSettings => ({
    vendors: [
      vendor('o', 'OpenAI', ['gpt-4o', 'gpt-4o-mini']),
      vendor('d', 'DeepSeek', ['deepseek-v4']),
    ],
    activeModelId: 'm-d-0',
    activeVisionModelId: null,
    activeEmbeddingModelId: null,
    profiles: [],
    activeProfileId: null,
    provider: 'openai-compatible',
    model: '',
    baseUrl: '',
    apiKey: '',
    ...over,
  })

  it('activeModel resolves the default, else the first', () => {
    expect(activeModel(llm())?.model.name).toBe('deepseek-v4')
    expect(activeModel(llm({ activeModelId: 'm-o-1' }))?.model.name).toBe('gpt-4o-mini')
  })

  it('resolveActiveModel uses the default vendor-model', () => {
    const r = resolveActiveModel(llm())
    expect(r.model).toBe('deepseek-v4')
    expect(r.apiKey).toBe('k')
    expect(r.displayName).toBe('deepseek-v4')
  })

  it('findVendorModel + resolveSessionModel match a model id', () => {
    expect(findVendorModel(llm(), 'm-o-0')?.vendor.name).toBe('OpenAI')
    const r = resolveSessionModel(llm(), 'm-o-0')
    expect(r.model).toBe('gpt-4o')
    expect(r.displayName).toBe('gpt-4o')
  })

  it('resolveSessionModel matches "vendor · model"', () => {
    const r = resolveSessionModel(llm(), 'DeepSeek · deepseek-v4')
    expect(r.model).toBe('deepseek-v4')
  })

  it('a raw model rides on the active vendor', () => {
    const r = resolveSessionModel(llm(), 'brand-new-model')
    expect(r.model).toBe('brand-new-model')
    expect(r.apiKey).toBe('k')
    expect(r.provider).toBe('openai-compatible')
  })

  it('apiMode flows through resolveActiveModel and resolveSessionModel', () => {
    const v: ModelVendor = {
      ...vendor('b', 'OpenAI 中转', ['gpt-5']),
      apiKey: 'relay-key',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'responses',
    }
    const settings = llm({ vendors: [v], activeModelId: 'm-b-0' })

    // resolveActiveModel passes apiMode
    const active = resolveActiveModel(settings)
    expect(active.apiMode).toBe('responses')

    // resolveSessionModel by model id passes apiMode
    const byId = resolveSessionModel(settings, 'm-b-0')
    expect(byId.apiMode).toBe('responses')

    // resolveSessionModel by "vendor · model" passes apiMode
    const byName = resolveSessionModel(settings, 'OpenAI 中转 · gpt-5')
    expect(byName.apiMode).toBe('responses')

    // Default (unset) stays undefined → chat-completions at the adapter.
    const plain = resolveSessionModel(llm(), 'm-o-0')
    expect(plain.apiMode).toBeUndefined()
  })

  it('migrateLlmVendors lifts legacy profiles into vendors', () => {
    const migrated = migrateLlmVendors(
      migrateLlmBlock({
        ...DEFAULT_SETTINGS.llm,
        provider: 'anthropic',
        model: 'claude-opus-5',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk',
      }),
    )
    expect(migrated.vendors).toHaveLength(1)
    expect(migrated.vendors[0].models[0].name).toBe('claude-opus-5')
    expect(migrated.vendors[0].provider).toBe('anthropic')
    expect(migrated.activeModelId).toBe(migrated.vendors[0].models[0].id)
  })

  it('migrateImageVendors lifts the legacy image block', () => {
    const image: ImageSettings = {
      ...DEFAULT_SETTINGS.image,
      provider: 'openai-images',
      model: 'gpt-image-1',
      apiKey: 'img-key',
    }
    const migrated = migrateImageVendors(image)
    expect(migrated.vendors[0].models[0].name).toBe('gpt-image-1')
    const r = resolveActiveImage(migrated, llm())
    expect(r.model).toBe('gpt-image-1')
    expect(r.apiKey).toBe('img-key')
  })

  it('mergeImageVendorsIntoLlm moves image vendors into llm.vendors with imageGen', () => {
    const image: ImageSettings = {
      ...DEFAULT_SETTINGS.image,
      vendors: [
        {
          id: 'v-img',
          name: '生图厂商',
          provider: 'openai-images',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'img-key',
          models: [{ id: 'm-img-0', name: 'gpt-image-1' }],
        },
      ],
      activeModelId: 'm-img-0',
    }
    const { llm: mergedLlm, image: mergedImage } = mergeImageVendorsIntoLlm(llm(), image)

    // Moved into the unified list with imageGen forced on.
    const moved = mergedLlm.vendors.find((v) => v.id === 'v-img')
    expect(moved).toBeDefined()
    expect(moved!.models[0].capabilities?.imageGen).toBe(true)
    // Source list cleared (idempotent migration).
    expect(mergedImage.vendors).toEqual([])

    // resolveActiveImage finds it via the unified list (activeModelId by id).
    const r = resolveActiveImage(mergedImage, mergedLlm)
    expect(r.model).toBe('gpt-image-1')
    expect(r.apiKey).toBe('img-key')

    // Second run is a no-op.
    const again = mergeImageVendorsIntoLlm(mergedLlm, mergedImage)
    expect(again.llm.vendors.length).toBe(mergedLlm.vendors.length)
  })

  it('mergeImageVendorsIntoLlm resolves the first imageGen model without explicit selection', () => {
    const v: ModelVendor = {
      id: 'v-x',
      name: 'X',
      provider: 'openai-compatible',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      models: [
        { id: 'm-0', name: 'qwen-plus' },
        { id: 'm-1', name: 'wanx', capabilities: { imageGen: true } },
      ],
    }
    const r = resolveActiveImage(
      { ...DEFAULT_SETTINGS.image },
      llm({ vendors: [v] }),
    )
    expect(r.model).toBe('wanx')
    expect(r.apiKey).toBe('k')
  })

  it('mergeImageVendorsIntoLlm drops never-configured ghost vendors', () => {
    // Old builds auto-created an empty-credential 「默认生图厂商」 — it must
    // not surface in the unified list.
    const image: ImageSettings = {
      ...DEFAULT_SETTINGS.image,
      vendors: [
        {
          id: 'v-ghost',
          name: '默认生图厂商',
          provider: 'openai-images',
          baseUrl: '',
          apiKey: '',
          models: [{ id: 'm-g', name: 'gpt-image-1' }],
        },
      ],
    }
    const { llm: mergedLlm, image: mergedImage } = mergeImageVendorsIntoLlm(llm(), image)
    expect(mergedLlm.vendors.find((v) => v.id === 'v-ghost')).toBeUndefined()
    expect(mergedImage.vendors).toEqual([])
  })

  it('mergeImageVendorsIntoLlm dedupes by vendor id (追加㊹)', () => {
    // A stale-instance write can land image.vendors (pre-migration) next to
    // an llm.vendors that already contains the same vendor — never twin it.
    const base = llm({ vendors: [] })
    const withVendor = {
      ...base,
      vendors: [
        {
          id: 'v-img',
          name: '生图厂商',
          provider: 'openai-images',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'img-key',
          models: [{ id: 'm-img-0', name: 'gpt-image-1' }],
        },
      ],
    }
    const image: ImageSettings = {
      ...DEFAULT_SETTINGS.image,
      vendors: [withVendor.vendors[0]],
      activeModelId: 'm-img-0',
    }
    const { llm: mergedLlm, image: mergedImage } = mergeImageVendorsIntoLlm(withVendor, image)
    expect(mergedLlm.vendors.filter((v) => v.id === 'v-img')).toHaveLength(1)
    expect(mergedImage.vendors).toEqual([])
  })
})

describe('mergeSettingsForSave (追加㊹: blockwise save merge)', () => {
  const base = (): ObsidianAISettings => cloneSettings(DEFAULT_SETTINGS)

  it('untouched blocks take the disk version (multi-instance overwrite fix)', () => {
    const snapshot = base()
    const current = base()
    // This instance only changed 通用 (general) — image stays untouched.
    current.general.assistantName = '助手'
    // The other instance meanwhile wrote a NEWER image block on disk.
    const disk: Partial<ObsidianAISettings> = {
      image: {
        ...DEFAULT_SETTINGS.image,
        activeModelId: 'm-from-other-instance',
      },
    }
    const merged = mergeSettingsForSave(snapshot, current, disk)
    // The other instance's selection survives our save.
    expect(merged.image.activeModelId).toBe('m-from-other-instance')
    // Our own change persists.
    expect(merged.general.assistantName).toBe('助手')
    // And the saved object never aliases the in-memory one.
    expect(merged).not.toBe(current)
  })

  it('touched blocks keep the in-memory value even when disk differs', () => {
    const snapshot = base()
    const current = base()
    current.image.activeModelId = 'm-picked-just-now'
    const disk: Partial<ObsidianAISettings> = {
      image: { ...DEFAULT_SETTINGS.image, activeModelId: 'm-stale-on-disk' },
    }
    const merged = mergeSettingsForSave(snapshot, current, disk)
    expect(merged.image.activeModelId).toBe('m-picked-just-now')
  })

  it('a null disk (read failed) falls back to the full in-memory copy', () => {
    const current = base()
    current.general.assistantName = '助手'
    expect(mergeSettingsForSave(base(), current, null)).toEqual(current)
  })

  it('an empty disk never clobbers anything', () => {
    const current = base()
    current.image.activeModelId = 'm-x'
    const merged = mergeSettingsForSave(base(), current, {})
    expect(merged.image.activeModelId).toBe('m-x')
  })
})

describe('agents settings block (多 Agent 体系)', () => {
  it('defaults to enabled with an empty disabled list', () => {
    expect(DEFAULT_SETTINGS.agents).toEqual({
      enabled: true,
      disabled: [],
      disabledTools: [],
      perAgent: {},
    })
  })

  it('per-block spread fills defaults when a legacy data.json lacks the block', () => {
    // The loadSettings contract (main.ts): agents merged exactly like skills.
    const loaded: Partial<typeof DEFAULT_SETTINGS> = {}
    const merged = { ...DEFAULT_SETTINGS.agents, ...(loaded.agents ?? {}) }
    expect(merged).toEqual({
      enabled: true,
      disabled: [],
      disabledTools: [],
      perAgent: {},
    })
  })

  it('per-block spread keeps stored values and backfills new keys', () => {
    const loaded = {
      // 模拟旧版 data.json：缺 disabledTools / perAgent 等后加字段。
      agents: { enabled: false, disabled: ['追问启发'] },
    } as Partial<typeof DEFAULT_SETTINGS>
    const merged = { ...DEFAULT_SETTINGS.agents, ...(loaded.agents ?? {}) }
    expect(merged).toEqual({
      enabled: false,
      disabled: ['追问启发'],
      disabledTools: [],
      perAgent: {},
    })
  })
})

describe('per-agent tool/skill selection (工具通用池 ∩ agent 选择)', () => {
  const fresh = (): ObsidianAISettings => cloneSettings(DEFAULT_SETTINGS)

  it('main agent defaults to every tool when nothing is configured', () => {
    const s = fresh()
    expect(isToolEnabledForAgent(s.agents, MAIN_AGENT_KEY, 'edit_note')).toBe(
      true,
    )
    expect(isToolEnabledForAgent(s.agents, '写作教练', 'search_notes')).toBe(
      true,
    )
  })

  it('a globally disabled tool is off for EVERY agent (含主 agent)', () => {
    const s = fresh()
    s.agents.disabledTools.push('delete_note')
    expect(isToolEnabledForAgent(s.agents, MAIN_AGENT_KEY, 'delete_note')).toBe(
      false,
    )
    expect(isToolEnabledForAgent(s.agents, '写作教练', 'delete_note')).toBe(
      false,
    )
    // 其他工具不受影响。
    expect(isToolEnabledForAgent(s.agents, MAIN_AGENT_KEY, 'read_note')).toBe(
      true,
    )
  })

  it('per-agent override narrows only that agent', () => {
    const s = fresh()
    setAgentTool(s.agents, '写作教练', 'generate_image', false)
    expect(isToolEnabledForAgent(s.agents, '写作教练', 'generate_image')).toBe(
      false,
    )
    expect(
      isToolEnabledForAgent(s.agents, MAIN_AGENT_KEY, 'generate_image'),
    ).toBe(true)
    // 重新打开恢复（从禁用名单移除）。
    setAgentTool(s.agents, '写作教练', 'generate_image', true)
    expect(isToolEnabledForAgent(s.agents, '写作教练', 'generate_image')).toBe(
      true,
    )
  })

  it('global off wins even when the per-agent list says on', () => {
    const s = fresh()
    setAgentTool(s.agents, '写作教练', 'edit_note', true)
    s.agents.disabledTools.push('edit_note')
    expect(isToolEnabledForAgent(s.agents, '写作教练', 'edit_note')).toBe(false)
  })

  it('setAgentTool is idempotent (never duplicates entries)', () => {
    const s = fresh()
    setAgentTool(s.agents, MAIN_AGENT_KEY, 'ask_user', false)
    setAgentTool(s.agents, MAIN_AGENT_KEY, 'ask_user', false)
    expect(agentOverrides(s.agents, MAIN_AGENT_KEY).disabledTools).toEqual([
      'ask_user',
    ])
  })

  it('per-agent skill switches compose with the global list (caller side)', () => {
    const s = fresh()
    // 全局启用 + agent 未关 → 生效。
    expect(isSkillEnabledForAgent(s.agents, MAIN_AGENT_KEY, 'edit-note')).toBe(
      true,
    )
    // agent 单独关闭 → 不生效（全局层由调用方另行组合判断）。
    setAgentSkill(s.agents, '写作教练', 'edit-note', false)
    expect(isSkillEnabledForAgent(s.agents, '写作教练', 'edit-note')).toBe(
      false,
    )
    expect(isSkillEnabledForAgent(s.agents, MAIN_AGENT_KEY, 'edit-note')).toBe(
      true,
    )
    // 再打开恢复。
    setAgentSkill(s.agents, '写作教练', 'edit-note', true)
    expect(isSkillEnabledForAgent(s.agents, '写作教练', 'edit-note')).toBe(true)
  })

  it('agentOverrides returns an empty object for unconfigured agents', () => {
    const s = fresh()
    expect(agentOverrides(s.agents, '不存在的代理')).toEqual({})
  })

  it('per-agent MCP switches compose with the global toggle (追加87, caller side)', () => {
    const s = fresh()
    const svcId = 'mcp-websearch'
    // 未配置 = 默认开启（全局层 service.enabled 由调用方另行组合判断）。
    expect(isMcpEnabledForAgent(s.agents, MAIN_AGENT_KEY, svcId)).toBe(true)
    // agent 单独关闭 → 该 agent 失效，其他 agent 不受影响。
    setAgentMcp(s.agents, '写作教练', svcId, false)
    expect(isMcpEnabledForAgent(s.agents, '写作教练', svcId)).toBe(false)
    expect(isMcpEnabledForAgent(s.agents, MAIN_AGENT_KEY, svcId)).toBe(true)
    // 再打开恢复。
    setAgentMcp(s.agents, '写作教练', svcId, true)
    expect(isMcpEnabledForAgent(s.agents, '写作教练', svcId)).toBe(true)
  })

  it('setAgentMcp is idempotent (never duplicates entries)', () => {
    const s = fresh()
    setAgentMcp(s.agents, MAIN_AGENT_KEY, 'mcp-a', false)
    setAgentMcp(s.agents, MAIN_AGENT_KEY, 'mcp-a', false)
    expect(agentOverrides(s.agents, MAIN_AGENT_KEY).disabledMcp).toEqual([
      'mcp-a',
    ])
  })
})

/**
 * 官方 MCP 服务纪律：首启播种（data.json 无 mcp 块）；块一旦存在即用户
 * 所有——删除官方服务不会复活；存量手工添加的同端点服务按 baseUrl 认领
 * 为 official（删除入口随之消失）。
 */
describe('official MCP services', () => {
  it('ships the official bailian websearch service marked official', () => {
    expect(OFFICIAL_MCP_SERVICES.length).toBeGreaterThan(0)
    for (const s of OFFICIAL_MCP_SERVICES) {
      expect(s.official).toBe(true)
      expect(s.baseUrl).toMatch(/^https:\/\//)
    }
    expect(
      OFFICIAL_MCP_SERVICES.some((s) => s.baseUrl.includes('WebSearch')),
    ).toBe(true)
  })

  // 复刻 main.ts loadSettings 的播种三元式：块缺失 → 播种；块存在 → 不动。
  const loadMcp = (loaded: { mcp?: McpSettings } | undefined): McpSettings =>
    adoptOfficialMcpServices(
      loaded?.mcp
        ? { services: [...loaded.mcp.services] }
        : { services: cloneSettings(OFFICIAL_MCP_SERVICES) },
    )

  it('seeds official services on first launch (no mcp block)', () => {
    const mcp = loadMcp(undefined)
    expect(mcp.services).toHaveLength(OFFICIAL_MCP_SERVICES.length)
    expect(mcp.services[0].official).toBe(true)
    // 播种结果不别名模块常量。
    mcp.services[0].name = '改过'
    expect(OFFICIAL_MCP_SERVICES[0].name).not.toBe('改过')
  })

  it('never resurrects an official service the user deleted', () => {
    // 用户删光了官方服务 → mcp 块还在（services: []）→ 加载不播种。
    const mcp = loadMcp({ mcp: { services: [] } })
    expect(mcp.services).toEqual([])
  })

  it('adopts a hand-added copy of the official endpoint', () => {
    const mcp = loadMcp({
      mcp: {
        services: [
          {
            id: 'mcp-hand-added',
            name: '百炼联网搜索',
            baseUrl: OFFICIAL_MCP_SERVICES[0].baseUrl,
            authHeader: 'Bearer sk-test',
            enabled: true,
          },
        ],
      },
    })
    expect(mcp.services[0].official).toBe(true)
    expect(mcp.services[0].id).toBe(OFFICIAL_MCP_SERVICES[0].id)
  })

  it('leaves third-party services untouched and is idempotent', () => {
    const mcp = loadMcp({
      mcp: {
        services: [
          {
            id: 'mcp-third',
            name: 'third',
            baseUrl: 'https://example.com/mcp',
            authHeader: '',
            enabled: true,
          },
        ],
      },
    })
    expect(mcp.services[0].official).toBeUndefined()
    expect(mcp.services[0].id).toBe('mcp-third')
    // 幂等：再认领一次结果不变。
    expect(adoptOfficialMcpServices(mcp)).toEqual(mcp)
  })
})

describe('embedding 模型融合（检索并入统一厂商体系）', () => {
  const vendor = (
    models: Array<{ id: string; name: string; capabilities?: Record<string, boolean> }>,
  ): ModelVendor => ({
    id: 'v1',
    name: '百炼',
    provider: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-emb',
    models: models as ModelVendor['models'],
  })

  it('resolveEmbeddingModel: 显式选择 → 首个 embedding 能力模型 → null', () => {
    const emb = { id: 'm-emb', name: 'text-embedding-v4', capabilities: { embedding: true } }
    const other = { id: 'm-x', name: 'qwen-plus' }
    expect(resolveEmbeddingModel(legacyLlm({ vendors: [] }))).toBeNull()

    // 2. 无显式选择 → 第一个带 embedding 能力的模型。
    const r = resolveEmbeddingModel(legacyLlm({ vendors: [vendor([other, emb])] }))
    expect(r?.model).toBe('text-embedding-v4')
    expect(r?.apiKey).toBe('sk-emb')

    // 1. 显式选择优先生效。
    const emb2 = { id: 'm-emb2', name: 'bge-m3', capabilities: { embedding: true } }
    const r2 = resolveEmbeddingModel(
      legacyLlm({
        vendors: [vendor([emb]), vendor([emb2])],
        activeEmbeddingModelId: 'm-emb2',
      }),
    )
    expect(r2?.model).toBe('bge-m3')
  })

  it('显式选择但模型无 embedding 能力时回落检索', () => {
    const plain = { id: 'm-x', name: 'qwen-plus' }
    const emb = { id: 'm-emb', name: 'text-embedding-v4', capabilities: { embedding: true } }
    const r = resolveEmbeddingModel(
      legacyLlm({ vendors: [vendor([plain, emb])], activeEmbeddingModelId: 'm-x' }),
    )
    expect(r?.model).toBe('text-embedding-v4')
  })

  it('名字启发式：text-embedding-* 自动获得 embedding 能力', () => {
    const inferred = { id: 'm-i', name: 'text-embedding-v3' } // 无显式 capabilities
    const r = resolveEmbeddingModel(legacyLlm({ vendors: [vendor([inferred])] }))
    expect(r?.model).toBe('text-embedding-v3')
  })

  it('迁移：空密钥不搬（新装用户不凭空多厂商）', () => {
    const llm = legacyLlm()
    const retrieval: RetrievalSettings = { ...DEFAULT_SETTINGS.retrieval }
    const out = migrateRetrievalEmbeddingIntoLlm(llm, retrieval)
    expect(out.llm).toBe(llm)
    expect(out.retrieval).toBe(retrieval)
  })

  it('迁移：填过密钥时提升为厂商并设为默认检索模型', () => {
    const retrieval: RetrievalSettings = {
      semanticEnabled: true,
      embeddingBaseUrl: 'https://custom.example.com/v1',
      embeddingApiKey: 'sk-abc',
      embeddingModel: 'text-embedding-v4',
    }
    const out = migrateRetrievalEmbeddingIntoLlm(legacyLlm(), retrieval)
    expect(out.llm.vendors).toHaveLength(1)
    const v = out.llm.vendors[0]
    expect(v.baseUrl).toBe('https://custom.example.com/v1')
    expect(v.apiKey).toBe('sk-abc')
    expect(v.models[0].name).toBe('text-embedding-v4')
    expect(v.models[0].capabilities?.embedding).toBe(true)
    expect(out.llm.activeEmbeddingModelId).toBe(v.models[0].id)
    // semanticEnabled 保留；三字段恢复默认空值。
    expect(out.retrieval.semanticEnabled).toBe(true)
    expect(out.retrieval.embeddingApiKey).toBe('')
    expect(out.retrieval.embeddingModel).toBe(DEFAULT_SETTINGS.retrieval.embeddingModel)
    // 迁移后 resolve 能接上。
    expect(resolveEmbeddingModel(out.llm)?.model).toBe('text-embedding-v4')
  })

  it('迁移幂等：第二次调用不再重复搬运', () => {
    const retrieval: RetrievalSettings = {
      semanticEnabled: true,
      embeddingBaseUrl: '',
      embeddingApiKey: 'sk-abc',
      embeddingModel: '',
    }
    const first = migrateRetrievalEmbeddingIntoLlm(legacyLlm(), retrieval)
    const second = migrateRetrievalEmbeddingIntoLlm(first.llm, first.retrieval)
    expect(second.llm.vendors).toHaveLength(1)
    expect(second.llm).toBe(first.llm)
  })
})
