import { App, ButtonComponent, Modal, Notice, Setting, setIcon } from 'obsidian'
import {
  API_MODE_PRESETS,
  ApiMode,
  ModelCapabilities,
  ModelVendor,
  PROVIDER_PRESETS,
  genModelId,
  inferCapabilities,
} from './settings'
import { createLLMProvider } from '../core/llm/manager'

// One added model shown in the model list (no checkboxes — presence in the
// list means enabled; rows have a delete button instead).
interface AvailableModel {
  name: string
  desc?: string
  source: 'existing' | 'custom'
  /** Capabilities from existing config or name-heuristic inference. */
  capabilities?: ModelCapabilities
  contextWindow?: number
  maxOutputTokens?: number
}

/** Per-model capability override entry. */
interface ModelOverride {
  capabilities?: ModelCapabilities
  contextWindow?: number
  maxOutputTokens?: number
}

/** Capability checkbox metadata for rendering. */
const CAP_FIELDS: Array<{ key: keyof ModelCapabilities; label: string; defaultTrue: boolean }> = [
  { key: 'vision', label: '视觉理解', defaultTrue: false },
  { key: 'tools', label: '工具调用', defaultTrue: true },
  { key: 'reasoning', label: '深度思考', defaultTrue: true },
  { key: 'imageGen', label: '图片生成', defaultTrue: false },
  { key: 'embedding', label: '向量化（检索）', defaultTrue: false },
  { key: 'webSearch', label: '联网搜索', defaultTrue: false },
  { key: 'jsonMode', label: 'JSON 模式', defaultTrue: false },
  { key: 'fileUnderstanding', label: '文件理解', defaultTrue: false },
]

/**
 * VendorModal — 纯手动填写（追加㉕）.
 *
 * Key behavior:
 * 1. 厂商预设下拉已移除：提供商名称/API 协议/协议模式/API 地址/API 密钥
 *    全部手填（VENDOR_PRESETS 数据仅留在 settings.ts 内部，供
 *    resolveCapabilities 推断存量配置能力）。
 * 2. 添加模型 = 联想输入框：聚焦后懒拉 GET {baseUrl}/models，
 *    选中建议或手输名字回车即可添加。
 * 3. Added models render as simple rows (badges + capability gear +
 *    delete) instead of a grouped checkbox box.
 */
export class VendorModal extends Modal {
  private readonly draft: ModelVendor
  private readonly isNew: boolean
  private readonly onSave: (vendor: ModelVendor) => Promise<void>

  /** Added models shown in the list (all enabled). */
  private models: AvailableModel[] = []
  /** Per-model capability overrides (user edits in capability editor). */
  private modelOverrides: Map<string, ModelOverride> = new Map()
  /** Expanded capability editor state (model name → expanded). */
  private expandedEditors: Set<string> = new Set()
  /** Combobox input value (survives re-renders). */
  private addInputValue = ''
  /** Suggestion dropdown open state. */
  private dropdownOpen = false
  /** Model names fetched from GET {baseUrl}/models (null = not fetched yet). */
  private fetchedNames: string[] | null = null
  /** Fetch loading state. */
  private fetching = false
  /** Fetch error message (shown as a hint, non-blocking). */
  private fetchError: string | null = null
  /** Live suggestion dropdown element (rebuilt on each renderBody). */
  private suggestionsEl: HTMLElement | null = null
  /** Document-level listeners to remove when the modal closes. */
  private cleanupFns: Array<() => void> = []

  constructor(
    app: App,
    original: ModelVendor,
    opts: {
      isNew: boolean
      onSave: (vendor: ModelVendor) => Promise<void>
    },
  ) {
    super(app)
    this.draft = {
      ...original,
      models: original.models.map((m) => ({ ...m })),
    }
    this.isNew = opts.isNew
    this.onSave = opts.onSave

    // Initialize available models + enabled set
    this.rebuildAvailableModels()
  }

  onOpen(): void {
    this.titleEl.setText(this.isNew ? '添加厂商' : '编辑厂商')
    this.renderBody()
  }

  onClose(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
    this.suggestionsEl = null
    this.contentEl.empty()
  }

