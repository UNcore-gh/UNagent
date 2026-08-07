// Agent / tool system types. Tools are plain objects with native JSON Schema
// parameters — deliberately NOT LangChain StructuredTool (kept light, per PLAN).

import type { App } from 'obsidian'
import type { ImageProvider } from '../image/base'
import type { SkillRegistry } from '../skills/SkillRegistry'
import type { UndoData } from '../../utils/undoStore'
import type { ApprovalModeId } from './approval'

export type ToolCategory = 'search' | 'read' | 'write' | 'manage'

export interface ToolMetadata {
  /** Stable tool name given to the LLM (snake_case). */
  name: string
  /** What the tool does — shown to the LLM to decide when to call it. */
  description: string
  category: ToolCategory
  /** Destructive tools require an explicit user confirmation before running. */
  destructive: boolean
  /**
   * Always confirm regardless of the user's confirmDestructive setting.
   * Reserved for irreversible actions (delete_note).
   */
  forceConfirm?: boolean
  /** Tools that need a vault to operate (all note tools do). */
  requiresVault: boolean
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>
  /**
   * Desktop-only tool (补刀·五十四, 铁律一修订版): registered ONLY when
   * Platform.isMobile is false, and double-guarded at run time. Reserved for
   * capabilities that need local processes. Currently no tool uses it —
   * run_local_agent was removed when /hermes task dispatch took over; the
   * field and filterToolsForPlatform stay for future desktop-only tools.
   * Mobile code paths must never reach a desktopOnly tool.
   */
  desktopOnly?: boolean
  /** 追加87: 远程 MCP 工具的归属服务 id（普通工具无此字段）。Agent 级
   *  MCP 服务开关按它过滤——服务关掉时其全部工具一并移除。 */
  mcpServiceId?: string
}

/** A confirmation prompt surfaced to the user before a destructive tool runs. */
export interface ConfirmRequest {
  toolName: string
  title: string
  message: string
}

/** AI-initiated question (追加63, ask_user tool): the agent asks the user for
 *  key information / a decision mid-run, offering preset quick answers but
 *  always leaving a free-input box open. */
export interface AskQuestion {
  /** The question text, shown at the top of the panel. */
  question: string
  /** 2-4 preset quick answers (optional — the user may type freely anyway). */
  options?: string[]
  /**
   * 追加77: 多选模式——选项为 checkbox 风格，用户勾选多项后点击确认按钮
   * 统一提交，提交值 = 所选选项以 ", " 连接；默认 false（单选点击即提交）。
   */
  multiSelect?: boolean
}

/** Multi-question batch (追加76): one ask_user call asks several questions
 *  sequentially — the panel shows one at a time and moves on after each
 *  answer, collecting all answers before the tool resolves. */
export interface AskQuestionBatch {
  /** 2+ questions asked one after another. */
  questions: AskQuestion[]
}

export interface AskResult {
  /** The user's answer ('' when cancelled). Single-question: that answer;
   *  batch: the first answer (see answers for the full list). */
  answer: string
  /** Batch mode: all answers collected so far (may be partial when the user
   *  dismissed the panel mid-batch). Undefined for single-question asks. */
  answers?: string[]
  /** True when the user dismissed the panel without finishing. */
  cancelled: boolean
}

export interface ToolContext {
  app: App
  signal?: AbortSignal
  /** Resolve a destructive-action confirmation; true = user approved. */
  confirm: (request: ConfirmRequest) => Promise<boolean>
  /**
   * AI-initiated question (追加63): ask the user for key info / a decision
   * mid-run. Resolves when the user answers (free text or a preset option)
   * or dismisses the panel. Optional — tools must degrade when absent.
   */
  askUser?: (q: AskQuestion | AskQuestionBatch) => Promise<AskResult>
  /**
   * Record a revertible step so the user can undo the last change.
   * `data` (Task #6) is the serializable snapshot persisted to undo.json so the
   * entry survives restarts — convId/turnNo are filled in by the caller's
   * wrapper when it has conversation context.
   */
  pushUndo: (label: string, revert: () => Promise<void>, data?: UndoData) => void
  /** Image generation provider built from current settings. */
  imageProvider: ImageProvider
  /** Whether destructive tools ask for confirmation (default true).
   *   M2-T8 起被 approvalMode 取代（legacy 布尔；agentRunner 在未传
   *   approvalMode 时回落它，兼容既有调用方与测试）。 */
  confirmDestructive?: boolean
  /**
   * 审批模式（M2-T8 主 agent 还原，与 hermes 同套语义）：决定破坏性工具
   * 执行前是否弹审批面板。default = 每次弹；accept_edits = 编辑类
   * （category 'write'）放行、其余仍弹；dont_ask = 全放行。
   * forceConfirm 工具（delete_note）永远确认，任何模式不豁免。
   * 缺省 undefined = 回落 confirmDestructive 旧逻辑。
   */
  approvalMode?: ApprovalModeId
  /**
   * This run's skill view (master toggle + disabled list already applied by
   * the caller). Undefined when the caller doesn't wire skills in.
   */
  skills?: SkillRegistry
  /** Skill names the user disabled — lets load_skill report "disabled" vs "not found". */
  disabledSkills?: string[]
  /**
   * Effective excluded folders (Obsidian's userIgnoreFilters + plugin
   * custom list, merged by the caller). search_notes skips files under them.
   */
  excludedFolders?: string[]
  /** Base folder for AI data (memory note etc.). Default 'AI 助手'. */
  aiFolder?: string
}

export interface ToolRunResult {
  ok: boolean
  /** Short human-readable summary for the chat UI. */
  summary: string
  /** Structured payload fed back to the LLM (JSON-stringified by the runner). */
  output: unknown
}

export interface Tool {
  metadata: ToolMetadata
  /** Optional custom confirmation wording; defaults to a JSON dump of args. */
  confirmSummary?: (args: Record<string, unknown>) => string
  run: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolRunResult>
}
