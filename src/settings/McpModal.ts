import { App, Modal, Notice, Setting } from 'obsidian'
import {
  McpService,
  McpToolMeta,
  genMcpServiceId,
} from './settings'
import { mcpListTools } from '../core/mcp/mcpClient'

// McpModal — 添加/编辑一个 streamableHttp 远程 MCP 服务。
// 「测试并刷新工具」跑 initialize + tools/list，发现的工具清单缓存在
// service.tools 里（启动时零网络注册，靠这份缓存）。
//
// 边界提示：只支持 streamableHttp 传输；stdio/OAuth 等复杂形态不做。

export class McpModal extends Modal {
  private readonly id: string
  private name = ''
  private baseUrl = ''
  private authHeader = ''
  /** Discovered tools from the last successful refresh. */
  private tools: McpToolMeta[] | undefined
  /** Carried over from the original so an edit never downgrades them. */
  private enabled: boolean
  private official: boolean | undefined
  private testing = false
  private testError: string | null = null

  constructor(
    app: App,
    original: McpService | null,
    private readonly onSave: (service: McpService) => Promise<void>,
  ) {
    super(app)
    this.id = original?.id ?? genMcpServiceId()
    this.name = original?.name ?? ''
    this.baseUrl = original?.baseUrl ?? ''
    this.authHeader = original?.authHeader ?? ''
    this.tools = original?.tools
    this.enabled = original?.enabled ?? true
    this.official = original?.official
  }

  onOpen(): void {
    this.titleEl.setText(this.name ? '编辑 MCP 服务' : '添加 MCP 服务')
    this.renderBody()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private renderBody(): void {
    const { contentEl } = this
    contentEl.empty()

    contentEl.createEl('p', {
      text:
        '仅支持 streamableHttp 类型的远程 MCP（JSON-RPC over HTTP）。' +
        '发现的工具会以「服务名__工具名」注册进 Agent 工具池，结果自动截断防上下文膨胀。',
      cls: 'setting-item-description',
    })

    new Setting(contentEl)
      .setName('名称')
      .setDesc('显示名，同时是注册工具名的前缀。')
      .addText((text) =>
        text
          .setPlaceholder('如：百炼联网搜索')
          .setValue(this.name)
          .onChange((value) => {
            this.name = value
          }),
      )

    new Setting(contentEl)
      .setName('服务地址')
      .setDesc('streamableHttp 端点 URL（必须以 http(s):// 开头）。')
      .addText((text) =>
        text
          .setPlaceholder('https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp')
          .setValue(this.baseUrl)
          .onChange((value) => {
            this.baseUrl = value
          }),
      )

    new Setting(contentEl)
      .setName('Authorization')
      .setDesc('完整的认证头值，如 Bearer sk-xxx。留空则不带认证。')
      .addText((text) =>
        text
          .setPlaceholder('Bearer sk-...')
          .setValue(this.authHeader)
          .onChange((value) => {
            this.authHeader = value
          }),
      )

    const testRow = new Setting(contentEl)
    testRow.addButton((button) =>
      button
        .setButtonText(this.testing ? '连接中…' : '测试并刷新工具')
        .setCta()
        .setDisabled(this.testing)
        .onClick(() => void this.testConnection()),
    )

    if (this.testError) {
      contentEl.createEl('p', {
        text: `连接失败：${this.testError}`,
        cls: 'setting-item-description mod-warning',
      })
    }

    if (this.tools && this.tools.length > 0) {
      new Setting(contentEl)
        .setName(`已发现 ${this.tools.length} 个工具`)
        .setHeading()
      for (const tool of this.tools) {
        new Setting(contentEl)
          .setName(tool.name)
          .setDesc(tool.description || '（无描述）')
      }
    }

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('保存')
        .setCta()
        .setDisabled(this.testing)
        .onClick(() => void this.save()),
    )
  }

  private async testConnection(): Promise<void> {
    const url = this.baseUrl.trim()
    if (!/^https?:\/\//i.test(url)) {
      this.testError = '服务地址必须以 http:// 或 https:// 开头'
      this.renderBody()
      return
    }
    this.testing = true
    this.testError = null
    this.renderBody()
    try {
      const tools = await mcpListTools(url, this.authHeader.trim())
      this.tools = tools
      this.testError = null
      new Notice(
        tools.length > 0
          ? `连接成功，发现 ${tools.length} 个工具`
          : '连接成功，但该服务未声明任何工具',
      )
    } catch (err) {
      this.testError = err instanceof Error ? err.message : String(err)
    } finally {
      this.testing = false
      this.renderBody()
    }
  }

  private async save(): Promise<void> {
    const name = this.name.trim()
    const url = this.baseUrl.trim()
    if (!name) {
      new Notice('请填写名称')
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      new Notice('请填写有效的服务地址')
      return
    }
    // enabled/official 从原服务原样带回——编辑只允许改三要素和刷新工具，
    // 不能把官方服务「编辑成」普通服务（否则删除按钮会复活）。
    const service: McpService = {
      id: this.id,
      name,
      baseUrl: url,
      authHeader: this.authHeader.trim(),
      enabled: this.enabled,
      tools: this.tools,
    }
    if (this.official) service.official = true
    await this.onSave(service)
    this.close()
  }
}
