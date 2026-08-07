// Registry synchronization for remote MCP tools.
//
// Startup-safe by design: syncMcpTools reads ONLY the cached tool metadata
// persisted in settings (data.json) — zero network at boot. Refresh happens
// explicitly from the settings UI (mcpListTools) and re-persists the cache.

import { MAX_MCP_TOOLS, type McpService } from '../../settings/settings'
import type { ToolRegistry } from '../agent/ToolRegistry'
import { makeMcpTool, toolNameFor } from './mcpTools'

/** Names we registered last sync — so we can withdraw them before re-adding. */
let registeredNames: string[] = []

export interface McpSyncResult {
  /** Names registered this pass. */
  registered: string[]
  /** Tools dropped by the MAX_MCP_TOOLS cap (schema bloat guard). */
  dropped: number
}

/**
 * Idempotent: withdraws previously registered MCP tools, then re-registers
 * from the current settings view (enabled services × cached tool metadata).
 * Never touches non-MCP tools.
 */
export function syncMcpTools(
  registry: ToolRegistry,
  services: McpService[],
): McpSyncResult {
  for (const name of registeredNames) registry.unregister(name)
  registeredNames = []

  const registered: string[] = []
  let dropped = 0
  const seen = new Set<string>()

  for (const service of services) {
    if (!service.enabled) continue
    for (const meta of service.tools ?? []) {
      if (registered.length >= MAX_MCP_TOOLS) {
        dropped++
        continue
      }
      const name = toolNameFor(service, meta.name)
      // Name collisions (two services naming identically) — first wins.
      if (seen.has(name) || registry.getByName(name)) {
        dropped++
        continue
      }
      seen.add(name)
      registry.register(makeMcpTool(service, meta))
      registered.push(name)
    }
  }

  registeredNames = registered
  return { registered, dropped }
}

/** Test helper / teardown: forget tracking without touching the registry. */
export function resetMcpManagerState(): void {
  registeredNames = []
}
