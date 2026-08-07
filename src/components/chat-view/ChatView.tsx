import { ItemView, WorkspaceLeaf } from 'obsidian'
import { Root, createRoot } from 'react-dom/client'
import type ObsidianAI from '../../main'
import { ICON_NAME, PLUGIN_NAME, VIEW_TYPE_CHAT } from '../../constants'
import { bootLog } from '../../utils/bootLog'
import { ChatApp } from './ChatApp'

export class ChatView extends ItemView {
  private root: Root | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ObsidianAI,
  ) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT
  }

  getDisplayText(): string {
    return PLUGIN_NAME
  }

  getIcon(): string {
    return ICON_NAME
  }

  async onOpen(): Promise<void> {
    // Boot breadcrumb: on a mobile restart Obsidian restores this view AFTER
    // onload finishes, and mounting a React root + rendering a restored
    // conversation is the top suspect for a hard WKWebView crash / OOM. If
    // the exported boot log ends at 'chatview:onOpen-start' (no -rendered),
    // the crash is here. See utils/bootLog.ts.
    await bootLog(this.plugin.app, 'chatview:onOpen-start')
    try {
      const container = this.containerEl.children[1] as HTMLElement | undefined
      if (!container) {
        console.error('[UNagent] ChatView container not found')
        void bootLog(this.plugin.app, 'chatview:onOpen-no-container')
        return
      }
      container.empty()
      container.addClass('UNagent-root')
      // Obsidian's .view-content ships with its own padding (incl. mobile
      // safe-area-inset-bottom). Our React layout manages its own insets via
      // .obsidian-ai-composer-wrap, so zero the host padding inline (beats
      // Obsidian's .view-content CSS rule on specificity). Otherwise the
      // host padding stacks a gap below the composer that survives
      // keyboard-open — the on-screen keyboard covers the safe-area strip,
      // turning that padding into dead space between the input and the keys.
      container.style.padding = '0'
      this.root = createRoot(container)
      this.root.render(<ChatApp plugin={this.plugin} leaf={this.leaf} />)
      void bootLog(this.plugin.app, 'chatview:onOpen-rendered')
    } catch (err) {
      // On mobile WKWebView, createRoot or the initial render can fail
      // during view restoration on startup (resource pressure, timing).
      // Without this guard the error propagates to Obsidian, which disables
      // the plugin. Show a fallback message instead.
      console.error('[UNagent] ChatView onOpen failed:', err)
      void bootLog(
        this.plugin.app,
        `chatview:onOpen-CRASH ${err instanceof Error ? err.message : String(err)}`,
      )
      try {
        const container = this.containerEl.children[1] as HTMLElement | undefined
        container?.empty()
        container?.createEl('div', {
          text: 'AI 面板加载失败，请关闭后重新打开。',
          attr: { style: 'padding:24px;color:var(--text-muted);' },
        })
      } catch {
        // Last resort: silently degrade
      }
    }
  }

  async onClose(): Promise<void> {
    void bootLog(this.plugin.app, 'chatview:onClose')
    this.root?.unmount()
    this.root = null
  }
}
