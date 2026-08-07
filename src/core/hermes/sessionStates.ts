// Hermes 会话状态解析（M2-T1/T2）：session/new、session/load 响应里的
// models（SessionModelState）与 modes（SessionModeState）解析成插件侧缓存
// 结构，以及选择窗（/model、审批模式）的行构造。全部纯函数，scripted 帧
// 单测直接覆盖。
//
// 线缆事实（只读核对自 hermes-agent-main/acp_adapter/server.py）：
// - new_session  → NewSessionResponse(session_id, models, modes, field_meta)
// - load_session → LoadSessionResponse(models, modes, field_meta)（无 sessionId）
// - SessionModelState: available_models: ModelInfo[]{model_id/name/description}
//   + current_model_id；model_id 是 hermes 的 encoded choice（形如
//   "provider:model"）——与插件档案 id 完全不同源，**禁止混用**。
// - SessionModeState: current_mode_id + available_modes:
//   SessionMode[]{id/name/description}（default/accept_edits/dont_ask）。
// ACP 线缆一律 camelCase。

import type { HermesModeInfo, HermesModelInfo } from './types'

/* ── 缓存结构 ────────────────────────────────────────────────────────── */

export interface HermesModelState {
  availableModels: HermesModelInfo[]
  currentModelId: string
}

export interface HermesModeState {
  availableModes: HermesModeInfo[]
  currentModeId: string
}

/** 一个 hermes 会话的选择面状态；null = hermes 未下发该清单。 */
export interface HermesSessionStates {
  models: HermesModelState | null
  modes: HermesModeState | null
}

/* ── 解析 ────────────────────────────────────────────────────────────── */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/**
 * 从 session/new / session/load 响应解析模型与模式清单。宽容解析：字段缺失
 * 或畸形 → 对应清单为 null（选择窗显示「清单加载中」，绝不回落插件档案）。
 */
export function parseSessionStates(res: unknown): HermesSessionStates {
  if (!isRecord(res)) return { models: null, modes: null }

  let models: HermesModelState | null = null
  const m = res.models
  if (isRecord(m) && Array.isArray(m.availableModels)) {
    const availableModels: HermesModelInfo[] = []
    for (const row of m.availableModels) {
      if (!isRecord(row) || typeof row.modelId !== 'string' || !row.modelId) {
        continue
      }
      const info: HermesModelInfo = { modelId: row.modelId }
      if (typeof row.name === 'string' && row.name) info.name = row.name
      if (typeof row.description === 'string' && row.description) {
        info.description = row.description
      }
      availableModels.push(info)
    }
    models = {
      availableModels,
      currentModelId: typeof m.currentModelId === 'string' ? m.currentModelId : '',
    }
  }

  let modes: HermesModeState | null = null
  const mo = res.modes
  if (isRecord(mo) && Array.isArray(mo.availableModes)) {
    const availableModes: HermesModeInfo[] = []
    for (const row of mo.availableModes) {
      if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue
      const info: HermesModeInfo = { id: row.id }
      if (typeof row.name === 'string' && row.name) info.name = row.name
      if (typeof row.description === 'string' && row.description) {
        info.description = row.description
      }
      availableModes.push(info)
    }
    modes = {
      availableModes,
      currentModeId: typeof mo.currentModeId === 'string' ? mo.currentModeId : '',
    }
  }

  return { models, modes }
}

/* ── 选择窗行构造（红线：只吃 hermes 清单，未就绪 → 禁用行） ─────────── */

/** 未就绪占位行的固定 id（选择回调必须忽略它）。 */
export const HERMES_PICKER_LOADING_ID = '__hermes_loading__'
/** 未就绪文案（任务书定稿：hermes 清单加载中）。 */
export const HERMES_PICKER_LOADING_LABEL = 'hermes 清单加载中…'

export interface HermesPickerRow {
  /** model_id / mode id —— 直接回传 set_model / set_mode。 */
  id: string
  label: string
  description?: string
  /** hermes 侧的当前项（打「当前」徽章）。 */
  current: boolean
  /** true = 未就绪占位行（禁用选择）。 */
  loading: boolean
}

export interface HermesPickerList {
  /** false = hermes 清单未就绪——rows 只有一行禁用占位，禁止回落。 */
  ready: boolean
  rows: HermesPickerRow[]
}

const loadingList = (): HermesPickerList => ({
  ready: false,
  rows: [
    {
      id: HERMES_PICKER_LOADING_ID,
      label: HERMES_PICKER_LOADING_LABEL,
      description: '清单由 hermes 会话建立/恢复时下发，就绪后方可选择',
      current: false,
      loading: true,
    },
  ],
})

/** /model 选择窗行。**绝不回落插件档案列表**（档案 id ≠ hermes encoded
 *  choice id，混用会诱导用户选到 hermes 拒绝的 id）。 */
export function buildHermesModelRows(
  state: HermesSessionStates | null,
): HermesPickerList {
  const models = state?.models
  if (!models || models.availableModels.length === 0) return loadingList()
  return {
    ready: true,
    rows: models.availableModels.map((m) => ({
      id: m.modelId,
      label: m.name || m.modelId,
      description: m.description,
      current: !!models.currentModelId && m.modelId === models.currentModelId,
      loading: false,
    })),
  }
}

/** 审批模式选择窗行（同款机制，来源 SessionModeState）。 */
export function buildHermesModeRows(
  state: HermesSessionStates | null,
): HermesPickerList {
  const modes = state?.modes
  if (!modes || modes.availableModes.length === 0) return loadingList()
  return {
    ready: true,
    rows: modes.availableModes.map((mo) => ({
      id: mo.id,
      label: mo.name || mo.id,
      description: mo.description,
      current: !!modes.currentModeId && mo.id === modes.currentModeId,
      loading: false,
    })),
  }
}

/** 当前模式 id 是否在该会话的模式清单内（清单内选择 vs 设置兜底的判据）。 */
export function isKnownHermesMode(
  state: HermesSessionStates | null,
  modeId: string,
): boolean {
  return (state?.modes?.availableModes ?? []).some((m) => m.id === modeId)
}
