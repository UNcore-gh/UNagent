// Minimal streamableHttp MCP client — JSON-RPC 2.0 over POST, native fetch,
// zero SDK. Deliberately scoped to the tools surface only:
//   initialize / tools/list / tools/call
// No stdio/WebSocket transport, no OAuth, no resources/prompts/sampling,
// no session-resume state machine. This is a "remote HTTP tool service"
// connector, not a general MCP framework — keep it that way.

import { parseSSE } from '../../utils/sse'

/** JSON-RPC timeout — remote tool calls shouldn't hang a chat turn. */
const MCP_REQUEST_TIMEOUT_MS = 10_000

interface JsonRpcResponse {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export interface McpRequestResult {
  result: unknown
  /** Mcp-Session-Id the server handed out (pass through on later requests). */
  sessionId?: string
}

let rpcIdCounter = 1

/**
 * POST one JSON-RPC request to a streamableHttp MCP endpoint. Handles both
 * response shapes the transport allows: `application/json` body, or
 * `text/event-stream` whose first matching `data:` frame carries the reply.
 */
export async function mcpRequest(
  url: string,
  authHeader: string,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<McpRequestResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (authHeader) headers['Authorization'] = authHeader
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcIdCounter++,
        method,
        params,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('请求超时（超过 10 秒无响应），请检查服务地址与网络')
    }
    throw new Error(
      '网络连接失败，请检查服务地址；若端点未开启跨域访问（CORS）也会出现此错误',
    )
  } finally {
    clearTimeout(timer)
  }

  const nextSessionId = response.headers.get('Mcp-Session-Id') ?? undefined
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`服务端返回 HTTP ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`)
  }
  // 202 Accepted = the server took a notification (no response body).
  if (response.status === 202) {
    return { result: null, sessionId: nextSessionId }
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    for await (const data of parseSSE(response, {
      idleMs: MCP_REQUEST_TIMEOUT_MS,
    })) {
      const frame = safeParse(data)
      if (!frame) continue
      const reply = frame as JsonRpcResponse
      if (reply.error) {
        throw new Error(`服务端错误：${reply.error.message ?? `code ${reply.error.code}`}`)
      }
      if ('result' in reply) {
        return { result: reply.result, sessionId: nextSessionId }
      }
      // Notifications / progress frames — keep reading.
    }
    throw new Error('服务端流结束但未返回结果')
  }

  const text = await response.text()
  const reply = safeParse(text) as JsonRpcResponse | null
  if (!reply) throw new Error('服务端响应不是有效的 JSON-RPC 报文')
  if (reply.error) {
    throw new Error(`服务端错误：${reply.error.message ?? `code ${reply.error.code}`}`)
  }
  return { result: reply.result, sessionId: nextSessionId }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export interface McpSession {
  url: string
  authHeader: string
  sessionId?: string
}

/** initialize handshake; returns the session (with server-issued id). */
export async function mcpInitialize(
  url: string,
  authHeader: string,
): Promise<McpSession> {
  const { sessionId } = await mcpRequest(url, authHeader, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'UNagent', version: '0.1' },
  })
  const session: McpSession = { url, authHeader, sessionId }
  // notifications/initialized is a no-response notification; best effort.
  try {
    await mcpRequest(url, authHeader, 'notifications/initialized', {}, sessionId)
  } catch {
    // Some servers reject notification POSTs — harmless for the tools flow.
  }
  return session
}

/** tools/list on a fresh session; returns discovered tool metadata. */
export async function mcpListTools(
  url: string,
  authHeader: string,
): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
  const session = await mcpInitialize(url, authHeader)
  const { result } = await mcpRequest(
    url,
    authHeader,
    'tools/list',
    {},
    session.sessionId,
  )
  const tools = (result as { tools?: unknown })?.tools
  if (!Array.isArray(tools)) return []
  const raw = tools as Array<Record<string, unknown>>
  return raw
    .filter((t) => typeof t?.name === 'string' && (t.name as string).length > 0)
    .map((t) => ({
      name: t.name as string,
      description: typeof t.description === 'string' ? t.description : undefined,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === 'object'
          ? (t.inputSchema as Record<string, unknown>)
          : undefined,
    }))
}

/**
 * tools/call: fresh initialize + call (stateless per invocation — servers in
 * scope hold no conversation state worth reusing across chat turns).
 * Returns the raw MCP result object ({ content: [...], isError? }).
 */
export async function mcpCallTool(
  url: string,
  authHeader: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = await mcpInitialize(url, authHeader)
  const { result } = await mcpRequest(
    url,
    authHeader,
    'tools/call',
    { name: toolName, arguments: args },
    session.sessionId,
  )
  return result
}
