// TipsModal: 所有插件小提示一览（设置 → 通用 → 小提示）。
// 展示 COMPOSER_HINTS 全部条目的完整列表，帮助用户了解插件提供的
// 各项功能/快捷键/用法。只读，无交互。

import { App, Modal } from 'obsidian'
import { COMPOSER_HINTS } from '../components/chat-view/Composer'

// Lucide 图标名 → 简短描述，辅助阅读。
const TIP_ICON_LABEL: Record<string, string> = {
  at: '@',
  command: '/',
  bot: '子代理',
  zap: '思考',
  'message-square': '顺便一问',
  'rotate-ccw': '回溯',
  list: '对话',
  puzzle: '技能',
}

export class TipsModal extends Modal {
  constructor(app: App) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    titleEl.setText('小提示')

    contentEl.createEl('p', {
      text: '以下是插件提供的全部功能提示，每次打开 AI 对话界面会随机展示一条。',
      cls: 'setting-item-description',
    })

    const list = contentEl.createEl('div', { cls: 'UNagent-tips-list' })

    for (const tip of COMPOSER_HINTS) {
      const label = TIP_ICON_LABEL[tip.icon] ?? tip.icon
      const row = list.createEl('div', { cls: 'UNagent-tips-row' })
      row.createEl('span', { text: label, cls: 'UNagent-tips-icon' })
      row.createEl('span', { text: tip.text, cls: 'UNagent-tips-text' })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}