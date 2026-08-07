// Unified "selection → reference" builder shared by the Option+Z command
// (main.ts) and the composer ＋ button (Composer.tsx, 追加68). Besides notes
// and chat messages it understands:
//   - Memos-plugin cards   → [[Memos/2026.canvas#<节点id>]]「…」 (memos 官方
//     同款链接格式，memos 视图内点击直达该条 memo；不改动 memos 代码，只读它
//     卡片上的 .memos-card[data-memo-id] DOM 属性 + 扫画布 JSON 反查节点所在文件)
//   - Canvas text nodes    → [[画布.canvas#^<节点id>]]「…」（Obsidian 原生节点
//     锚点链接，点击跳转并聚焦该节点；节点 id 靠内容匹配反查，不碰内部 API）
//   - Markdown tables      → 片段升级为「表头: 值」行上下文，裸文字没语义

import { App, FileView, TFile, View } from 'obsidian'

/** Strip markdown markers (highlight ==, bold, code, callout `>` prefixes,
 *  line breaks, …) from a text selection so a selection inside e.g. a
 *  `==高亮==` or a `> [!…]` callout still references cleanly (补刀). */
export function cleanSelection(text: string): string {
  return text
    .replace(/^\s*>\s*/gm, '') // blockquote / callout line markers
    .replace(/==/g, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/[」\n]/g, '')
    .trim()
}

/** Rough markdown-stripping used ONLY for fuzzy content matching (canvas
 *  node text is raw markdown, the selection is rendered text). */
