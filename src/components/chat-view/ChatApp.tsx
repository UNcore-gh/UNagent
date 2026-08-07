import type { WorkspaceLeaf } from 'obsidian'

import { PluginProvider } from '../../contexts/plugin-context'
import { SettingsProvider } from '../../contexts/settings-context'
import type ObsidianAI from '../../main'
import { Chat } from './Chat'
import { ErrorBoundary } from './ErrorBoundary'

// Root React tree for the chat view. Provides plugin + settings context to
// the conversation UI below. An ErrorBoundary at the top ensures one broken
// sub-tree doesn't silently unmount the whole chat (用户报: 大量内容时界面消失).
// The owning leaf is passed down so multi-instance focus dispatch (Alt+Z)
// can target exactly this instance.
export const ChatApp = ({
  plugin,
  leaf,
}: {
  plugin: ObsidianAI
  leaf?: WorkspaceLeaf
}) => {
  return (
    <ErrorBoundary kind="chat-root">
    <PluginProvider plugin={plugin}>
      <SettingsProvider plugin={plugin}>
        <Chat leaf={leaf} />
      </SettingsProvider>
    </PluginProvider>
    </ErrorBoundary>
  )
}
