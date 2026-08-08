import { AbstractInputSuggest, App, ButtonComponent, Modal, Notice, Platform, PluginSettingTab, Setting, setIcon, TFolder } from 'obsidian'
import type ObsidianAI from '../main'
import { aiFolderExclusion, effectiveExclusions, getObsidianExcludedFolders } from '../utils/exclusions'
import { migrateDataFolder } from '../utils/evolutionSetup'
import { normalizeAiFolder } from '../utils/conversationStore'
import { removePath } from '../utils/vaultIO'
import { commandFallbacks, runLocalAgent } from '../core/desktop/localAgent'
import { getHermesHub } from '../core/hermes/hermesHub'
import { buildAuthGuideText } from '../core/hermes/authGuide'
import { getRetrievalIndexer } from '../core/retrieval/indexer'
import { refineCatalog } from '../core/retrieval/catalog'
import { createLLMProvider } from '../core/llm/manager'
import {
  APPROVAL_MODES,
  APPROVAL_MODE_LABEL,
} from '../core/agent/approval'
import { VendorModal } from './VendorModal'
import { McpModal } from './McpModal'
import { TipsModal } from './TipsModal'
import { syncMcpTools } from '../core/mcp/mcpManager'
import {
  ModelCapabilities,
  ModelVendor,
  PROVIDER_PRESETS,
  genModelId,
  genVendorId,
  resolveCapabilities,
  resolveActiveModel,
  resolveEmbeddingModel,
  MAIN_AGENT_KEY,
  MAX_MCP_TOOLS,
  McpService,
  agentOverrides,
  setAgentTool,
  setAgentSkill,
  setAgentMcp,
} from './settings'

// Settings are split into five panels behind a horizontal tab bar (scrollable
// on narrow screens): 通用 / 模型 / Agent / 技能 / MCP. The active tab
// survives re-renders triggered by dropdown changes.

type TabId =
  | 'general'
  | 'model'
  | 'agent'
  | 'skill'
  | 'mcp'
  | 'retrieval'
  | 'hermes'

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'model', label: '模型', icon: 'cpu' },
  { id: 'agent', label: 'Agent', icon: 'command' },
  { id: 'skill', label: '技能', icon: 'puzzle' },
  { id: 'mcp', label: 'MCP', icon: 'plug' },
  { id: 'retrieval', label: '检索', icon: 'scan-search' },
  // 补刀·五十六: hermes 的一切设置收进这里（桌面专属，移动端隐藏）。
  ...(Platform.isMobile
    ? []
    : [{ id: 'hermes' as TabId, label: 'Hermes', icon: 'terminal' }]),
]

const SIZE_OPTIONS = ['1024x1024', '1792x1024', '1024x1792', '512x512']

/**
 * 追加64: 数据文件夹联想选择器 —— 输入时列出 vault 内已有文件夹（空输入
 * 展示全部），按包含匹配过滤，点击/回车快速选择。点开头文件夹不被
 * Obsidian 索引，天然不出现（手动输入隐藏路径仍可行）。
 */
class FolderSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onPick: (path: string) => void,
  ) {
    super(app, inputEl)
    this.limit = 0 // 全量展示，不截断
  }

  getSuggestions(query: string): string[] {
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b, 'zh'))
    const q = query.trim().toLowerCase()
    if (!q) return folders
    return folders.filter((p) => p.toLowerCase().includes(q))
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value)
  }

  selectSuggestion(value: string): void {
    this.onPick(value)
    this.close()
  }
}

export class SettingTab extends PluginSettingTab {
  plugin: ObsidianAI
  /** Remembers the open panel across this.display() re-renders. */
  private activeTab: TabId = 'model'
  /** 追加64: 已提交（迁移）过的数据文件夹路径 —— 只在值真正变化时迁移。 */
  private committedAiFolder = ''
  /** 二级设置页状态：当前打开的 agent 二级页（主 agent = MAIN_AGENT_KEY），
   *  null = 停在一级列表。跨 display() 重渲染保留。 */
  private agentDetail: string | null = null
  /** 二级设置页状态：当前打开的技能分类二级页（官方 / 第三方）。 */
  private skillDetail: 'builtin' | 'user' | null = null
  /** 二级设置页状态：当前打开的 MCP 分类二级页（官方 / 第三方）。
   *  追加87: 与 skillDetail 同构——一级页两行分类，二级页逐服务管理。 */
  private mcpDetail: 'official' | 'user' | null = null

  constructor(app: App, plugin: ObsidianAI) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass('UNagent-settings')

    const nav = containerEl.createDiv('UNagent-settings-nav')
    const pane = containerEl.createDiv('UNagent-settings-pane')

