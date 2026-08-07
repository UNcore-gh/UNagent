import { App, Modal, Notice, Setting } from 'obsidian'
import type ObsidianAI from '../main'
import { McpModal } from './McpModal'
import { syncMcpTools } from '../core/mcp/mcpManager'
import { MAX_MCP_TOOLS } from './settings'

// McpManageModal — 聊天 /mcp 命令的管理面板：列出已配置的远程 MCP 服务，
// 支持开关 / 编辑 / 删除 / 添加。改动即时落盘并同步工具注册表。
// （与设置页 MCP 面板同一套逻辑，只是弹窗形态，不用跳出聊天。）

export class McpManageModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsidianAI,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('MCP 服务管理')
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
        `远程 MCP 服务的工具自动进入 Agent 工具池。开关 / 删除即时生效；` +
        `工具总数上限 ${MAX_MCP_TOOLS}。添加仅支持 streamableHttp 类型（//add-mcp 技能可查看兼容性说明）。`,
      cls: 'setting-item-description',
    })

    const services = this.plugin.settings.mcp.services
    if (services.length === 0) {
      contentEl.createEl('p', {
        text: '还没有 MCP 服务——点下方「添加 MCP 服务」开始配置。',
        cls: 'setting-item-description',
      })
    }

    for (const service of services) {
      const toolCount = service.tools?.length ?? 0
      const setting = new Setting(contentEl)
        .setName(service.official ? `${service.name}（官方）` : service.name)
        .setDesc(`${service.baseUrl} · 已发现 ${toolCount} 个工具`)
        .addToggle((toggle) =>
          toggle.setValue(service.enabled).onChange(async (value) => {
            service.enabled = value
            await this.plugin.saveSettings()
            this.resync()
            this.renderBody()
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
            .onClick(() => this.openEditor(service.id)),
        )
      // 官方内置服务不可删除——只能开关/编辑。
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
              this.resync()
              new Notice(`已删除 MCP 服务「${service.name}」`)
              this.renderBody()
            }),
        )
      }
    }

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('添加 MCP 服务')
        .onClick(() => this.openEditor(null)),
    )
  }

  /** Add (null) or edit (serviceId) via the shared McpModal. */
  private openEditor(serviceId: string | null): void {
    const existing = serviceId
      ? this.plugin.settings.mcp.services.find((s) => s.id === serviceId) ?? null
      : null
    new McpModal(this.app, existing, async (service) => {
      const services = this.plugin.settings.mcp.services
      const idx = services.findIndex((s) => s.id === service.id)
      if (idx >= 0) services[idx] = service
      else services.push(service)
      await this.plugin.saveSettings()
      const { dropped } = this.resync()
      if (dropped > 0) {
        new Notice(
          `MCP 工具总数超过上限 ${MAX_MCP_TOOLS}，${dropped} 个工具未注册`,
        )
      }
      this.renderBody()
    }).open()
  }

  private resync(): { registered: string[]; dropped: number } {
    return syncMcpTools(
      this.plugin.registry,
      this.plugin.settings.mcp.services,
    )
  }
}