  /** Rebuild the added-models list from the draft's existing models. */
  private rebuildAvailableModels(): void {
    const list: AvailableModel[] = []
    const seen = new Set<string>()
    for (const m of this.draft.models) {
      if (!seen.has(m.name)) {
        list.push({
          name: m.name,
          source: 'existing',
          capabilities: m.capabilities,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        })
        seen.add(m.name)
      }
    }
    this.models = list
    // Initialize modelOverrides from existing draft models that have explicit capabilities
    this.modelOverrides = new Map()
    for (const m of this.draft.models) {
      if (m.capabilities || m.contextWindow !== undefined || m.maxOutputTokens !== undefined) {
        this.modelOverrides.set(m.name, {
          capabilities: m.capabilities,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        })
      }
    }
  }

  /**
   * Lazily fetch available model names from GET {baseUrl}/models (once).
   * Triggered when the add-model combobox gains focus — the standalone
   * "获取模型列表" button was folded into this suggestion flow.
   */
  private async ensureFetched(): Promise<void> {
    if (this.fetchedNames !== null || this.fetching) return
    const baseUrl = this.draft.baseUrl.trim()
    const apiKey = this.draft.apiKey.trim()
    if (!baseUrl) {
      this.fetchError = '填写 Base URL 后可联想模型名'
      return
    }
    if (!apiKey) {
      this.fetchError = '填写 API Key 后可联想模型名'
      return
    }
    this.fetching = true
    this.fetchError = null
    try {
      const url = baseUrl.replace(/\/+$/, '') + '/models'
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const json = await response.json()
      const names: string[] = (json.data ?? [])
        .map((m: { id?: string }) => m.id)
        .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        .sort()
      this.fetchedNames = names
      if (names.length === 0) {
        this.fetchError = 'API 返回了空模型列表，可直接手动输入'
      }
    } catch (e) {
      // Non-blocking hint — manual typing always works.
      this.fetchError = `获取失败（${e instanceof Error ? e.message : '未知错误'}），可手动输入`
    } finally {
      this.fetching = false
      // Refresh the open dropdown in place (if the modal is still open).
      if (this.dropdownOpen && this.suggestionsEl) {
        this.renderSuggestions(this.suggestionsEl)
      }
    }
  }

