// A native Obsidian prompt modal for naming a conversation (branch naming +
// rename from the conversation manager). First-party Modal → works the same
// on desktop and mobile. Resolves with the trimmed name, or null when the
// user cancels (backdrop/Esc/取消 all count as cancel).

import { App, Modal, Setting } from 'obsidian'

export interface NamePromptOptions {
  /** Modal heading, e.g. "给分支对话命名". */
  title: string
  /** Pre-filled value (usually the source conversation's title). */
  initial?: string
  placeholder?: string
  /** Confirm button text (default "确定"). */
  confirmText?: string
}

export class NameInputModal extends Modal {
  private value: string
  private resolved = false

  constructor(
    app: App,
    private readonly options: NamePromptOptions,
    private readonly onResolve: (name: string | null) => void,
  ) {
    super(app)
    this.value = options.initial ?? ''
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    titleEl.setText(this.options.title)

    new Setting(contentEl).addText((text) => {
      text.setPlaceholder(this.options.placeholder ?? '')
      text.setValue(this.value)
      text.onChange((v) => {
        this.value = v
      })
      // Enter confirms (the prompt is a single field).
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          this.finish(true)
        }
      })
      text.inputEl.style.width = '100%'
    })

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => this.finish(false)),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.options.confirmText ?? '确定')
          .setCta()
          .onClick(() => this.finish(true)),
      )

    // Focus + pre-select so typing immediately replaces the suggestion.
    // (Query the DOM rather than trusting the closure-captured ref — TS
    // doesn't track assignments made inside the addText callback.)
    const input = contentEl.querySelector('input')
    if (input) {
      input.focus()
      input.select()
    }
  }

  onClose(): void {
    this.finish(false)
    this.contentEl.empty()
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) return
    this.resolved = true
    this.onResolve(confirmed ? this.value.trim() : null)
    this.close()
  }
}

/** Promise wrapper — resolves to the trimmed name, or null on cancel. */
export function askName(
  app: App,
  options: NamePromptOptions,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    new NameInputModal(app, options, resolve).open()
  })
}
