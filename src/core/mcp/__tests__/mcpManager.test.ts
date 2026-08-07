// mcpManager — registry sync idempotency: enable/disable services, the
// MAX_MCP_TOOLS cap, and re-sync never duplicating or leaking tools.

import { ToolRegistry } from '../../agent/ToolRegistry'
import { syncMcpTools, resetMcpManagerState } from '../mcpManager'
import { MAX_MCP_TOOLS, type McpService } from '../../../settings/settings'

function mkService(id: string, name: string, toolCount: number, enabled = true): McpService {
  return {
    id,
    name,
    baseUrl: 'https://x/mcp',
    authHeader: '',
    enabled,
    tools: Array.from({ length: toolCount }, (_, i) => ({
      name: `tool_${i}`,
      description: `工具 ${i}`,
    })),
  }
}

describe('syncMcpTools', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = ToolRegistry.getInstance()
    registry.clear()
    resetMcpManagerState()
  })

  it('registers cached tools of enabled services only', () => {
    const { registered, dropped } = syncMcpTools(registry, [
      mkService('a', 'svc-a', 2),
      mkService('b', 'svc-b', 1, false),
    ])
    expect(dropped).toBe(0)
    expect(registered.sort()).toEqual(['svc-a__tool_0', 'svc-a__tool_1'])
    expect(registry.getByName('svc-a__tool_0')).toBeDefined()
    expect(registry.getByName('svc-b__tool_0')).toBeUndefined()
  })

  it('disabling a service withdraws its tools on the next sync', () => {
    const svc = mkService('a', 'svc-a', 1)
    syncMcpTools(registry, [svc])
    expect(registry.getByName('svc-a__tool_0')).toBeDefined()

    svc.enabled = false
    syncMcpTools(registry, [svc])
    expect(registry.getByName('svc-a__tool_0')).toBeUndefined()
  })

  it('is idempotent — re-sync does not duplicate registrations', () => {
    const svc = mkService('a', 'svc-a', 2)
    syncMcpTools(registry, [svc])
    syncMcpTools(registry, [svc])
    expect(registry.getAll().filter((t) => t.metadata.name.startsWith('svc-a__'))).toHaveLength(2)
  })

  it('enforces MAX_MCP_TOOLS across services and reports the overflow', () => {
    const { registered, dropped } = syncMcpTools(registry, [
      mkService('a', 'svc-a', MAX_MCP_TOOLS),
      mkService('b', 'svc-b', 3),
    ])
    expect(registered).toHaveLength(MAX_MCP_TOOLS)
    expect(dropped).toBe(3)
  })

  it('never touches non-MCP tools already in the registry', () => {
    registry.register({
      metadata: {
        name: 'read_note',
        description: 'x',
        category: 'read',
        destructive: false,
        requiresVault: true,
        parameters: {},
      },
      run: async () => ({ ok: true, summary: '', output: {} }),
    })
    const svc = mkService('a', 'svc-a', 1)
    syncMcpTools(registry, [svc])
    svc.enabled = false
    syncMcpTools(registry, [svc])
    expect(registry.getByName('read_note')).toBeDefined()
    expect(registry.getAll()).toHaveLength(1)
  })
})
