// Native Obsidian confirmation modal used before destructive tools run.
// Works identically on desktop and mobile (it's a first-party Modal).

import { App, Modal, Setting } from 'obsidian'
import type { ConfirmRequest } from './types'

export class ConfirmModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private readonly request: ConfirmRequest,
    private readonly onResolve: (confirmed: boolean) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    titleEl.setText(this.request.title || '需要确认')

    contentEl.createEl('p', {
      text: this.request.message,
      cls: 'UNagent-confirm-message',
    })

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => this.finish(false)),
      )
      .addButton((btn) =>
        btn
          .setButtonText('确认执行')
          .setWarning()
          .onClick(() => this.finish(true)),
      )
  }

  onClose(): void {
    // Closing via backdrop/Esc counts as a rejection.
    this.finish(false)
    this.contentEl.empty()
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) return
    this.resolved = true
    this.onResolve(confirmed)
    this.close()
  }
}

/** Returns a confirm() function bound to the given app, for ToolContext. */
export function createConfirm(
  app: App,
): (request: ConfirmRequest) => Promise<boolean> {
  return (request: ConfirmRequest) =>
    new Promise<boolean>((resolve) => {
      new ConfirmModal(app, request, resolve).open()
    })
}

/** 回溯时的三选询问（追加62）：该轮及之后 AI 改过笔记内容时，用户选择
 *  ①连同修改一起回滚 ②仅回溯对话记录（保留 AI 修改）③取消。 */
export type RollbackChoice = 'rollback' | 'keep' | 'cancel'

export class RewindRollbackModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private readonly affected: number,
    private readonly onResolve: (choice: RollbackChoice) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    titleEl.setText('回溯对话')

    contentEl.createEl('p', {
      text: `被移除的对话里 AI 修改了 ${this.affected} 处笔记内容。要一并回滚这些修改，还是只回溯对话记录？`,
      cls: 'UNagent-confirm-message',
    })

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => this.finish('cancel')),
      )
      .addButton((btn) =>
        btn.setButtonText('仅回溯对话').onClick(() => this.finish('keep')),
      )
      .addButton((btn) =>
        btn
          .setButtonText('一并回滚修改')
          .setWarning()
          .onClick(() => this.finish('rollback')),
      )
  }

  onClose(): void {
    // Closing via backdrop/Esc counts as cancel.
    this.finish('cancel')
    this.contentEl.empty()
  }

  private finish(choice: RollbackChoice): void {
    if (this.resolved) return
    this.resolved = true
    this.onResolve(choice)
    this.close()
  }
}

/** Opens the rewind rollback choice modal, resolving the picked option. */
export function askRewindRollback(
  app: App,
  affected: number,
): Promise<RollbackChoice> {
  return new Promise<RollbackChoice>((resolve) => {
    new RewindRollbackModal(app, affected, resolve).open()
  })
}