function normalizeForMatch(text: string): string {
  return text
    .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/[*_`#=~>|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Find the .canvas file holding a node with `nodeId` (memos stores every
 *  memo as a canvas text node, 追加68). Files whose basename matches the year
 *  encoded in the memo id go FIRST — memos' default storage is
 *  `Memos/{year}.canvas`, so the happy path reads exactly one file. Reads are
 *  capped so a pathological vault can't stall the shortcut. */
export async function findCanvasFileWithNodeId(
  app: App,
  nodeId: string,
): Promise<TFile | null> {
  const files = app.vault.getFiles().filter((f) => f.extension === 'canvas')
  if (files.length === 0) return null
  const year = /^\d{8}/.test(nodeId) ? nodeId.slice(0, 4) : ''
  const ordered = files.slice().sort((a, b) => {
    const pa = year && a.basename === year ? 0 : 1
    const pb = year && b.basename === year ? 0 : 1
    return pa - pb
  })
  const re = new RegExp(`"id"\\s*:\\s*"${nodeId}"`)
  for (const file of ordered.slice(0, 20)) {
    try {
      const text = await app.vault.read(file)
      if (re.test(text)) return file
    } catch {
      // Unreadable — skip.
    }
  }
  return null
}

/** Content-match a canvas TEXT node against the selected text and return its
 *  id — enables `[[画布#^节点id]]` jump links (追加68). Pure JSON walk, no
 *  runtime canvas internals. Returns null when no node contains the probe. */
export function findCanvasNodeIdByText(
  canvasJson: string,
  probe: string,
): string | null {
  const needle = normalizeForMatch(probe)
  if (!needle) return null
  try {
    const data = JSON.parse(canvasJson) as {
      nodes?: Array<{ id?: string; text?: string; file?: string }>
    }
    const nodes = Array.isArray(data.nodes) ? data.nodes : []
    for (const n of nodes) {
      if (typeof n.id !== 'string') continue
      if (typeof n.text === 'string' && normalizeForMatch(n.text).includes(needle)) {
        return n.id
      }
      // 卡片（file）节点没有 text，显示的是文件名——按 basename 匹配（追加70）。
      if (typeof n.file === 'string') {
        const base = n.file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
        if (base && normalizeForMatch(base).includes(needle)) return n.id
      }
    }
  } catch {
    // Not parseable JSON — shouldn't happen for .canvas, treat as no match.
  }
  return null
}

/** File of a leaf's view when it is file-backed (canvas 也是 FileView)。
 *  不碰 canvas 内部运行时 API，只走公开的 FileView.file（追加69）。 */
function fileOfView(view: View | null | undefined): TFile | null {
  if (view && view instanceof FileView) return view.file ?? null
  const f = (view as unknown as { file?: unknown } | null)?.file
  return f instanceof TFile ? f : null
}

/** Resolve the file the selection belongs to. getActiveFile() alone is NOT
 *  enough: in a canvas view it may return null (canvas isn't always reported
 *  as the "active file"), and in split panes it may return the OTHER pane's
 *  file — both killed the #^节点id anchor (追加69 失败复盘). So FIRST look
 *  for the canvas leaf whose DOM actually CONTAINS the selected element, and
 *  only fall back to getActiveFile(). */
export function resolveSelectionFile(app: App, el: Element | null): TFile | null {
  if (el) {
    for (const leaf of app.workspace.getLeavesOfType('canvas')) {
      // d.ts 没给 WorkspaceLeaf 声明 containerEl（AGENTS 统一写法：cast）。
      const containerEl = (leaf as unknown as { containerEl?: HTMLElement })
        .containerEl
      try {
        if (!containerEl?.contains(el)) continue
      } catch {
        continue
      }
      const f = fileOfView(leaf.view)
      if (f) return f
    }
  }
  return app.workspace.getActiveFile()
}

/** Format one table row as a `表头: 值 | 表头: 值` context snippet — a bare
 *  cell text like "20" means nothing without its column (追加68). */
export function tableRowContext(
  headers: string[],
  cells: string[],
): string {
  const parts = cells
    .map((cell, i) => {
      // 补刀85: DOM textContent 原样带「」——入 token 前必须清洗，
      // 否则 」 会截断引用 token。
      const value = cleanSelection(cell)
      if (!value) return ''
      const header = cleanSelection(headers[i] ?? '') || `列${i + 1}`
      return `${header}: ${value}`
    })
    .filter(Boolean)
  return parts.join(' | ')
}

/** Header row texts of a rendered <table> (thead first, else row 0). */
function headerCells(table: HTMLTableElement): string[] {
  const headRow =
    (table.querySelector('thead tr') as HTMLTableRowElement | null) ??
    (table.rows.length > 0 ? table.rows[0] : null)
  if (!headRow) return []
  return Array.from(headRow.cells).map((c) => (c.textContent ?? '').trim())
}

/** Split one markdown table row (`| a | b |`) into trimmed cell texts. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}/

/** Locate the selected text inside a note's MARKDOWN-SOURCE tables and return
 *  its context (追加69; 追加71 精确化). Needed because live-preview source
 *  mode renders tables as plain text — there is no <td> DOM to hit. When the
 *  probe sits entirely in ONE cell → `表头: 选中文字` (精确到字)；跨多个
 *  单元格才退回整行 `表头: 值 | …` 上下文。Returns null when no table row
 *  matches. */
export function markdownTableRowContext(
  noteText: string,
  probe: string,
): string | null {
  const needle = normalizeForMatch(probe)
  if (!needle) return null
  const lines = noteText.split('\n')
  let i = 0
  while (i < lines.length) {
    // A table block starts at a `| … |` line that is not a separator row.
    if (!/^\s*\|.*\|/.test(lines[i]) || TABLE_SEPARATOR_ROW.test(lines[i])) {
      i++
      continue
    }
    const block: string[] = []
    while (i < lines.length && /^\s*\|.*\|/.test(lines[i])) {
      block.push(lines[i])
      i++
    }
    // block[0] = header, block[1] = separator (`|---|`) — skip both when
    // matching data rows, keep the header for context.
    const headers = splitTableRow(block[0]).map(cleanSelection)
    for (let r = 1; r < block.length; r++) {
      if (TABLE_SEPARATOR_ROW.test(block[r])) continue
      // 源码单元格带 ==/**/` 标记——比较与输出前都清掉。
      const cells = splitTableRow(block[r]).map(cleanSelection)
      const containing = cells.filter(
        (c) => c && normalizeForMatch(c).includes(needle),
      )
      if (containing.length === 1) {
        // 选区完整落在单个单元格内 → 精确引用「表头: 选中文字」（追加71）。
        const idx = cells.indexOf(containing[0])
        const header = headers[idx]?.trim() || `列${idx + 1}`
        return `${header}: ${cleanSelection(probe)}`
      }
      // 跨单元格拖选（没有任何单格完整包含选区）→ 整行拼起来能对上就引整行。
      if (
        containing.length > 1 ||
        normalizeForMatch(cells.join(' ')).includes(needle)
      ) {
        return tableRowContext(headers, cells)
      }
    }
  }
  return null
}

/** Cached snapshot of the last non-empty selection (追加70). Canvas 编辑
 *  节点里按快捷键时画布可能已把选区清掉——main.ts 用 selectionchange 持续
 *  缓存最近一次选区，buildSelectionRef 拿不到活选区时用它兜底。 */
export interface SelectionFallback {
  raw: string
  el: Element | null
  at: number
}

/** No text selection, but a canvas CARD is selected (蓝框/is-selected)——
 *  引用整张卡片：文本节点引内容片段，卡片节点引文件名（追加70）。 */
async function quoteSelectedCanvasNode(app: App): Promise<string> {
  const nodeEl =
    document.querySelector('.canvas-node.is-focused') ??
    document.querySelector('.canvas-node.is-selected')
  if (!nodeEl) return ''
  const file = resolveSelectionFile(app, nodeEl)
  if (!file || file.extension !== 'canvas') return ''
  const content = (
    nodeEl.querySelector('.canvas-node-content')?.textContent ??
    nodeEl.textContent ??
    ''
  ).trim()
  const snippet = cleanSelection(content).slice(0, 150)
  try {
    const json = await app.vault.read(file)
    const nodeId = findCanvasNodeIdByText(json, content.slice(0, 60))
    if (nodeId) {
      return snippet
        ? `[[${file.path}#^${nodeId}]]「${snippet}」 `
        : `[[${file.path}#^${nodeId}]] `
    }
  } catch {
    // Read failed — fall through to the plain canvas-file ref.
  }
  return snippet ? `[[${file.name}]]「${snippet}」 ` : `[[${file.name}]] `
}

/**
 * Build the reference string for the current window selection, or '' when
 * there is none. Resolution order:
 *   1. chat message  → [[msg:conv/msg]]「…」
 *   2. memos card    → [[<画布>#<memo节点id>]]「…」
 *   3. canvas node   → [[<画布>#^<节点id>]]「…」（找不到节点退 [[<画布>]]）
 *   4. table cell    → [[<笔记>]]「表头: 值 | …」（实时预览源码模式无 td DOM，
 *      回退匹配笔记源码里的表格行，追加69）
 *   5. generic       → [[<笔记/文件/标签页标题>]]「…」
 *   6. 无任何选区但画布里有选中卡片 → 引用整张卡片（追加70）
 */
export async function buildSelectionRef(
  app: App,
  fallback?: SelectionFallback,
): Promise<string> {
  const sel = window.getSelection?.()
  let raw = sel?.toString() ?? ''
  let el: Element | null = null
  if (raw.trim()) {
    const node = sel?.anchorNode ?? null
    el =
      node && node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node?.parentElement ?? null
  } else if (fallback && fallback.raw.trim()) {
    // 活选区被清掉了（canvas 编辑节点按快捷键时会发生，追加70）——用缓存。
    raw = fallback.raw
    el = fallback.el
  }
  if (!raw.trim()) {
    return quoteSelectedCanvasNode(app)
  }

  // 1. Chat message — pin the exact conversation position (追加46).
  const msgEl = el?.closest('[data-ai-msg-id]') ?? null
  if (msgEl) {
    const convEl = msgEl.closest('[data-ai-conv-id]') ?? null
    const msgId = msgEl.getAttribute('data-ai-msg-id')
    const convId = convEl?.getAttribute('data-ai-conv-id')
    if (msgId && convId) {
      const snippet = cleanSelection(raw).slice(0, 150)
      return `[[msg:${convId}/${msgId}]]「${snippet}」 `
    }
  }

  const snippet = cleanSelection(raw).slice(0, 150)

  // 2. Memos card — the card DOM carries data-memo-id; locate the canvas file
  //    holding that node so the ref uses memos' own [[file#id]] link format.
  const memoEl = el?.closest('.memos-card[data-memo-id]') as HTMLElement | null
  const memoId = memoEl?.dataset?.memoId ?? ''
  if (memoId) {
    const source = await findCanvasFileWithNodeId(app, memoId)
    if (source) return `[[${source.path}#${memoId}]]「${snippet}」 `
  }

  const file = resolveSelectionFile(app, el)

  // 3. Canvas text node — content-match the node id for a #^ jump anchor.
  const canvasNodeEl = el?.closest('.canvas-node') ?? null
  if (canvasNodeEl && file && file.extension === 'canvas') {
    try {
      const json = await app.vault.read(file)
      const nodeId = findCanvasNodeIdByText(json, raw.trim().slice(0, 60))
      if (nodeId) {
        return `[[${file.path}#^${nodeId}]]「${snippet}」 `
      }
    } catch {
      // Read failed — fall through to the plain canvas-file ref below.
    }
    return `[[${file.name}]]「${snippet}」 `
  }

  // 4. Table cell — 选区完整落在单个单元格内时用「表头: 选中文字」精确引用
  //    （追加71: 用户反馈整行上下文太粗糙）；跨单元格拖选才退回整行上下文。
  const cellEl = el?.closest('td, th') ?? null
  if (cellEl) {
    const tr = cellEl.closest('tr')
    const table = cellEl.closest('table')
    if (tr && table) {
      const target = file
        ? file.extension === 'md'
          ? file.basename
          : file.name
        : app.workspace.activeLeaf?.getDisplayText() ?? ''
      if (target) {
        const headers = headerCells(table as HTMLTableElement)
        const rowCells = Array.from(tr.querySelectorAll('td, th'))
        const exact = cleanSelection(raw)
        const idx = rowCells.indexOf(cellEl)
        const cellText = (cellEl.textContent ?? '').replace(/\s+/g, ' ')
        const probeNorm = raw.trim().replace(/\s+/g, ' ')
        if (idx >= 0 && exact && cellText.includes(probeNorm)) {
          const header = cleanSelection(headers[idx] ?? '') || `列${idx + 1}`
          return `[[${target}]]「${header}: ${exact.slice(0, 150)}」 `
        }
        const ctx = tableRowContext(headers, rowCells.map((c) => c.textContent ?? ''))
        if (ctx) return `[[${target}]]「${ctx.slice(0, 150)}」 `
      }
    }
  }

  // 4b. Live-preview SOURCE mode — tables there are plain `| a | b |` text
  //     lines with no <td> DOM, so 追加68 的 closest('td') 检测整个落空。
  //     回退：读笔记源码，把选中文本匹配回所在表格行（追加69）。
  if (!cellEl && file && file.extension === 'md' && el?.closest('.cm-editor')) {
    try {
      const noteText = await app.vault.cachedRead(file)
      const ctx = markdownTableRowContext(noteText, raw)
      if (ctx) return `[[${file.basename}]]「${ctx.slice(0, 150)}」 `
    } catch {
      // Unreadable — fall through to the generic note ref.
    }
  }

  // 5. Generic: .md keeps the bare basename; canvas/bases/pdf 等非 md 文件必须
  //    带扩展名链接才解析得到（[[foo.canvas]]，追加68）。没有活动文件（部分
  //    三方视图）时退用标签页标题。
  if (file) {
    const target = file.extension === 'md' ? file.basename : file.name
    return `[[${target}]]「${snippet}」 `
  }
  const leafTitle = app.workspace.activeLeaf?.getDisplayText()
  if (leafTitle) {
    return `[[${leafTitle}]]「${snippet}」 `
  }
  return ''
}