  /** Suggestion candidates: fetched API models only (追加㉓：预设模型不再
   * 出现在 UI；预设数据仅供 resolveCapabilities 推断存量配置能力）。 */
  private candidateNames(): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const name of this.fetchedNames ?? []) {
      if (!seen.has(name)) {
        out.push(name)
        seen.add(name)
      }
    }
    return out
  }

  /** Filter candidates by the input text, excluding already-added models. */
  private currentSuggestions(): string[] {
    const q = this.addInputValue.trim().toLowerCase()
    const added = new Set(this.models.map((m) => m.name))
    return this.candidateNames().filter(
      (name) => !added.has(name) && (q === '' || name.toLowerCase().includes(q)),
    )
  }

  /** Add a model (from a suggestion pick or typed text) and re-render. */
  private addModelByName(name: string): void {
    if (name.length === 0) return
    if (!this.models.some((m) => m.name === name)) {
      const inferred = inferCapabilities(name)
      // 追加㉗：生图协议厂商下的模型一律视为生图模型（名字启发式认不出
      // 自定义部署名时也能被 resolveActiveImage 检索到）。
      if (this.draft.provider === 'openai-images') {
        inferred.imageGen = true
      }
      this.models.push({
        name,
        source: 'custom',
        capabilities: Object.keys(inferred).length > 0 ? inferred : undefined,
      })
    }
    this.addInputValue = ''
    this.dropdownOpen = false
    this.renderBody()
  }

  /** Remove an added model and re-render. */
  private removeModelByName(name: string): void {
    this.models = this.models.filter((m) => m.name !== name)
    this.modelOverrides.delete(name)
    this.expandedEditors.delete(name)
    this.renderBody()
  }

  /** (Re)build the entire modal body. */
  private renderBody(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('UNagent-profile-modal')
    const draft = this.draft

    /* ── API 协议 ── */
    new Setting(contentEl)
      .setName('API 协议')
      .addDropdown((dropdown) => {
        for (const preset of PROVIDER_PRESETS) {
          dropdown.addOption(preset.id, preset.label)
        }
        dropdown.setValue(draft.provider)
        dropdown.onChange((value) => {
          draft.provider = value
          const preset = PROVIDER_PRESETS.find((p) => p.id === value)
          if (preset) {
            const knownDefaults = PROVIDER_PRESETS.map((p) => p.defaultBaseUrl)
            if (!draft.baseUrl.trim() || knownDefaults.includes(draft.baseUrl)) {
              draft.baseUrl = preset.defaultBaseUrl
            }
          }
          this.renderBody()
        })
      })

    /* ── 协议模式（追加㉒：OpenAI 兼容协议下两种模式；追加㉗：生图协议固定） ── */
    new Setting(contentEl)
      .setName('协议模式')
      .setDesc(
        draft.provider === 'anthropic'
          ? 'Anthropic 固定使用 Messages 接口'
          : draft.provider === 'openai-images'
            ? '生图固定使用 /images/generations 接口'
            : 'Chat Completions 为经典接口；Responses API 为新一代接口',
      )
      .addDropdown((dropdown) => {
        if (draft.provider === 'anthropic') {
          dropdown.addOption('messages', 'Messages')
          dropdown.setValue('messages')
          dropdown.setDisabled(true)
        } else if (draft.provider === 'openai-images') {
          dropdown.addOption('images', 'Images API')
          dropdown.setValue('images')
          dropdown.setDisabled(true)
        } else {
          for (const mode of API_MODE_PRESETS) {
            dropdown.addOption(mode.id, mode.label)
          }
          dropdown.setValue(draft.apiMode ?? 'chat-completions')
          dropdown.onChange((value) => {
            draft.apiMode = value as ApiMode
          })
        }
      })

    /* ── 提供商名称 ── */
    new Setting(contentEl)
      .setName('提供商名称')
      .setDesc('/model 列表与状态条里显示的名字')
      .addText((text) =>
        text
          .setPlaceholder('如：百炼 / DeepSeek')
          .setValue(draft.name)
          .onChange((value) => {
            draft.name = value
          }),
      )

    /* ── API 地址 ──
     * 追加㉔：不再提供多地址下拉（百炼的国内/国际选项已优化掉），
     * 统一为单一输入框；选预设时自动预填首个地址，可任意改写。 */
    new Setting(contentEl)
      .setName('API 地址')
      .setDesc('接口地址，不含 /chat/completions 等路径后缀')
      .addText((text) =>
        text
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(draft.baseUrl)
          .onChange((value) => {
            draft.baseUrl = value.trim()
          }),
      )

    /* ── API 密钥 ── */
    let revealed = false
    const keySetting = new Setting(contentEl)
      .setName('API 密钥')
      .setDesc('该厂商的服务商密钥，仅存于本地 data.json')
    keySetting.addText((text) => {
      text.inputEl.type = 'password'
      text.inputEl.autocomplete = 'off'
      text.setPlaceholder('sk-...').setValue(draft.apiKey).onChange((value) => {
        draft.apiKey = value.trim()
      })
    })
    keySetting.addButton((button) => {
      button.setTooltip('显示 / 隐藏').setIcon('eye').onClick(() => {
        revealed = !revealed
        const input = keySetting.settingEl.querySelector('input')
        if (input) input.type = revealed ? 'text' : 'password'
        button.setIcon(revealed ? 'eye-off' : 'eye')
      })
    })

    /* ── 模型列表（手动添加优先 + 联想建议）── */
    new Setting(contentEl).setName('模型列表').setHeading()
    contentEl.createEl('p', {
      text: '点击下方输入框即可联想可用模型（自动从 API 拉取）；也可直接输入任意模型名后回车添加。',
      cls: 'setting-item-description',
    })

    // Combobox: input + suggestion dropdown (fetch folded into focus).
    const comboWrap = contentEl.createDiv('UNagent-model-combo')
    const inputEl = comboWrap.createEl('input', {
      type: 'text',
      placeholder: '输入模型名，如 gpt-4o（点击展开联想）',
      cls: 'UNagent-model-combo-input',
    })
    inputEl.value = this.addInputValue
    const suggestionsEl = comboWrap.createDiv('UNagent-model-combo-list')
    suggestionsEl.style.display = this.dropdownOpen ? '' : 'none'
    this.suggestionsEl = suggestionsEl

    const openDropdown = (): void => {
      this.dropdownOpen = true
      suggestionsEl.setCssStyles({ display: '' })
      this.renderSuggestions(suggestionsEl)
      void this.ensureFetched()
    }
    inputEl.addEventListener('focus', openDropdown)
    inputEl.addEventListener('click', openDropdown)
    inputEl.addEventListener('input', () => {
      this.addInputValue = inputEl.value
      if (!this.dropdownOpen) {
        this.dropdownOpen = true
        suggestionsEl.setCssStyles({ display: '' })
        void this.ensureFetched()
      }
      this.renderSuggestions(suggestionsEl)
    })
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        this.addModelByName(this.addInputValue.trim())
      } else if (ev.key === 'Escape') {
        this.dropdownOpen = false
        suggestionsEl.setCssStyles({ display: 'none' })
      }
    })
    // Close on outside click (mousedown fires before input blur).
    const onDocMouseDown = (ev: MouseEvent): void => {
      if (!comboWrap.contains(ev.target as Node)) {
        this.dropdownOpen = false
        suggestionsEl.setCssStyles({ display: 'none' })
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    this.cleanupFns.push(() =>
      document.removeEventListener('mousedown', onDocMouseDown),
    )

    if (this.fetchError) {
      comboWrap.createEl('p', {
        text: `⚠ ${this.fetchError}`,
        cls: 'UNagent-model-combo-hint',
      })
    }
    this.renderSuggestions(suggestionsEl)

    // Added models — simple rows: name + badges + gear + delete.
    if (this.models.length > 0) {
      const listEl = contentEl.createDiv('UNagent-model-rows')
      for (const model of this.models) {
        const itemEl = listEl.createDiv('UNagent-model-row')
        itemEl.createSpan({ text: model.name, cls: 'UNagent-model-row-name' })
        if (model.desc) {
          itemEl.createSpan({ text: model.desc, cls: 'UNagent-model-row-desc' })
        }
        const badgesEl = itemEl.createSpan({ cls: 'UNagent-cap-badges' })
        this.renderCapBadges(badgesEl, model.name)

        // Row actions — gear + delete grouped at the right edge, same render
        // format (追加60：齿轮从 badges 旁移到叉叉旁边，两按钮统一样式)。
        const actionsEl = itemEl.createDiv('UNagent-model-row-actions')
        const gearBtn = actionsEl.createEl('button', {
          cls: 'UNagent-cap-gear clicking',
        })
        setIcon(gearBtn, 'settings')
        gearBtn.setAttribute('aria-label', '能力设置')
        const editorEl = listEl.createDiv('UNagent-cap-editor')
        editorEl.setCssStyles({ display: 'none' })
        gearBtn.addEventListener('click', () => {
          const isExpanded = editorEl.style.display !== 'none'
          if (isExpanded) {
            editorEl.setCssStyles({ display: 'none' })
            this.expandedEditors.delete(model.name)
          } else {
            editorEl.setCssStyles({ display: '' })
            this.expandedEditors.add(model.name)
            editorEl.empty()
            this.renderCapEditor(editorEl, model.name, badgesEl)
          }
        })
        if (this.expandedEditors.has(model.name)) {
          editorEl.setCssStyles({ display: '' })
          this.renderCapEditor(editorEl, model.name, badgesEl)
        }

        // Delete button — lucide x icon, same format as the gear.
        const delBtn = actionsEl.createEl('button', {
          cls: 'UNagent-model-del clicking',
        })
        setIcon(delBtn, 'x')
        delBtn.setAttribute('aria-label', '移除模型')
        delBtn.addEventListener('click', () => {
          this.removeModelByName(model.name)
        })
      }
    } else {
      contentEl.createEl('p', {
        text: '还没有添加任何模型。',
        cls: 'setting-item-description',
      })
    }

    /* ── 操作按钮 ── */
    const actions = contentEl.createDiv('UNagent-profile-modal-actions')
    const testBtn = new ButtonComponent(actions)
      .setButtonText('测试连接')
      .setTooltip('用已添加的第一个模型发一条最小请求验证连通性')
    testBtn.onClick(() => {
      void this.testConnection(testBtn)
    })
    new ButtonComponent(actions)
      .setButtonText('保存')
      .setCta()
      .onClick(() => {
        void (async () => {
          // Map added models to VendorModel[], preserving existing IDs
          const oldModels = new Map(this.draft.models.map((m) => [m.name, m.id]))
          this.draft.models = this.models.map((m) => {
            const ov = this.modelOverrides.get(m.name)
            const result = {
              id: oldModels.get(m.name) ?? genModelId(),
              name: m.name,
            } as import('./settings').VendorModel
            // Merge base capabilities (existing config / preset-authored /
            // inferred at add time) with user overrides from the editor.
            const caps = { ...(m.capabilities ?? {}), ...(ov?.capabilities ?? {}) }
            if (Object.keys(caps).length > 0) result.capabilities = caps
            const ctx = ov?.contextWindow ?? m.contextWindow
            if (ctx !== undefined) result.contextWindow = ctx
            const max = ov?.maxOutputTokens ?? m.maxOutputTokens
            if (max !== undefined) result.maxOutputTokens = max
            return result
          })
          // apiMode only means anything for openai-compatible vendors.
          if (this.draft.provider === 'anthropic' || this.draft.provider === 'openai-images') {
            delete this.draft.apiMode
          }
          // presetId（追加㉕）：UI 不再提供预设选择，但存量厂商的 presetId
          // 随 draft 克隆原样保留，resolveCapabilities 仍可据此推断能力。
          await this.onSave(this.draft)
          this.close()
        })().catch((err) => {
          // Save is fire-and-forget (void): never let a rejection become an
          // unhandled rejection that Obsidian can attribute to the plugin
          // (mobile auto-disable). Surface it in the modal instead.
          console.error('[UNagent] vendor save failed:', err)
          new Notice(
            `保存失败：${err instanceof Error ? err.message : String(err)}`,
          )
        })
      })
    new ButtonComponent(actions)
      .setButtonText('取消')
      .onClick(() => this.close())
  }

  /**
   * 测试连接（追加㉒）：用已添加的第一个模型通过当前协议/模式发一条最小
   * 请求，拿到任意响应块即视为连通。走真实适配器链路，所以协议/模式/地址/
   * 密钥哪里错了都能报出来。
   */
  private async testConnection(btn: ButtonComponent): Promise<void> {
    if (this.models.length === 0) {
      new Notice('请先添加至少一个模型再测试连接')
      return
    }
    // 追加㉗：生图协议没有对话链路可 ping，测试连接不适用。
    if (this.draft.provider === 'openai-images') {
      new Notice('生图协议暂不支持测试连接，保存后直接让它生成一张试试')
      return
    }
    const draft = this.draft
    btn.setButtonText('测试中…').setDisabled(true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const provider = createLLMProvider({
        provider: draft.provider,
        apiMode: draft.apiMode,
        model: this.models[0].name,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
      })
      for await (const chunk of provider.streamChat(
        [{ role: 'user', content: 'ping' }],
        undefined,
        { signal: controller.signal, maxTokens: 1 },
      )) {
        // Any chunk back means the endpoint speaks the configured protocol.
        void chunk
        break
      }
      // Stop the stream early — the test only needs the first chunk.
      controller.abort()
      new Notice('连接成功')
    } catch (e) {
      new Notice(`连接失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
      btn.setButtonText('测试连接').setDisabled(false)
    }
  }

  /** Render the suggestion dropdown contents into the given container. */
  private renderSuggestions(container: HTMLElement): void {
    container.empty()
    if (!this.dropdownOpen) return
    if (this.fetching) {
      container.createDiv({
        text: '正在获取模型列表…',
        cls: 'UNagent-model-combo-empty',
      })
      return
    }
    const suggestions = this.currentSuggestions()
    if (suggestions.length === 0) {
      container.createDiv({
        text:
          this.fetchedNames === null && this.fetchError
            ? '无联想结果 —— 直接输入模型名后回车添加'
            : '无匹配模型 —— 直接输入后回车添加',
        cls: 'UNagent-model-combo-empty',
      })
      return
    }
    // Cap the visible list; long provider lists (100+) stay scrollable.
    for (const name of suggestions.slice(0, 200)) {
      const item = container.createDiv('UNagent-model-combo-item')
      item.createSpan({ text: name, cls: 'UNagent-model-combo-name' })
      item.addEventListener('mousedown', (ev) => {
        // mousedown so the pick lands before any blur/outside-click close.
        ev.preventDefault()
        this.addModelByName(name)
      })
    }
  }

  /** Get effective capability value for a model (override → added → type default). */
  private getEffectiveCap(name: string, key: keyof ModelCapabilities): boolean {
    const ov = this.modelOverrides.get(name)
    const avail = this.models.find((m) => m.name === name)
    const raw = ov?.capabilities?.[key] ?? avail?.capabilities?.[key]
    const field = CAP_FIELDS.find((f) => f.key === key)!
    return field.defaultTrue ? raw !== false : raw === true
  }

  /** Get effective numeric value for a model (override → added). */
  private getEffectiveNum(name: string, field: 'contextWindow' | 'maxOutputTokens'): number | undefined {
    const ov = this.modelOverrides.get(name)
    const avail = this.models.find((m) => m.name === name)
    return ov?.[field] ?? avail?.[field]
  }

  /** Render small capability badges next to model name. */
  private renderCapBadges(container: HTMLElement, name: string): void {
    container.empty()
    const labels: Record<string, string> = {
      vision: '视觉',
      tools: '工具',
      reasoning: '思考',
      imageGen: '生图',
      webSearch: '搜索',
      jsonMode: 'JSON',
      fileUnderstanding: '文件',
    }
    for (const f of CAP_FIELDS) {
      if (this.getEffectiveCap(name, f.key)) {
        container.createSpan({ cls: 'UNagent-cap-badge', text: labels[f.key] })
      }
    }
  }

  /** Render the expandable capability editor panel. */
  private renderCapEditor(
    container: HTMLElement,
    modelName: string,
    badgesEl: HTMLElement,
  ): void {
    // Capability checkboxes grid
    const grid = container.createDiv('UNagent-cap-grid')
    for (const f of CAP_FIELDS) {
      const cell = grid.createDiv('UNagent-cap-cell')
      const cb = cell.createEl('input', { type: 'checkbox' })
      cb.checked = this.getEffectiveCap(modelName, f.key)
      const lbl = cell.createEl('label', { text: f.label })
      lbl.prepend(cb)
      cb.addEventListener('change', () => {
        const ov = this.modelOverrides.get(modelName) ?? {}
        if (!ov.capabilities) ov.capabilities = {}
        ov.capabilities[f.key] = cb.checked
        this.modelOverrides.set(modelName, ov)
        this.renderCapBadges(badgesEl, modelName)
      })
    }

    // Numeric fields row
    const numsRow = container.createDiv('UNagent-cap-nums')

    // Context window
    const ctxCell = numsRow.createDiv('UNagent-cap-num-cell')
    ctxCell.createEl('label', { text: '上下文窗口', cls: 'UNagent-cap-num-label' })
    const ctxInput = ctxCell.createEl('input', { type: 'number' })
    const ctxVal = this.getEffectiveNum(modelName, 'contextWindow')
    if (ctxVal !== undefined) ctxInput.value = String(ctxVal)
    ctxInput.placeholder = '自动'
    ctxInput.addEventListener('change', () => {
      const v = ctxInput.value.trim()
      const ov = this.modelOverrides.get(modelName) ?? {}
      ov.contextWindow = v ? Number(v) : undefined
      this.modelOverrides.set(modelName, ov)
    })

    // Max output tokens
    const maxCell = numsRow.createDiv('UNagent-cap-num-cell')
    maxCell.createEl('label', { text: '最大输出', cls: 'UNagent-cap-num-label' })
    const maxInput = maxCell.createEl('input', { type: 'number' })
    const maxVal = this.getEffectiveNum(modelName, 'maxOutputTokens')
    if (maxVal !== undefined) maxInput.value = String(maxVal)
    maxInput.placeholder = '不限制'
    maxInput.addEventListener('change', () => {
      const v = maxInput.value.trim()
      const ov = this.modelOverrides.get(modelName) ?? {}
      ov.maxOutputTokens = v ? Number(v) : undefined
      this.modelOverrides.set(modelName, ov)
    })

    // Reset button — clears override, reverts to preset/heuristic defaults
    const resetRow = container.createDiv('UNagent-cap-reset-row')
    const resetBtn = resetRow.createEl('button', {
      text: '重置为默认',
      cls: 'UNagent-cap-reset clicking',
    })
    resetBtn.addEventListener('click', () => {
      this.modelOverrides.delete(modelName)
      container.empty()
      this.renderCapEditor(container, modelName, badgesEl)
      this.renderCapBadges(badgesEl, modelName)
    })
  }
}
