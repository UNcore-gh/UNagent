// LLM provider abstraction.
//
// Every provider implements `LLMProvider.streamChat`, an async generator that
// yields a unified `StreamChunk` stream. This is the single seam the rest of
// the app talks to — Phase 2 (agent tool-calling) reuses the same `tool-call`
// chunk type, so we define it now even though Phase 1 only consumes `text`.
//
// Deliberately NO SDK (no `openai`, no LangChain): native `fetch` + hand-written
// SSE keeps the bundle tiny and mobile-safe (three iron rules).

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** A completed tool call (used by the Phase 2 agent loop). */
export interface ToolCall {
  id: string
  name: string
  /** Accumulated JSON arguments string. */
  arguments: string
}

export interface ChatMessage {
  role: Role
  content: string
  /** Present on assistant messages that invoked tools. */
  toolCalls?: ToolCall[]
  /** Present on `tool` messages: the id of the tool call being answered. */
  toolCallId?: string
  /** Image data URLs attached to a user message (multimodal/vision). When
   *  present, the OpenAI-compatible adapter emits `content` as an array of
   *  text + image_url parts instead of a plain string. Ephemeral — not
   *  persisted with conversation history (re-read from vault on each send). */
  images?: string[]
}

/** Incremental piece of a tool call streamed by the model (Phase 2). */
export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  /** Partial JSON fragment; concatenate across chunks for one tool call. */
  arguments?: string
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'content-filter'
  | 'other'

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/** One source link returned by a server-side web search. */
export interface WebSearchSource {
  url: string
  title?: string
}

/** The unified streaming payload every provider emits. */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; toolCall: ToolCallDelta }
  /** Server-side built-in web search progress (Responses API vendors execute
   *  the search themselves; the client only observes). `searching` fires when
   *  the search item appears in the stream, `done` when it completes with its
   *  source list. Neither affects the LLM history — the server owns it. */
  | {
      type: 'web-search'
      status: 'searching' | 'done'
      /** Stable id of the search item (tracks the block across deltas). */
      id: string
      query?: string
      sources?: WebSearchSource[]
    }
  | { type: 'finish'; reason: FinishReason; usage?: TokenUsage }

/** JSON-Schema tool definition passed to the model (Phase 2). */
export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface StreamChatOptions {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  /**
   * Conversation-level reasoning intensity (Claude Code style). Support is
   * provider-dependent: OpenAI-compatible endpoints map it to
   * `reasoning_effort` (ignored by servers that don't know it); Anthropic
   * maps any non-off level to adaptive extended thinking.
   */
  thinking?: ThinkLevel
}

/** Reasoning intensity levels; 'off' means the provider's default behavior. */
export type ThinkLevel = 'off' | 'think' | 'think-hard' | 'ultrathink'

export interface LLMProvider {
  readonly id: string
  streamChat(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    options?: StreamChatOptions,
  ): AsyncGenerator<StreamChunk>
}
