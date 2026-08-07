// Bridge between remote MCP tools and the plugin's Tool contract.
// MCP tool results are UNTRUSTED content entering the model's context —
// outputs are truncated like read_note (20K chars) to bound prompt-injection
// surface and context cost. Tools are treated as read-only remote queries:
// no confirmation, no vault access, no undo.

import { mcpCallTool } from './mcpClient'
import type { McpService, McpToolMeta } from '../../settings/settings'
import type { Tool } from '../agent/types'

/** Same budget as read_note — one tool result must not dominate a turn. */
const MCP_OUTPUT_MAX_CHARS = 20_000

/** OpenAI-family schemas cap tool names at 64 chars of [a-zA-Z0-9_-]. */
const MAX_TOOL_NAME_LEN = 64

/** Reduce a name to [a-zA-Z0-9_-]: anything else becomes one underscore. */
export function sanitizeNameSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned
}

/**
 * Registered tool name: `{service}__{tool}`, both segments sanitized
 * (Chinese service names fall back to an id-derived segment) and the whole
 * thing capped to the 64-char schema limit.
 */
export function toolNameFor(service: McpService, toolName: string): string {
  let svc = sanitizeNameSegment(service.name)
  if (!svc) svc = `svc_${sanitizeNameSegment(service.id).slice(-6)}`
  svc = svc.slice(0, MAX_TOOL_NAME_LEN - 3) // leave room for '__' + 1 char
  const tool = sanitizeNameSegment(toolName) || 'tool'
  const budget = MAX_TOOL_NAME_LEN - svc.length - 2 // '__' separator
  const toolPart = tool.slice(0, budget)
  return `${svc}__${toolPart}`
}

/** Extract displayable text from an MCP tools/call result ({ content }). */
export function extractMcpText(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content as Array<Record<string, unknown>>) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  // No text content — hand the raw result back stringified (still bounded).
  try {
    return JSON.stringify(result)
  } catch {
    return ''
  }
}

/** Wrap one remote MCP tool as a standard plugin Tool. */
export function makeMcpTool(service: McpService, meta: McpToolMeta): Tool {
  const name = toolNameFor(service, meta.name)
  return {
    metadata: {
      name,
      description: `[MCP: ${service.name}] ${meta.description || meta.name}`,
      category: 'read',
      destructive: false,
      requiresVault: false,
      parameters: meta.inputSchema ?? { type: 'object', properties: {} },
      // 追加87: 服务归属——Agent 级 MCP 开关（settings.perAgent.disabledMcp）
      // 按 service.id 过滤该服务的全部工具。
      mcpServiceId: service.id,
    },
    run: async (args) => {
      try {
        const result = await mcpCallTool(
          service.baseUrl,
          service.authHeader,
          meta.name,
          args,
        )
        const isError = (result as { isError?: unknown })?.isError === true
        let text = extractMcpText(result)
        let truncated = false
        if (text.length > MCP_OUTPUT_MAX_CHARS) {
          text = text.slice(0, MCP_OUTPUT_MAX_CHARS)
          truncated = true
        }
        const summary = isError
          ? `MCP 工具执行失败：${text.slice(0, 80) || '服务端未返回原因'}`
          : `MCP「${meta.name}」${truncated ? '完成（结果过长，已截断）' : '完成'}`
        return {
          ok: !isError,
          summary,
          output: { text, truncated },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          summary: `MCP 工具调用失败：${message}`,
          output: { error: message },
        }
      }
    },
  }
}