    const activate = (id: TabId) => {
      this.activeTab = id
      nav.querySelectorAll<HTMLElement>('.obsidian-ai-settings-tab').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.tab === id),
      )
      pane.empty()
      this.renderPane(pane, id)
    }

    for (const tab of TABS) {
      const btn = nav.createEl('button', {
        cls: 'UNagent-settings-tab',
        attr: { type: 'button', 'data-tab': tab.id },
      })
      setIcon(btn.createSpan('UNagent-settings-tab-icon'), tab.icon)
      btn.createSpan({ text: tab.label })
      btn.addEventListener('click', () => {
        if (this.activeTab !== tab.id) activate(tab.id)
      })
    }

    activate(this.activeTab)
  }

  private renderPane(pane: HTMLElement, id: TabId): void {
    switch (id) {
      case 'general':
        this.renderGeneral(pane)
        break
      case 'model':
        this.renderModel(pane)
        break
      case 'agent':
        this.renderAgent(pane)
        break
      case 'skill':
        this.renderSkill(pane)
        break
      case 'mcp':
        this.renderMcp(pane)
        break
      case 'retrieval':
        this.renderRetrieval(pane)
        break
      case 'hermes':
        this.renderHermes(pane)
        break
    }
  }

  /* ── 通用 ─────────────────────────────────────────────── */

  private renderGeneral(pane: HTMLElement): void {
    pane.createEl('p', {
      text: '插件整体行为与安全策略。',
      cls: 'setting-item-description',
    })

    new Setting(pane).setName('安全').setHeading()

    new Setting(pane)
      .setName('审批模式')
      .setDesc(
        '主 agent 执行破坏性操作（编辑 / 改名 / 移动等）前的放行策略：' +
          '「默认」每次都弹面板征求同意；' +
          '「自动（编辑放行）」文件编辑自动放行，删除 / 移动等仍问；' +
          '「免询（全部放行）」全部自动放行。' +
          '「删除笔记」无论何种模式，永远强制确认。',
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(
            Object.fromEntries(
              APPROVAL_MODES.map((id) => [id, APPROVAL_MODE_LABEL[id]]),
            ),
          )
          .setValue(this.plugin.settings.safety.approvalMode)
          .onChange(async (value) => {
            this.plugin.settings.safety.approvalMode =
              value as (typeof APPROVAL_MODES)[number]
            await this.plugin.saveSettings()
          })
      })

    new Setting(pane)
      .setName('撤销栈')
      .setDesc(
        '最近 20 次笔记修改可在对话框顶部「撤销」一键回滚；重启后从数据文件夹恢复（undo.json）。',
      )

    /* 引用内联（Task #8） */
    new Setting(pane).setName('对话与引用').setHeading()

    new Setting(pane)
      .setName('@引用内容内联')
      .setDesc(
        '消息里 @ 提到笔记（[[笔记]]）时，发送前如何把笔记内容带给 AI：' +
          '「仅链接」只保留链接文字，AI 需要时自己用 read_note 读取；' +
          '「摘要摘录」自动附带每篇笔记的前 2000 字（最多 4 篇，超出降级为链接）；' +
          '「全文」自动附带全文（单篇上限 8000 字）。' +
          '内联只作用于发给模型的那一份消息，不落盘、不改变你看到的消息。',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('link', '仅链接')
          .addOption('excerpt', '摘要摘录')
          .addOption('full', '全文')
          .setValue(this.plugin.settings.general.mentionInline)
          .onChange(async (value) => {
            this.plugin.settings.general.mentionInline = value as
              | 'link'
              | 'excerpt'
              | 'full'
            await this.plugin.saveSettings()
          }),
      )

    /* 聊天角色名称 */
    new Setting(pane).setName('聊天角色名称').setHeading()

    new Setting(pane)
      .setName('你的称呼')
      .setDesc('消息气泡上方的角色名，默认「你」。纯界面显示，不影响发给模型的文本。')
      .addText((text) => {
        // 追加㊳（用户报：删字删不干净）：输入时只存原值，不再逼回默认
        // 字——清空后允许继续打字，空值在显示端回落「你」。
        text
          .setPlaceholder('你')
          .setValue(this.plugin.settings.general.userName)
          .onChange((value: string) => {
            this.plugin.settings.general.userName = value
            void this.plugin.saveSettings()
          })
      })

    new Setting(pane)
      .setName('AI 的称呼')
      .setDesc('AI 回答气泡上方的角色名，默认「AI」。纯界面显示，不影响发给模型的文本。')
      .addText((text) => {
        // 同「你的称呼」（追加㊳）：空值在显示端回落「AI」。
        text
          .setPlaceholder('AI')
          .setValue(this.plugin.settings.general.assistantName)
          .onChange((value: string) => {
            this.plugin.settings.general.assistantName = value
            void this.plugin.saveSettings()
          })
      })

    // 追加㉛：「默认模型」区块（文本/视觉/生图三选择器 + 生图尺寸/保存
    // 文件夹）已搬到「模型」页厂商列表上方，本页不再重复。

    /* 存储位置（本库） */
    new Setting(pane).setName('存储位置（本库）').setHeading()

    pane.createEl('p', {
      text:
        '本插件写入的所有文件都在当前 vault 内，各处存储位置均可自定义（相对 vault 根目录）。' +
        '默认的数据文件夹「AI 助手」是可见文件夹——里面的 agent.md（助手人设）、user.md（用户画像）、' +
        'memory.md（长期记忆）都是普通笔记，随时可以点开查看和手工编辑（改动在下一次新对话生效）。' +
        '若改成以「.」开头的文件夹则会从文件列表隐藏（插件读写不受影响）。' +
        '切换数据文件夹后，旧文件夹里的数据会自动迁移到新位置（重名文件两边都保留，不会覆盖）；' +
        '改动立即生效——对话列表、技能与子代理会自动重新加载，无需重新打开对话视图。',
      cls: 'setting-item-description',
    })

    new Setting(pane)
      .setName('数据文件夹（进化文件 + 对话历史）')
      .setDesc(
        '三个自我进化文件（agent.md / user.md / memory.md）与对话历史（conversations/ 及 index.json）都存放在这个文件夹下；' +
          '技能（skills/）与子代理（agents/）是其下的标准子文件夹，统一由这里管理（追加45）。' +
          '输入时下方会列出库内已有文件夹可快速选择（联想搜索），也可以直接输入路径；' +
          '提交（失焦 / 回车 / 选择列表项）后旧数据自动迁移到新文件夹。',
      )
      .addText((text) => {
        const initial = this.plugin.settings.general.aiFolder
        // 本次渲染时的已提交值 —— 首次渲染 = 当前设置；重渲染时取最新保存值。
        this.committedAiFolder = initial
        text
          .setPlaceholder('AI 助手')
          .setValue(initial)
          .onChange((value) => {
            // 击键时仅更新内存值（联想过滤实时生效）；迁移在提交时执行。
            this.plugin.settings.general.aiFolder = value.trim()
          })
        const commit = async (): Promise<void> => {
          const next = this.plugin.settings.general.aiFolder.trim()
          const prev = this.committedAiFolder
          if (!next || next === prev) return
          this.committedAiFolder = next
          if (prev) {
            const res = await migrateDataFolder(this.plugin.app, prev, next)
            if (res && (res.moved > 0 || res.skipped > 0)) {
              new Notice(
                `数据已迁移：「${prev}」→「${next}」` +
                  `（${res.moved} 个文件` +
                  `${res.skipped > 0 ? `，${res.skipped} 个重名跳过` : ''}）`,
              )
            }
          }
          await this.plugin.saveSettings()
        }
        // 失焦 / 回车 = 提交（触发迁移 + 保存）。
        text.inputEl.addEventListener('blur', () => {
          void commit()
        })
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            text.inputEl.blur()
          }
        })
        // 追加64: 联想搜索 —— 库内已有文件夹列表，快速选择。
        new FolderSuggest(this.plugin.app, text.inputEl, (path) => {
          text.setValue(path)
          this.plugin.settings.general.aiFolder = path.trim()
          void commit()
        })
      })

    new Setting(pane)
      .setName('自动隐藏数据文件夹')
      .setDesc(
        '开启后，数据文件夹自动排除在 @ 引用选择器与 search_notes 之外' +
          '（等同于一条自动维护的排除项，记忆 / 对话 / 技能数据不会混进笔记结果）。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.general.hideAiFolder)
          .onChange(async (value) => {
            this.plugin.settings.general.hideAiFolder = value
            await this.plugin.saveSettings()
            this.display()
          }),
      )

    /* 追加㊽：通用页的「技能文件夹」设置已移除——skill 页面有同名项（同一
     * 设置双控件会不同步），与上方「生图保存文件夹」同款处理。 */

    /* 排除文件夹 */
    new Setting(pane).setName('排除文件夹').setHeading()

    const folders = this.plugin.settings.general.excludedFolders
    new Setting(pane)
      .setDesc(
        '被排除的文件夹（及其子文件夹）不会出现在 @ 引用选择器中，也不会被 AI 的 search_notes 搜索到。' +
        'Obsidian 自身的「设置 → 文件与链接 → 排除文件」列表始终生效；下方列表是插件级的自定义补充。',
      )
      .addButton((button) =>
        button
          .setButtonText('添加排除文件夹')
          .setCta()
          .onClick(async () => {
            folders.push('')
            await this.plugin.saveSettings()
            this.display()
          }),
      )
    const obsidianFolders = getObsidianExcludedFolders(this.app)
    new Setting(pane)
      .setName('跟随 Obsidian「排除文件」')
      .setDesc(
        obsidianFolders.length > 0
          ? `当前生效：${obsidianFolders.join('、')}`
          : 'Obsidian 当前没有排除文件夹（可在「设置 → 文件与链接 → 排除文件」中配置）。',
      )

    const autoHidden = aiFolderExclusion(
      this.plugin.settings.general.hideAiFolder,
      this.plugin.settings.general.aiFolder,
    )
    if (autoHidden.length > 0) {
      new Setting(pane)
        .setName('已自动隐藏 AI 数据文件夹')
        .setDesc(
          `${autoHidden.join('、')} —— 可在上方「存储位置（本库）→ 自动隐藏数据文件夹」处关闭。`,
        )
    }

    folders.forEach((folder, index) => {
      new Setting(pane)
        .addText((text) =>
          text
            .setPlaceholder('文件夹路径，如 archive 或 daily/2024')
            .setValue(folder)
            .onChange(async (value) => {
              folders[index] = value
              await this.plugin.saveSettings()
            }),
        )
        .addButton((button) =>
          button
            .setIcon('x')
            .setTooltip('移除该排除文件夹')
            .onClick(async () => {
              folders.splice(index, 1)
              await this.plugin.saveSettings()
              this.display()
            }),
        )
    })

    /* 命令面板（M2-T4: 用户自定义隐藏名单，按引擎；硬编码层不可解禁） */
    new Setting(pane).setName('命令面板').setHeading()

    const hiddenCmd = this.plugin.settings.general.hiddenCommands ?? {
      core: [],
      hermes: [],
    }
    const renderHiddenCommandsRow = (
      engine: 'core' | 'hermes',
      name: string,
      desc: string,
    ) => {
      new Setting(pane)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder('命令名用英文逗号分隔，如 tools, queue')
            .setValue((hiddenCmd[engine] ?? []).join(', '))
            .onChange(async (value) => {
              const names = value
                .split(',')
                .map((s) => s.trim().replace(/^\//, ''))
                .filter(Boolean)
              this.plugin.settings.general.hiddenCommands = {
                ...hiddenCmd,
                [engine]: names,
              }
              await this.plugin.saveSettings()
            }),
        )
    }
    renderHiddenCommandsRow(
      'core',
      '隐藏命令（内置引擎）',
      '在 / 命令面板中隐藏这些插件命令（填命令名，不带斜杠）。仅做加法——能力门控已隐藏的命令不受此影响。',
    )
    renderHiddenCommandsRow(
      'hermes',
      '隐藏命令（Hermes 引擎）',
      '在 / 命令面板中隐藏这些命令（插件命令与 Hermes 通告命令同名生效）。' +
        'Hermes 通告的九条命令默认全部露出，此处只做加法隐藏。',
    )

    /* 自我进化（进化 B 案：AI 反思建议） */
    new Setting(pane).setName('自我进化').setHeading()

    new Setting(pane)
      .setName('AI 反思建议')
      .setDesc(
        '每隔几轮实质对话，AI 自动复盘一次并提出建议：值得记住的长期信息（记忆/用户画像）或值得结晶成技能的做法。' +
          '建议只显示在对话界面供你确认，绝不自动保存——点 ✓ 才写入，点 × 忽略。' +
          '每次复盘消耗一次额外的模型调用（频率已节流）；关闭后仍可随时用 /learn 手动结晶技能。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.general.reflectSuggestions)
          .onChange(async (value) => {
            this.plugin.settings.general.reflectSuggestions = value
            await this.plugin.saveSettings()
          }),
      )

    /* 本地代理设置已整体迁入「Hermes」选项卡（补刀·五十六）。 */

    /* 小提示 */
    new Setting(pane).setName('小提示').setHeading()

    new Setting(pane)
      .setDesc('每次打开 AI 对话界面会随机展示一条用法提示。点击下方按钮可查看全部提示列表。')
      .addButton((button) =>
        button
          .setButtonText('查看全部小提示')
          .setCta()
          .onClick(() => {
            new TipsModal(this.app).open()
          }),
      )

    /* 诊断与反馈 */
    new Setting(pane).setName('诊断与反馈').setHeading()

    const diagOn = this.plugin.settings.general.diagnostics
    new Setting(pane)
      .setName('记录诊断日志')
      .setDesc(
        '默认关闭：插件完全不记录任何内容，零额外开销。' +
          '遇到问题时先开启本开关，再复现一次问题，然后点下方「导出日志」把记录发给开发者排查。' +
          '日志只记录运行活动（启动阶段、模型请求状态、工具调用结果、错误信息），' +
          '绝不记录 API 密钥、请求内容或笔记正文。',
      )
      .addToggle((toggle) =>
        toggle.setValue(diagOn).onChange(async (value) => {
          this.plugin.settings.general.diagnostics = value
          // Immediate effect: no display() re-render needed for the logger,
          // but re-render so the export/clear buttons appear/disappear.
          await this.plugin.saveSettings()
          this.display()
        }),
      )

    if (diagOn) {
      new Setting(pane)
        .setName('导出日志')
        .setDesc(
          '把诊断日志写入数据文件夹下的一篇可见笔记并尝试复制到剪贴板——把笔记内容发给开发者即可。' +
            '建议：复现完问题后立即导出（日志只保留最近 1500 行）。',
        )
        .addButton((button) =>
          button
            .setButtonText('导出日志')
            .setCta()
            .onClick(async () => {
              await this.plugin.exportDiagnosticLog()
            }),
        )
        .addButton((button) =>
          button
            .setButtonText('清空日志')
            .setTooltip('删除已记录的诊断日志（开始新一轮记录前清理旧内容）')
            .onClick(async () => {
              await this.plugin.clearDiagnosticLog()
              new Notice('诊断日志已清空')
            }),
        )
    }
  }

  /** A dropdown that selects a default model from all configured vendor models. */
  private renderModelSelector(
    pane: HTMLElement,
    name: string,
    desc: string,
    currentId: string | null,
    vendors: ModelVendor[],
    onChange: (value: string) => Promise<void>,
    filter?: (vendor: ModelVendor, model: { id: string; name: string; capabilities?: ModelCapabilities }) => boolean,
    extra?: (setting: Setting) => void,
  ): void {
    const allModels: Array<{ id: string; label: string }> = []
    for (const v of vendors) {
      for (const m of v.models) {
        if (filter && !filter(v, m)) continue
        allModels.push({ id: m.id, label: `${v.name} · ${m.name}` })
      }
    }
    // 追加㊹：已选项不在候选里时如实显示，不再静默装成「未配置」——
    // 要么模型被删/改名导致 id 悬空，要么能力标记变了被过滤器排除；
    // 两种情况都保留原值（resolveActiveImage 等解析链仍按 id 工作），
    // 让用户看见「失效」而不是误以为没保存上。
    let staleLabel: string | null = null
    if (currentId && !allModels.some((m) => m.id === currentId)) {
      let foundName: string | null = null
      for (const v of vendors) {
        const hit = v.models.find((m) => m.id === currentId)
        if (hit) {
          foundName = `${v.name} · ${hit.name}`
          break
        }
      }
      staleLabel = foundName
        ? `${foundName}（能力不符，已失效）`
        : '原选模型已不存在（已失效）'
    }
    const setting = new Setting(pane)
      .setName(name)
      .setDesc(desc)
      .addDropdown((dropdown) => {
        if (allModels.length === 0 && !staleLabel) {
          dropdown.addOption('', filter ? '— 暂无符合条件的模型 —' : '— 请先在模型页配置厂商 —')
          dropdown.setDisabled(true)
        } else {
          dropdown.addOption('', '— 不指定 —')
          for (const m of allModels) {
            dropdown.addOption(m.id, m.label)
          }
          if (staleLabel && currentId) {
            dropdown.addOption(currentId, staleLabel)
          }
          dropdown.setDisabled(false)
        }
        dropdown.setValue(currentId ?? '')
        dropdown.onChange(async (value) => {
          await onChange(value)
        })
      })
    if (extra) extra(setting)
  }

  /* ── 模型 ─────────────────────────────────────────────── */

  private renderModel(pane: HTMLElement): void {
    pane.createEl('p', {
      text: 'API Key 保存在本地 data.json（已加入 .gitignore，不会上传）。点击厂商「配置」按钮编辑 API Key、模型列表和协议配置。',
      cls: 'setting-item-description',
    })

    const llm = this.plugin.settings.llm

    // 追加㉛：默认模型选择从「通用」页搬来，置顶在厂商列表上方（配完
    // 厂商直接顺手选默认，不用跨页）。
    new Setting(pane).setName('默认模型').setHeading()

    pane.createEl('p', {
      text: '从下方厂商的模型中选择各场景的默认模型。',
      cls: 'setting-item-description',
    })

    this.renderModelSelector(pane, '默认文本模型', '新会话默认使用的对话模型。可在对话中发 /model 临时切换。',
      this.plugin.settings.llm.activeModelId,
      llm.vendors,
      async (value) => {
        this.plugin.settings.llm.activeModelId = value || null
        await this.plugin.saveSettings()
      },
    )

    this.renderModelSelector(pane, '默认视觉模型', '发送图片时使用的视觉理解模型（如 qwen-vl-plus、glm-4v）。仅显示具备视觉能力的模型。',
      this.plugin.settings.llm.activeVisionModelId,
      llm.vendors,
      async (value) => {
        this.plugin.settings.llm.activeVisionModelId = value || null
        await this.plugin.saveSettings()
      },
      (v, m) => resolveCapabilities(v, m)?.vision === true,
    )

    this.renderModelSelector(pane, '默认生图模型', 'AI 生图使用的模型（仅显示具备生图能力的模型）。点齿轮配置默认尺寸与保存位置。',
      this.plugin.settings.image.activeModelId,
      llm.vendors,
      async (value) => {
        this.plugin.settings.image.activeModelId = value || null
        await this.plugin.saveSettings()
      },
      (v, m) => resolveCapabilities(v, m)?.imageGen === true,
      // 追加㉜：二级选项（尺寸/保存文件夹）收进齿轮弹窗，不再平铺占位。
      (setting) =>
        setting.addButton((button) =>
          button
            .setIcon('lucide-settings')
            .setTooltip('生图选项：默认尺寸、保存文件夹')
            .onClick(() => {
              new ImageOptionsModal(this.app, this.plugin).open()
            }),
        ),
    )

    // 检索 embedding 模型与视觉/生图同款融合：统一厂商列表里挑带
    // embedding 能力的模型；换模型 = 向量索引全量失效，标记重建。
    this.renderModelSelector(pane, '默认检索模型', '语义检索（semantic_search）向量化笔记使用的 embedding 模型（仅显示具备向量化能力的模型）。更换后向量索引会自动重建。',
      this.plugin.settings.llm.activeEmbeddingModelId,
      llm.vendors,
      async (value) => {
        this.plugin.settings.llm.activeEmbeddingModelId = value || null
        await this.plugin.saveSettings()
        getRetrievalIndexer()?.markDirty()
      },
      (v, m) => resolveCapabilities(v, m)?.embedding === true,
    )

    // 追加㉜：「模型厂商」升级为板块标题（setHeading 自带顶部分隔线），
    // 与上方「默认模型」板块明确区分；「＋ 添加厂商」仍挂标题行右侧。
    new Setting(pane)
      .setName('模型厂商')
      .setHeading()
      .setClass('UNagent-section-heading')
      .addButton((button) =>
        button
          .setButtonText('＋ 添加厂商')
          .setCta()
          .onClick(() => {
            const draft: ModelVendor = {
              id: genVendorId(),
              name: '',
              provider: 'openai-compatible',
              baseUrl: '',
              apiKey: '',
              models: [],
            }
            new VendorModal(this.app, draft, {
              isNew: true,
              onSave: async (edited) => {
                llm.vendors.push(edited)
                void this.plugin.saveSettings().then(() => this.display())
              },
            }).open()
          }),
      )
    pane.createEl('p', {
      text: '对话、生图与检索厂商统一管理：生图模型就是协议选「OpenAI 生图」的厂商（或模型能力勾选了「图片生成」）；检索模型是能力勾选了「向量化（检索）」的模型。',
      cls: 'setting-item-description',
    })
    this.renderVendorList(pane, llm.vendors, async () => {
      await this.plugin.saveSettings()
      this.display()
    })
  }

  /** Simplified vendor list: one row per vendor (复制 / 配置 / 删除) + an
   *  add-vendor row with a preset dropdown. No inline model management —
   *  that's all in the VendorModal now. */
  private renderVendorList(
    pane: HTMLElement,
    vendors: ModelVendor[],
    onSave: () => Promise<void>,
  ): void {
    if (vendors.length === 0) {
      pane.createEl('p', {
        text: '还没有厂商 —— 点上方「＋ 添加厂商」新建。',
        cls: 'setting-item-description',
      })
    }

    vendors.forEach((vendor, vIndex) => {
      const providerLabel =
        PROVIDER_PRESETS.find((p) => p.id === vendor.provider)?.label ??
        vendor.provider
      const domain = vendor.baseUrl.trim().replace(/^https?:\/\//, '')
      // 追加㉒: surface the API mode (Responses) instead of the removed
      // extra-params marker.
      const modeLabel =
        vendor.provider === 'openai-compatible' && vendor.apiMode === 'responses'
          ? ' · Responses'
          : ''

      new Setting(pane)
        .setName(vendor.name.trim() || '未命名厂商')
        .setDesc(
          `${vendor.models.length} 个模型 · ${providerLabel}` +
            (domain ? ` · ${domain}` : '') +
            modeLabel,
        )
        .addButton((button) =>
          button
            .setIcon('copy')
            .setTooltip('复制该厂商配置为独立新厂商，可分别调整（如不同地址/不同模型组合）')
            .onClick(() => {
              // 追加43：复制 = 深拷贝整套配置（协议/模式/地址/密钥/模型/能力），
              // 重新生成 id，打开编辑弹窗——保存才落盘，取消即放弃。
              const copy: ModelVendor = {
                ...vendor,
                id: genVendorId(),
                name: `${vendor.name.trim() || '未命名厂商'} · 副本`,
                models: vendor.models.map((m) => ({ ...m, id: genModelId() })),
              }
              new VendorModal(this.app, copy, {
                isNew: true,
                onSave: async (edited) => {
                  vendors.push(edited)
                  await onSave()
                },
              }).open()
            }),
        )
        .addButton((button) =>
          button
            .setButtonText('配置')
            .setTooltip('编辑厂商、模型和协议配置')
            .onClick(() => {
              new VendorModal(this.app, vendor, {
                isNew: false,
                onSave: async (edited) => {
                  Object.assign(vendor, edited)
                  await onSave()
                },
              }).open()
            }),
        )
        .addButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('删除该厂商及其全部模型')
            .onClick(async () => {
              vendors.splice(vIndex, 1)
              await onSave()
            }),
        )
    })

    // 追加㉛：「＋ 添加厂商」按钮已挪到「模型厂商」标题行右侧（renderModel），
    // 列表末尾不再重复。
  }

  /* ── Agent ─────────────────────────────────────── */

  private renderAgent(pane: HTMLElement): void {
    // 二级页：某个 agent 的工具与技能单独配置。
    if (this.agentDetail !== null) {
      // 子代理笔记可能已被外部删除——找不到就退回一级列表。
      if (
        this.agentDetail !== MAIN_AGENT_KEY &&
        !this.plugin.agents.getByName(this.agentDetail)
      ) {
        this.agentDetail = null
      } else {
        this.renderAgentDetail(pane, this.agentDetail)
        return
      }
    }

    pane.createEl('p', {
      text:
        '主 agent 是主对话 AI（人设 = agent.md），子代理是 agents/ 文件夹里一代理一文件夹（主体文件 subagent.md）：' +
        '各自拥有独立多轮对话，在聊天输入框发 /// 切入。' +
        '每个 agent 点「配置」进二级页，可从通用工具池中单独挑选工具、单独开关技能。',
      cls: 'setting-item-description',
    })

    /* 运行限制（Task #8） */
    new Setting(pane).setName('运行限制').setHeading()

    new Setting(pane)
      .setName('工具轮数上限')
      .setDesc(
        '一次回答里 AI 最多进行多少轮实质性工具调用（todo_write 进度汇报轮有少量豁免）；' +
          '达到上限后会让 AI 直接总结收尾。范围 4–24，默认 8。',
      )
      .addSlider((slider) => {
        const clamp = (v: number): number =>
          Math.min(24, Math.max(4, Math.round(v)))
        slider
          .setLimits(4, 24, 1)
          .setDynamicTooltip()
          .setValue(clamp(this.plugin.settings.general.maxToolTurns || 8))
          .onChange(async (value) => {
            const v = clamp(value)
            this.plugin.settings.general.maxToolTurns = v
            if (value !== v) slider.setValue(v)
            await this.plugin.saveSettings()
          })
      })

    new Setting(pane)
      .setName('启用子代理')
      .setDesc('关闭后，/// 面板只剩主对话，已开启的子代理人设也不再注入。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.agents.enabled)
          .onChange(async (value) => {
            this.plugin.settings.agents.enabled = value
            await this.plugin.saveSettings()
            this.display()
          }),
      )

    new Setting(pane).setName('Agent 列表').setHeading()

    /* 主 agent：随插件内置——不可删除也不设总开关（主对话永远存在），
     * 但工具与技能可在二级页自由调整（默认启用全部工具）。 */
    const mainRow = new Setting(pane)
      .setDesc('主对话 AI · 人设：agent.md（整篇注入） · 默认启用全部工具')
      .addButton((button) =>
        button
          .setIcon('lucide-folder-open')
          .setTooltip('定位到人设文件（agent.md）')
          .onClick(() => {
            this.revealPath(
              `${normalizeAiFolder(this.plugin.settings.general.aiFolder)}/agent.md`,
            )
          }),
      )
      .addButton((button) =>
        button
          .setIcon('lucide-settings')
          .setTooltip('二级设置：单独配置该 agent 的工具与技能')
          .onClick(() => {
            this.agentDetail = MAIN_AGENT_KEY
            this.display()
          }),
      )
    setIcon(mainRow.nameEl.createSpan('UNagent-skill-icon'), 'bot')
    mainRow.nameEl.append('主 Agent')

    const allAgents = this.plugin.agents
      .getAll()
      .sort((a, b) => a.name.localeCompare(b.name))
    if (allAgents.length === 0) {
      pane.createEl('p', {
        text:
          '还没有子代理——在聊天里发 /// 选「＋ 新建子代理」描述效果，AI 会经 agent-creator 技能设计人设并创建；' +
          '也可以自己在 agents/ 下新建一个子代理文件夹，里面建 subagent.md（frontmatter 写 name / emoji / description，' +
          '正文就是人设，文件夹名即子代理名）。',
        cls: 'setting-item-description',
      })
    }
    for (const agent of allAgents) {
      const on = !this.plugin.settings.agents.disabled.includes(agent.name)
      const modelSuffix = agent.modelOverride
        ? ` · 模型：${agent.modelOverride}`
        : ''
      const pathSuffix = agent.path ? `（${agent.path}）` : ''
      const setting = new Setting(pane)
        .setDesc(`${agent.description}${modelSuffix}${pathSuffix}`)
        .addToggle((toggle) =>
          toggle.setValue(on).onChange(async (value) => {
            const disabled = new Set(this.plugin.settings.agents.disabled)
            if (value) disabled.delete(agent.name)
            else disabled.add(agent.name)
            this.plugin.settings.agents.disabled = Array.from(disabled)
            await this.plugin.saveSettings()
          }),
        )
        .addButton((button) =>
          button
            .setIcon('lucide-settings')
            .setTooltip('二级设置：单独配置该 agent 的工具与技能')
            .onClick(() => {
              this.agentDetail = agent.name
              this.display()
            }),
        )
      if (agent.path) {
        // 「编辑」= 打开人格笔记手编（markdown 是唯一事实源；改完自动热重载）
        const path = agent.path
        setting.addButton((button) =>
          button
            .setIcon('pencil')
            .setTooltip('打开人格笔记手编')
            .onClick(() => {
              void this.app.workspace.openLinkText(path, '')
            }),
        )
        setting.addButton((button) =>
          button
            .setIcon('lucide-folder-open')
            .setTooltip('在文件列表中定位人格笔记')
            .onClick(() => {
              this.revealPath(path)
            }),
        )
        setting.addButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('删除该子代理（人格笔记一并删除）')
            .onClick(() => {
              void this.deleteAgent(agent.name, path)
            }),
        )
      }
      if (agent.emoji) {
        setting.setName(`${agent.emoji} ${agent.name}`)
      } else {
        setIcon(setting.nameEl.createSpan('UNagent-skill-icon'), 'bot')
        setting.nameEl.append(agent.name)
      }
    }
  }

  /* ── MCP ─────────────────────────────────────────── */

  /** 远程 MCP 服务面板（streamableHttp only）。追加87: 与技能页同构——
   *  一级页「官方 / 第三方」两行分类 + 标题行内嵌「添加 MCP 服务」按钮
   *  （不单独占一行）；点「管理」进二级页逐服务开关/编辑/删除。
   *  聊天里也可用 /mcp 命令快捷管理。 */
  private renderMcp(pane: HTMLElement): void {
    if (this.mcpDetail !== null) {
      this.renderMcpDetail(pane, this.mcpDetail)
      return
    }

    // 追加87补刀: 简介在前、标题行在后——「远程 MCP 服务 + 添加按钮」行
    // 整体下移一行（用户反馈该行位置高了点），按钮仍与标题同行不独立占行。
    pane.createEl('p', {
      text:
        '接入 streamableHttp 类型的远程 MCP（JSON-RPC over HTTP）：发现的工具自动进入 Agent 工具池（上限 8 个，结果按 2 万字符截断），' +
        '可在「Agent → 各 agent 二级页 → MCP 开关」里单独开关。',
      cls: 'setting-item-description',
    })

    // 标题行：按钮与标题同行，不单独占一行（用户指示）。
    new Setting(pane)
      .setName('远程 MCP 服务')
      .setHeading()
      .addButton((button) =>
        button
          .setButtonText('添加 MCP 服务')
          .setCta()
          .setTooltip('添加一个第三方远程 MCP 服务')
          .onClick(() => this.openMcpModal(null)),
      )

    const services = this.plugin.settings.mcp.services
    const officialCount = services.filter((s) => s.official).length
    const userCount = services.length - officialCount

    const officialRow = new Setting(pane)
      .setDesc(
        `${officialCount} 项 · 随插件内置（如百炼联网搜索）· 不可删除，可开关 / 编辑`,
      )
      .addButton((button) =>
        button
          .setButtonText('管理')
          .setTooltip('进入官方 MCP 服务管理页')
          .onClick(() => {
            this.mcpDetail = 'official'
            this.display()
          }),
      )
    setIcon(officialRow.nameEl.createSpan('UNagent-skill-icon'), 'plug')
    officialRow.nameEl.append('官方 MCP')

    const userRow = new Setting(pane)
      .setDesc(`${userCount} 项 · 自定义添加的远程服务 · 可开关 / 编辑 / 删除`)
      .addButton((button) =>
        button
          .setButtonText('管理')
          .setTooltip('进入第三方 MCP 服务管理页')
          .onClick(() => {
            this.mcpDetail = 'user'
            this.display()
          }),
      )
    setIcon(userRow.nameEl.createSpan('UNagent-skill-icon'), 'plug')
    userRow.nameEl.append('第三方 MCP')
  }

  /** 追加87: MCP 二级管理页——官方只能开关/编辑（填密钥/刷新工具清单）；
   *  第三方额外可删除，并带「添加」入口。改动即存并同步工具注册表。 */
  private renderMcpDetail(
    pane: HTMLElement,
    source: 'official' | 'user',
  ): void {
    const isOfficial = source === 'official'

    new Setting(pane).addButton((button) =>
      button.setButtonText('← 返回 MCP 列表').onClick(() => {
        this.mcpDetail = null
        this.display()
      }),
    )

    new Setting(pane)
      .setName(isOfficial ? '官方 MCP' : '第三方 MCP')
      .setHeading()

    pane.createEl('p', {
      text: isOfficial
        ? '官方 MCP 服务随插件内置：不能删除，但可以自由开关、编辑（填写 Authorization / 重新测试并刷新工具清单）。'
        : '第三方 MCP 服务是自定义添加的远程服务：可开关、编辑、删除；编辑时可重新测试并刷新工具清单。',
      cls: 'setting-item-description',
    })

    if (!isOfficial) {
      new Setting(pane)
        .setName('添加服务')
        .setDesc('添加一个 streamableHttp 类型的远程 MCP 服务。')
        .addButton((button) =>
          button
            .setButtonText('＋ 添加 MCP 服务')
            .setCta()
            .onClick(() => this.openMcpModal(null)),
        )
    }

    const services = this.plugin.settings.mcp.services
      .filter((s) => s.official === isOfficial)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (services.length === 0) {
      pane.createEl('p', {
        text: isOfficial
          ? '暂无官方 MCP 服务。'
          : '还没有第三方 MCP 服务——点上方「＋ 添加 MCP 服务」添加。',
        cls: 'setting-item-description',
      })
    }
    for (const service of services) {
      const toolCount = service.tools?.length ?? 0
      const setting = new Setting(pane)
        .setName(service.name)
        .setDesc(`${service.baseUrl} · 已发现 ${toolCount} 个工具`)
        .addToggle((toggle) =>
          toggle.setValue(service.enabled).onChange(async (value) => {
            service.enabled = value
            await this.plugin.saveSettings()
            this.resyncMcpTools()
            this.display()
          }),
        )
        .addButton((button) =>
          button
            .setIcon('pencil')
            .setTooltip(
              service.official
                ? '编辑（填写 Authorization / 重新测试并刷新工具清单）'
                : '编辑（可重新测试并刷新工具清单）',
            )
            .onClick(() => this.openMcpModal(service)),
        )
      // 官方内置服务不可删除——只能开关/编辑（与首启播种纪律配套：
      // 删掉后不会复活，但删除入口本身不提供）。
      if (!service.official) {
        setting.addButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('删除该 MCP 服务')
            .onClick(async () => {
              this.plugin.settings.mcp.services =
                this.plugin.settings.mcp.services.filter(
                  (s) => s.id !== service.id,
                )
              await this.plugin.saveSettings()
              this.resyncMcpTools()
              this.display()
            }),
        )
      }
    }
  }

  /** Open add/edit modal; save = upsert + persist + registry resync. */
  private openMcpModal(existing: McpService | null): void {
    new McpModal(this.app, existing, async (service) => {
      const services = this.plugin.settings.mcp.services
      const idx = services.findIndex((s) => s.id === service.id)
      if (idx >= 0) services[idx] = service
      else services.push(service)
      await this.plugin.saveSettings()
      const { dropped } = this.resyncMcpTools()
      if (dropped > 0) {
        new Notice(
          `MCP 工具总数超过上限 ${MAX_MCP_TOOLS}，${dropped} 个工具未注册`,
        )
      }
      this.display()
    }).open()
  }

  /** Re-register MCP tools from settings; returns the sync result. */
  private resyncMcpTools(): { registered: string[]; dropped: number } {
    return syncMcpTools(this.plugin.registry, this.plugin.settings.mcp.services)
  }

  /* ── 检索 ─────────────────────────────────────────── */

  /** 检索选项卡：混合检索配置。search_notes（关键词，内置免费）始终可用；
   *  semantic_search（语义）默认关闭，需远程 embedding API——向量由远程
   *  计算、本地只存结果（{数据文件夹}/.retrieval/）。改动即存并标记索引
   *  过期，下次同步（事件防抖 / 手动按钮 / 工具调用前）自动重建。 */
  private renderRetrieval(pane: HTMLElement): void {
    pane.createEl('p', {
      text:
        '混合检索：search_notes 关键词检索（内置，无需配置）+ semantic_search 语义检索（远程 embedding）。' +
        'library_index 库目录始终可用（启发式生成，零成本）。',
      cls: 'setting-item-description',
    })

    const r = this.plugin.settings.retrieval

    new Setting(pane).setName('语义检索').setHeading()

    new Setting(pane)
      .setName('启用语义检索')
      .setDesc('开启后 agent 可用 semantic_search 工具（还需在「模型」页配置带向量化能力的 embedding 模型）。')
      .addToggle((toggle) =>
        toggle.setValue(r.semanticEnabled).onChange(async (value) => {
          r.semanticEnabled = value
          await this.plugin.saveSettings()
          getRetrievalIndexer()?.markDirty()
          this.display()
        }),
      )

    // embedding 模型已并入统一厂商体系（与视觉/生图同款）：这里只展示
    // 当前解析结果；添加/挑选去「模型」页（厂商里加模型并勾选「向量化
    // （检索）」能力，再选为「默认检索模型」）。
    const embModel = resolveEmbeddingModel(this.plugin.settings.llm)
    const embSetting = new Setting(pane)
      .setName('Embedding 模型')
      .setDesc(
        embModel
          ? `${embModel.displayName} · ${embModel.model}${embModel.apiKey.trim() ? '' : ' · ⚠ 该厂商尚未填写 API 密钥'}`
          : '未配置——去「模型」页添加厂商与模型（如百炼 text-embedding-v4），勾选「向量化（检索）」能力后选为「默认检索模型」。',
      )
    if (!embModel) {
      embSetting.addButton((button) =>
        button
          .setButtonText('去模型页配置')
          .onClick(() => {
            this.activeTab = 'model'
            this.display()
          }),
      )
    }

    new Setting(pane).setName('向量索引').setHeading()

    const st = getRetrievalIndexer()?.status()
    const statusDesc =
      st && st.count > 0
        ? `${st.count} 个文本块 · 最后更新 ${new Date(st.updatedAt).toLocaleString()} · ${st.model || '未知模型'}` +
          (st.dirty ? ' · 有待同步的变更' : '')
        : '尚未建立索引' + (st?.dirty ? '（有待同步的变更）' : '')
    new Setting(pane)
      .setName('索引状态')
      .setDesc(statusDesc)
      .addButton((button) =>
        button
          .setButtonText('立即更新索引')
          .setCta()
          .onClick(async () => {
            const idx = getRetrievalIndexer()
            if (!idx || !idx.channelReady()) {
              new Notice('语义检索未就绪：请先打开上方开关并填写 API 密钥。')
              return
            }
            button.setDisabled(true).setButtonText('索引中…')
            try {
              const rep = await idx.syncNow()
              if (!rep.synced) {
                new Notice('索引未更新：语义检索通道未就绪。')
              } else {
                new Notice(
                  `索引已更新：新增 ${rep.added}、变更 ${rep.updated}、移除 ${rep.removed}，共 ${rep.total} 块。`,
                )
              }
            } catch (err) {
              new Notice(
                `索引更新失败：${err instanceof Error ? err.message : String(err)}`,
              )
            } finally {
              this.display()
            }
          }),
      )

    new Setting(pane).setName('库目录').setHeading()
    pane.createEl('p', {
      text:
        'library_index 工具的目录由启发式自动提取（标题 + 首句 + 标签，零成本）。' +
        '「AI 精炼」可让当前激活模型批量生成一句话摘要（每请求 50 篇，增量缓存）。',
      cls: 'setting-item-description',
    })
    new Setting(pane)
      .setName('AI 精炼目录摘要')
      .setDesc('为尚无 AI 摘要的笔记生成一句话摘要。会消耗当前激活模型的 token。')
      .addButton((button) =>
        button
          .setButtonText('AI 精炼目录摘要')
          .onClick(() => void this.refineCatalogRun(button)),
      )
  }

  /** AI 精炼库目录：用当前激活模型批量（50 篇/请求）生成一句话摘要，
   *  增量缓存到 catalog.json。按钮上实时显示进度。 */
  private async refineCatalogRun(button: ButtonComponent): Promise<void> {
    const resolved = resolveActiveModel(this.plugin.settings.llm)
    const provider = createLLMProvider({
      provider: resolved.provider,
      apiMode: resolved.apiMode,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    })
    const aiFolder = normalizeAiFolder(this.plugin.settings.general.aiFolder)
    const excluded = effectiveExclusions(
      this.app,
      this.plugin.settings.general.excludedFolders,
      [aiFolder],
    )
    button.setDisabled(true).setButtonText('精炼中…')
    try {
      const refined = await refineCatalog(
        this.app,
        aiFolder,
        excluded,
        provider,
        (done, total) => {
          button.setButtonText(`精炼中 ${done}/${total}`)
        },
      )
      new Notice(
        refined > 0
          ? `AI 精炼完成：新增 ${refined} 条摘要。`
          : '所有笔记已有 AI 摘要，无需调用。',
      )
    } catch (err) {
      new Notice(`AI 精炼失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.display()
    }
  }

  /**
   * Hermes 选项卡（补刀·五十六，桌面专属）：hermes 的一切设置——两个入口
   * （/hermes 任务分发命令 / engine: hermes 代理会话）共用这里的配置。
   * 移动端整页不渲染（TABS 已过滤）。
   */
  private renderHermes(pane: HTMLElement): void {
    if (Platform.isMobile) return
    const cfg = this.plugin.settings.localAgent

    pane.createEl('p', {
      text:
        '本机 Hermes 代理（桌面专属）。两个入口共用以下配置：' +
        '/hermes 任务分发（把复杂任务交给 hermes 执行、结果进对话历史）、' +
        '以及 engine: hermes 的子代理会话（流式 + 工具可视化 + 权限审批）。' +
        'hermes 需已安装并完成它自己的模型配置（终端里 hermes --version 可用）。',
      cls: 'setting-item-description',
    })

    // M2-T3: initialize 明确告知 hermes 未配置任何 provider 凭据时，
    // 页顶醒目提示（hub 未连接过则不显示——未知 ≠ 无凭据）。
    const hub = getHermesHub()
    if (hub.connected && hub.noCredentials) {
      pane.createEl('p', {
        text:
          '⚠ 检测到本机 Hermes 尚未配置任何模型服务商凭据（initialize 只通告了终端配置入口）。' +
          '请按下方「首次配置指引」完成配置后再使用。',
        cls: 'setting-item-description mod-warning',
      })
    }

    new Setting(pane)
      .setName('启用 Hermes 集成')
      .setDesc(
        '关闭后两个入口都不可用（移动端本来就没有此功能）。' +
          '开启后对话窗口右上角即显示「Hermes」模式按钮（点击切换 ' +
          'Hermes ⇄ 主对话模式，高亮 = 当前在 Hermes 模式），' +
          '无论 Hermes 窗口是否打开都常驻。',
      )
      .addToggle((toggle) =>
        toggle.setValue(cfg.enabled).onChange(async (value) => {
          cfg.enabled = value
          await this.plugin.saveSettings()
        }),
      )

    // 补刀·六十：启动预热策略（状态灯语义的开关）——开 = 重启后后台自动
    // 连接（灯几秒变绿，首次发送零等待）；关 = 按需连接（重启后灯保持灰色，
    // 使用时才连接）。仅管启动时那一次；交互触发的预热不受影响。
    new Setting(pane)
      .setName('启动时后台预热')
      .setDesc(
        '开启：Obsidian 启动后自动在后台连接 Hermes 并预备会话' +
          '（右上角状态灯几秒后变绿 = 随时可用，首次发送不用等）。' +
          '关闭：按需连接——重启后状态灯保持灰色（未连接），' +
          '切入 Hermes 模式或开始对话时才连接（首次使用多等几秒，' +
          '但不用 Hermes 时不会拉起进程）。改动在下次重启 Obsidian 后生效。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(cfg.autoWarmup !== false)
          .onChange(async (value) => {
            cfg.autoWarmup = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(pane)
      .setName('Hermes 命令')
      .setDesc('hermes CLI 的命令或完整路径；留空 = 用 PATH 中的 hermes（找不到时自动尝试常见安装位置）。')
      .addText((text) =>
        text
          .setPlaceholder('hermes')
          .setValue(cfg.command)
          .onChange(async (value) => {
            cfg.command = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(pane)
      .setName('任务超时（分钟）')
      .setDesc('单次委托/单轮对话的墙钟上限，超时自动终止。hermes 自身没有内置超时。')
      .addText((text) =>
        text
          .setValue(String(Math.round(cfg.timeoutMs / 60000)))
          .onChange(async (value) => {
            const minutes = Number.parseFloat(value)
            if (!Number.isFinite(minutes) || minutes <= 0) return
            cfg.timeoutMs = Math.round(minutes * 60000)
            await this.plugin.saveSettings()
          }),
      )

    new Setting(pane)
      .setName('审批模式')
      .setDesc(
        'hermes 操作你电脑时的放行策略（仅影响交互式会话与 /hermes）：' +
          '「每次都问」最稳——危险命令和文件编辑都会弹确认；' +
          '「库内编辑自动放行」只放行 vault 内的文件改动，危险命令仍会问；' +
          '「全自动」除敏感路径（.git/.ssh/.env/密钥）外一律自动放行。',
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption('default', '每次都问（推荐）')
          .addOption('accept_edits', '库内编辑自动放行')
          .addOption('dont_ask', '全自动（除敏感路径）')
          .setValue(cfg.approvalMode)
          .onChange(async (value) => {
            cfg.approvalMode = value as typeof cfg.approvalMode
            await this.plugin.saveSettings()
          })
      })

    new Setting(pane)
      .setName('模型覆盖')
      .setDesc(
        '可选：交互式会话固定用的模型（provider:model 形式，如 openrouter:anthropic/claude-…）。' +
          '留空 = 用 hermes 自己 config.yaml 配置的模型。',
      )
      .addText((text) =>
        text
          .setPlaceholder('留空 = hermes 默认')
          .setValue(cfg.model)
          .onChange(async (value) => {
            cfg.model = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(pane)
      .setName('配置指引入口')
      .setDesc(
        '可选。Hermes 缺少凭据时展示的配置指引会附带这个地址' +
          '（为托管配置服务预留；留空 = 指引只含本机终端自助步骤）。',
      )
      .addText((text) =>
        text
          .setPlaceholder('留空 = 仅终端自助配置指引')
          .setValue(cfg.guidedEndpoint)
          .onChange(async (value) => {
            cfg.guidedEndpoint = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    // M2-T3: 首次配置指引（与失败提示共用 buildAuthGuideText 措辞）——
    // 端点只来自上面的设置项，文案构造不含任何硬编码 URL。
    const guide = pane.createEl('p', {
      cls: 'setting-item-description',
    })
    guide.setCssStyles({ whiteSpace: 'pre-line' })
    guide.createEl('strong', { text: '首次配置指引（hermes 未配置凭据时看这里）' })
    guide.createEl('br')
    guide.appendText(buildAuthGuideText(cfg.guidedEndpoint))

    new Setting(pane)
      .setName('检测 Hermes')
      .setDesc('跑一次 hermes acp --check，验证安装与依赖是否就绪。')
      .addButton((button) =>
        button.setButtonText('检测').onClick(async () => {
          button.setDisabled(true).setButtonText('检测中…')
          try {
            const command = cfg.command.trim() || 'hermes'
            const res = await runLocalAgent({
              command,
              fallbackCommands: commandFallbacks(command),
              args: ['acp', '--check'],
              cwd: '/',
              timeoutMs: 20000,
            })
            if (res.error) {
              new Notice(`未找到 hermes：${res.error}`)
            } else if (res.ok) {
              new Notice('Hermes ACP 就绪 ✓')
            } else {
              new Notice(
                `Hermes 自检未通过（exit ${res.exitCode}）：${res.stderrTail || res.output || '无输出'}`,
              )
            }
          } finally {
            this.display()
          }
        }),
      )
  }

  /**
   * Agent 二级设置页：为单个 agent（主 agent 或子代理）单独挑选工具、
   * 单独开关技能。改动即存。
   */
  private renderAgentDetail(pane: HTMLElement, agentKey: string): void {
    const isMain = agentKey === MAIN_AGENT_KEY
    const def = isMain ? null : this.plugin.agents.getByName(agentKey)

    new Setting(pane).addButton((button) =>
      button.setButtonText('← 返回 Agent 列表').onClick(() => {
        this.agentDetail = null
        this.display()
      }),
    )

    const head = new Setting(pane).setDesc(
      isMain
        ? '主对话 AI · 人设：agent.md（整篇注入）——官方内置，不可删除。'
        : def
          ? `${def.description}${def.path ? `（${def.path}）` : ''}`
          : '',
    )
    if (!isMain) {
      head.addToggle((toggle) =>
        toggle
          .setValue(!this.plugin.settings.agents.disabled.includes(agentKey))
          .onChange(async (value) => {
            const disabled = new Set(this.plugin.settings.agents.disabled)
            if (value) disabled.delete(agentKey)
            else disabled.add(agentKey)
            this.plugin.settings.agents.disabled = Array.from(disabled)
            await this.plugin.saveSettings()
          }),
      )
    }
    if (isMain) {
      setIcon(head.nameEl.createSpan('UNagent-skill-icon'), 'bot')
      head.nameEl.append('主 Agent')
    } else if (def?.emoji) {
      head.setName(`${def.emoji} ${def.name}`)
    } else if (def) {
      setIcon(head.nameEl.createSpan('UNagent-skill-icon'), 'bot')
      head.nameEl.append(def.name)
    }

    /* 工具挑选：本 agent 的启用选择 */
    new Setting(pane).setName('工具启用').setHeading()
    pane.createEl('p', {
      text:
        '为该 agent 挑选适合的工具，关闭后该 agent 的对话不再执行它，其他 agent 不受影响。' +
        (isMain ? '主 agent 默认启用全部工具。' : ''),
      cls: 'setting-item-description',
    })
    const overrides = agentOverrides(this.plugin.settings.agents, agentKey)
    const perToolsOff = new Set(overrides.disabledTools ?? [])
    for (const tool of this.plugin.registry.getAll()) {
      const { name, description, category } = tool.metadata
      const globalOn =
        !this.plugin.settings.agents.disabledTools.includes(name)
      new Setting(pane)
        .setName(name)
        .setDesc(
          `${description} · ${category}${globalOn ? '' : ' · 已在通用层关闭'}`,
        )
        .addToggle((toggle) =>
          toggle
            .setValue(globalOn && !perToolsOff.has(name))
            .setDisabled(!globalOn)
            .onChange(async (value) => {
              setAgentTool(this.plugin.settings.agents, agentKey, name, value)
              await this.plugin.saveSettings()
            }),
        )
    }

    /* 技能开关：全局清单 ∩ 本 agent 选择 */
    new Setting(pane).setName('技能开关').setHeading()
    pane.createEl('p', {
      text:
        '为该 agent 单独开关技能；全局已关的技能显示为灰色（回「技能」页打开）。' +
        '关闭的技能对该 agent 的对话不再注入，其他 agent 不受影响。',
      cls: 'setting-item-description',
    })
    const perSkillsOff = new Set(overrides.disabledSkills ?? [])
    const allSkills = this.plugin.skills
      .getAll()
      .sort(
        (a, b) =>
          Number(a.source === 'user') - Number(b.source === 'user') ||
          a.metadata.name.localeCompare(b.metadata.name),
      )
    for (const skill of allSkills) {
      const { name, description } = skill.metadata
      const sourceLabel = skill.source === 'builtin' ? '官方' : '第三方'
      const globalOn =
        this.plugin.settings.skills.enabled &&
        !this.plugin.settings.skills.disabled.includes(name)
      new Setting(pane)
        .setName(name)
        .setDesc(
          `${sourceLabel} · ${description}${globalOn ? '' : ' · 已在全局关闭'}`,
        )
        .addToggle((toggle) =>
          toggle
            .setValue(globalOn && !perSkillsOff.has(name))
            .setDisabled(!globalOn)
            .onChange(async (value) => {
              setAgentSkill(this.plugin.settings.agents, agentKey, name, value)
              await this.plugin.saveSettings()
            }),
        )
    }

    /* 追加87: MCP 开关——与技能开关同构：全局启用 ∩ 本 agent 选择 */
    new Setting(pane).setName('MCP 开关').setHeading()
    pane.createEl('p', {
      text:
        '为该 agent 单独开关远程 MCP 服务；在「MCP」页已关闭的服务显示为灰色（回 MCP 页打开）。' +
        '关闭后该 agent 的对话不再执行该服务的任何工具，其他 agent 不受影响。',
      cls: 'setting-item-description',
    })
    const perMcpOff = new Set(overrides.disabledMcp ?? [])
    const mcpServices = this.plugin.settings.mcp.services
    if (mcpServices.length === 0) {
      pane.createEl('p', {
        text: '还没有 MCP 服务——去「MCP」页添加。',
        cls: 'setting-item-description',
      })
    }
    for (const service of mcpServices) {
      const globalOn = service.enabled
      const toolCount = service.tools?.length ?? 0
      new Setting(pane)
        .setName(service.name)
        .setDesc(
          `${service.official ? '官方' : '第三方'} · ${service.baseUrl} · ` +
            `${toolCount} 个工具${globalOn ? '' : ' · 已在 MCP 页关闭'}`,
        )
        .addToggle((toggle) =>
          toggle
            .setValue(globalOn && !perMcpOff.has(service.id))
            .setDisabled(!globalOn)
            .onChange(async (value) => {
              setAgentMcp(this.plugin.settings.agents, agentKey, service.id, value)
              await this.plugin.saveSettings()
            }),
        )
    }
  }

  /** 删除子代理：确认后删人格笔记，清掉设置里的残留名单，重扫注册表。 */
  private async deleteAgent(name: string, path: string): Promise<void> {
    const ok = await this.plugin.confirm({
      toolName: 'settings',
      title: '删除子代理',
      message: `将删除「${name}」的人格笔记（${path}），删除后不可恢复。其历史对话仍保留在对话列表，同文件夹下的其他数据文件（如进度笔记）保留。确定删除？`,
    })
    if (!ok) return
    await removePath(this.app, path)
    this.plugin.settings.agents.disabled =
      this.plugin.settings.agents.disabled.filter((n) => n !== name)
    delete this.plugin.settings.agents.perAgent[name]
    await this.plugin.saveSettings()
    await this.plugin.reloadUserAgents()
    this.display()
  }

  /**
   * 在左侧文件列表中定位文件（reveal）。点头文件夹里的文件 Obsidian
   * 不索引，无法定位——提示用户。没有 fileExplorer 内部 API 的构建回落
   * 为直接打开文件。
   */
  private revealPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path)
    const explorer = (
      this.app as unknown as {
        fileExplorer?: { revealForFile?: (file: unknown) => void }
      }
    ).fileExplorer
    if (file && explorer?.revealForFile) {
      explorer.revealForFile(file)
      return
    }
    if (file) {
      void this.app.workspace.openLinkText(path, '')
      return
    }
    new Notice(`该文件在点开头文件夹内（Obsidian 不索引），无法定位：${path}`)
  }

  /* ── 技能 ─────────────────────────────────────────────── */

  private renderSkill(pane: HTMLElement): void {
    // 二级页：官方技能 / 第三方技能 分类管理。
    if (this.skillDetail !== null) {
      this.renderSkillDetail(pane, this.skillDetail)
      return
    }

    pane.createEl('p', {
      text:
        '技能是按需载入的「指令文本」能力包：AI 看到技能名与一句话简介，' +
        '任务匹配时用 load_skill 载入完整指南再行动。全部技能收束为两个分类，' +
        '点「管理」进二级页逐项开关、删除或定位文件。',
      cls: 'setting-item-description',
    })

    new Setting(pane)
      .setName('启用技能')
      .setDesc('关闭后，AI 看不到任何技能，系统提示里也不再列出技能清单。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.skills.enabled)
          .onChange(async (value) => {
            this.plugin.settings.skills.enabled = value
            await this.plugin.saveSettings()
            this.display()
          }),
      )

    const allSkills = this.plugin.skills.getAll()
    const builtinCount = allSkills.filter((s) => s.source === 'builtin').length
    const userCount = allSkills.length - builtinCount

    const builtinRow = new Setting(pane)
      .setDesc(
        `${builtinCount} 项 · 随插件内置、与内置工具一一对应 · 不可修改或删除，可自由开关`,
      )
      .addButton((button) =>
        button
          .setButtonText('管理')
          .setTooltip('进入官方技能管理页')
          .onClick(() => {
            this.skillDetail = 'builtin'
            this.display()
          }),
      )
    setIcon(builtinRow.nameEl.createSpan('UNagent-skill-icon'), 'puzzle')
    builtinRow.nameEl.append('官方技能')

    const userRow = new Setting(pane)
      .setDesc(
        `${userCount} 项 · 数据文件夹 skills/ 下的 Markdown 技能（纯文本，不含可执行代码）`,
      )
      .addButton((button) =>
        button
          .setButtonText('管理')
          .setTooltip('进入第三方技能管理页')
          .onClick(() => {
            this.skillDetail = 'user'
            this.display()
          }),
      )
    setIcon(userRow.nameEl.createSpan('UNagent-skill-icon'), 'puzzle')
    userRow.nameEl.append('第三方技能')
  }

  /**
   * 技能二级管理页：官方技能只能开关；第三方技能额外提供编辑、
   * 定位、删除，以及重新载入 / 新建模板入口。改动即存。
   */
  private renderSkillDetail(
    pane: HTMLElement,
    source: 'builtin' | 'user',
  ): void {
    const isBuiltin = source === 'builtin'

    new Setting(pane).addButton((button) =>
      button.setButtonText('← 返回技能列表').onClick(() => {
        this.skillDetail = null
        this.display()
      }),
    )

    new Setting(pane)
      .setName(isBuiltin ? '官方技能' : '第三方技能')
      .setHeading()

    pane.createEl('p', {
      text: isBuiltin
        ? '官方技能随插件内置、与内置工具一一对应：不能更改和删除，但可以自由选择开关。'
        : '第三方技能是「数据文件夹 → skills/」下的 *.md 与 <子文件夹>/SKILL.md（纯提示文本，不含可执行代码）；' +
          '普通文件夹内的变化会自动热重载；「.」开头的文件夹不发事件，但打开 // 技能选择器时会按需重扫，也可手动「重新载入」。',
      cls: 'setting-item-description',
    })

    if (!isBuiltin) {
      new Setting(pane)
        .setName('新建与重载')
        .setDesc('新建技能模板会写入 skills/ 并打开编辑；重载强制重扫文件夹。')
        .addButton((button) =>
          button.setButtonText('重新载入').onClick(async () => {
            await this.plugin.reloadUserSkills()
            this.display()
          }),
        )
        .addButton((button) =>
          button
            .setButtonText('＋ 新建技能模板')
            .setCta()
            .onClick(() => {
              void this.plugin.createSkillTemplate()
            }),
        )
    }

    const skills = this.plugin.skills
      .getAll()
      .filter((s) => s.source === source)
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    if (skills.length === 0) {
      pane.createEl('p', {
        text: isBuiltin
          ? '暂无官方技能。'
          : '还没有第三方技能——点上方「＋ 新建技能模板」，或在 skills/ 文件夹直接放一个 .md。',
        cls: 'setting-item-description',
      })
    }
    for (const skill of skills) {
      const { name, description, mode, emoji } = skill.metadata
      const on = !this.plugin.settings.skills.disabled.includes(name)
      const modeLabel = mode === 'always' ? '常驻' : '懒载入'
      const pathSuffix = skill.path ? `（${skill.path}）` : ''
      const setting = new Setting(pane)
        .setDesc(`${modeLabel} · ${description}${pathSuffix}`)
        .addToggle((toggle) =>
          toggle.setValue(on).onChange(async (value) => {
            const disabled = new Set(this.plugin.settings.skills.disabled)
            if (value) disabled.delete(name)
            else disabled.add(name)
            this.plugin.settings.skills.disabled = Array.from(disabled)
            await this.plugin.saveSettings()
          }),
        )
      // 官方技能只保留开关；第三方技能额外提供编辑 / 定位 / 删除。
      if (!isBuiltin && skill.path) {
        const path = skill.path
        setting.addButton((button) =>
          button
            .setIcon('pencil')
            .setTooltip('打开技能文件手编')
            .onClick(() => {
              void this.app.workspace.openLinkText(path, '')
            }),
        )
        setting.addButton((button) =>
          button
            .setIcon('lucide-folder-open')
            .setTooltip('在文件列表中定位技能文件')
            .onClick(() => {
              this.revealPath(path)
            }),
        )
        setting.addButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('删除该技能文件')
            .onClick(() => {
              void this.deleteSkill(name, path)
            }),
        )
      }
      // User-defined emoji is respected; everything else gets a Lucide icon
      // so the list matches Obsidian's native chrome.
      if (emoji) {
        setting.setName(`${emoji} ${name}`)
      } else {
        setIcon(setting.nameEl.createSpan('UNagent-skill-icon'), 'puzzle')
        setting.nameEl.append(name)
      }
    }
  }

  /** 删除第三方技能：确认后删文件，清掉设置里的残留名单，重扫注册表。 */
  private async deleteSkill(name: string, path: string): Promise<void> {
    const ok = await this.plugin.confirm({
      toolName: 'settings',
      title: '删除技能',
      message: `将删除技能「${name}」的文件（${path}），删除后不可恢复。确定删除？`,
    })
    if (!ok) return
    await removePath(this.app, path)
    this.plugin.settings.skills.disabled =
      this.plugin.settings.skills.disabled.filter((n) => n !== name)
    await this.plugin.saveSettings()
    await this.plugin.reloadUserSkills()
    this.display()
  }
}

/**
 * 追加㉜：默认生图模型齿轮按钮的二级选项弹窗。
 *
 * 平铺在设置页会占位又低频，收进弹窗：默认尺寸 + 保存文件夹，
 * 改动即存（无需保存按钮）。
 */
class ImageOptionsModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsidianAI,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('生图选项')

    new Setting(this.contentEl)
      .setName('默认尺寸')
      .setDesc('具体支持范围取决于模型；留空则跟随服务商默认')
      .addDropdown((dropdown) => {
        const current = this.plugin.settings.image.size
        dropdown.addOption('', '跟随服务商默认')
        const options = SIZE_OPTIONS.includes(current)
          ? SIZE_OPTIONS
          : current
            ? [current, ...SIZE_OPTIONS]
            : SIZE_OPTIONS
        for (const size of options) dropdown.addOption(size, size)
        dropdown.setValue(current).onChange(async (value) => {
          this.plugin.settings.image.size = value
          await this.plugin.saveSettings()
        })
      })

    new Setting(this.contentEl)
      .setName('保存文件夹')
      .setDesc(
        'AI 生成的图片存入 vault 的目录（相对路径）；粘贴 / 上传的附件也存到这里。' +
          '留空则跟随 Obsidian「文件与链接 → 附件默认存放路径」。',
      )
      .addText((text) =>
        text
          .setPlaceholder('assets/ai-images')
          .setValue(this.plugin.settings.image.attachmentFolder)
          .onChange(async (value) => {
            this.plugin.settings.image.attachmentFolder = value.trim()
            await this.plugin.saveSettings()
          }),
      )
  }
}
