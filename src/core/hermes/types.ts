// Hermes ACP wire types (补刀·五十六). Hermes exposes the Agent Client
// Protocol over child-process stdio: newline-delimited JSON-RPC 2.0,
// protocolVersion 1, all field names camelCase on the wire. Source of truth:
// hermes-agent-main/acp_adapter/ (server.py / events.py / tools.py /
// permissions.py / edit_approval.py). Only the subset this plugin uses is
// typed here; unknown fields ride along as index signatures.

import type { ApprovalModeId } from '../agent/approval'

/* ── JSON-RPC frames ─────────────────────────────────────────────────── */

export interface JsonRpcRequestFrame {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponseFrame {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcNotificationFrame {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcFrame =
  | JsonRpcRequestFrame
  | JsonRpcResponseFrame
  | JsonRpcNotificationFrame

/* ── initialize ──────────────────────────────────────────────────────── */

/** initialize 通告的 auth method（hermes 侧 acp_adapter/auth.py）：
 *  已配凭据时额外通告 provider 运行时方法（id=provider 名），并恒通告
 *  id='hermes-setup' 的终端配置入口（type='terminal', args=['--setup']）。
 *  M2-T3：只剩终端入口 = 未配置任何 provider 凭据。 */
export interface AcpAuthMethod {
  id: string
  name?: string
  description?: string
  type?: string
  args?: string[]
}

export interface InitializeResult {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean }
    sessionCapabilities?: Record<string, unknown>
  }
  authMethods?: AcpAuthMethod[]
}

/* ── sessions ────────────────────────────────────────────────────────── */

export interface HermesModelInfo {
  modelId: string
  name?: string
  description?: string
}

export interface HermesModeInfo {
  id: string
  name?: string
  description?: string
}

/** Approval policies hermes supports per session (session/set_mode).
 *  与主 agent 共用同一套模式（core/agent/approval.ts，M2-T8 还原）。 */
export type HermesModeId = ApprovalModeId

export interface NewSessionResult {
  sessionId: string
  models?: {
    availableModels?: HermesModelInfo[]
    currentModelId?: string
  }
  modes?: {
    currentModeId?: string
    availableModes?: HermesModeInfo[]
  }
}

export interface ForkSessionResult {
  sessionId: string
  models?: {
    availableModels?: HermesModelInfo[]
    currentModelId?: string
  }
  modes?: {
    currentModeId?: string
    availableModes?: HermesModeInfo[]
  }
}

export interface ListSessionsResult {
  sessions: Array<{
    sessionId: string
    cwd?: string
    title?: string
    updatedAt?: string
  }>
  nextCursor?: string
}

/* ── streaming updates (session/update notifications) ────────────────── */

export interface AcpTextContent {
  type: 'text'
  text: string
}

/** Tool kind reported by hermes (get_tool_kind). */
export type HermesToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export interface HermesToolCallStart {
  sessionUpdate: 'tool_call'
  toolCallId: string
  title?: string
  kind?: HermesToolKind | string
  content?: unknown
  locations?: unknown
  rawInput?: unknown
}

export interface HermesToolCallUpdate {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  kind?: HermesToolKind | string
  status?: 'completed' | 'failed'
  title?: string
  content?: unknown
  rawOutput?: unknown
}

export interface HermesPlanEntry {
  content: string
  priority?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** session/update payload — discriminated by `sessionUpdate`, tolerant of
 *  unknown kinds (they pass through the catch-all). */
export type HermesSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpTextContent }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpTextContent }
  /** session/load 历史回放专用（acp_adapter/server.py _replay_session_history）：
   *  用户消息以 user_message_chunk 回放。实时轮不会出现此帧。 */
  | { sessionUpdate: 'user_message_chunk'; content: AcpTextContent }
  | HermesToolCallStart
  | HermesToolCallUpdate
  | { sessionUpdate: 'plan'; entries: HermesPlanEntry[] }
  | { sessionUpdate: 'usage_update'; size?: number; used?: number }
  | { sessionUpdate: 'session_info_update'; title?: string; updatedAt?: string }
  | {
      sessionUpdate: 'available_commands_update'
      /** M2-T4: 有参命令带 input（ACP unstructured 形态 { kind, hint }）。 */
      availableCommands?: Array<{
        name: string
        description?: string
        input?: { kind?: string; hint?: string }
      }>
    }
  | { sessionUpdate: string; [key: string]: unknown }

/* ── permission requests (server → client) ───────────────────────────── */

export interface HermesPermissionOption {
  optionId: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
  name?: string
}

export interface HermesPermissionToolCall {
  toolCallId: string
  title?: string
  kind?: string
  status?: string
  content?: Array<
    | { type: 'content'; content: AcpTextContent | { type: string; [k: string]: unknown } }
    | { type: 'diff'; path: string; oldText?: string | null; newText?: string | null }
    | { type: string; [key: string]: unknown }
  >
  rawInput?: unknown
}

export interface HermesPermissionRequest {
  sessionId?: string
  toolCall: HermesPermissionToolCall
  options: HermesPermissionOption[]
}

/** Client answer to a permission request. `optionId` = selected option;
 *  null = user dismissed / cancelled (server treats as deny — fail-closed). */
export interface PermissionDecision {
  optionId: string | null
}

/* ── prompt ──────────────────────────────────────────────────────────── */

export interface PromptResult {
  stopReason?: 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    thoughtTokens?: number
    cachedReadTokens?: number
  }
}
