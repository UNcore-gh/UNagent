import { useEffect } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { PluginProvider } from '../../contexts/plugin-context'
import type ObsidianAI from '../../main'
import type { AgentBridge } from './agentBridge'
import { ErrorBoundary } from './ErrorBoundary'
import { useAgent } from './useAgent'

// The ONE owner of the conversation agent (追加⑰). Rendered into a hidden
// root at plugin load so the agent exists even with the chat panel closed —
// the editor's inline box needs it too. useAgent's code is untouched; only
// its call site moved here, and every render publishes the fresh API to the
// bridge (no deps array: publish after EACH commit).
const Publisher = ({ bridge }: { bridge: AgentBridge }) => {
  const api = useAgent()
  useEffect(() => {
    bridge.publish(api)
  })
  return null
}

export const AgentHost = ({
  plugin,
  bridge,
}: {
  plugin: ObsidianAI
  bridge: AgentBridge
}) => {
  return (
    <PluginProvider plugin={plugin}>
      <ErrorBoundary kind="agent-host">
        <Publisher bridge={bridge} />
      </ErrorBoundary>
    </PluginProvider>
  )
}

/** Mount the hidden host root; call the returned Root's unmount on unload.
 *  Plain function (no JSX) so main.ts — a .ts file — can call it. */
export function mountAgentHost(
  plugin: ObsidianAI,
  bridge: AgentBridge,
): Root {
  const container = document.createElement('div')
  const root = createRoot(container)
  root.render(<AgentHost plugin={plugin} bridge={bridge} />)
  return root
}
