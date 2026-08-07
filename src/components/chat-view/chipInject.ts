import { Modal, setIcon } from 'obsidian'
import type { App } from 'obsidian'

import { refTokenSnippet, runMarkerText } from './mention'
import type { MentionRun, MentionTokenKind } from './mention'

/** Placeholder tokens bracket every reference in the markdown source BEFORE
 *  the native render; after rendering, the placeholder text nodes are
 *  replaced with inline chips (追加㉛: DOM-version of the old React
 *  splitChildren). PUA chars never appear in normal AI text and survive the
 *  markdown parser untouched. */
export const PH_A = '\uE000'
export const PH_B = '\uE001'
export const PH_RE = /\uE000(\d+)\uE001/g

/** Second placeholder pair: inline command/skill tokens in message bodies
 *  (追加㊺) — kept apart from the mention pair so one renderer can carry
 *  both kinds of chips. */
export const PH_C = '\uE002'
export const PH_D = '\uE003'
export const PH_CMD_RE = /\uE002(\d+)\uE003/g

const KIND_ICON: Record<string, string> = {
  folder: 'folder',
  tag: 'hash',
  // 追加91: lucide 图标名是 at-sign 不是 at——setIcon 找不到图标静默
  // no-op（不报错也不渲染），ref chip 的 @ 图标因此一直缺失。
  ref: 'at-sign',
}

/** The minimal plugin surface the chips need (keeps tests mock-friendly). */
export interface ChipPlugin {
  app: {
    metadataCache: unknown
    workspace: unknown
  }
}

// metadataCache.getFirstLinkpathDest exists at runtime but is missing from
// some d.ts builds — local interface + optional call (坑⑦ pattern).
interface CacheWithLinks {
  getFirstLinkpathDest?: (linktext: string, sourcePath: string) => {
    path: string
    basename: string
  } | null
}

export function hrefFor(
  plugin: ChipPlugin,
  raw: string,
): { href: string; linktext: string } | null {
  try {
    const m = raw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/)
    if (!m) return null
    // 追加72: 剥掉子路径（#^节点id / #标题）再解析，画布节点锚点引用才能
    // 拿到目标文件（悬停预览/点击元数据）。
    const target = (m[2] ?? m[1]).trim().split('#')[0]
    if (!target || target.endsWith('/')) return null
    const cache = plugin.app.metadataCache as unknown as CacheWithLinks
    const file = cache.getFirstLinkpathDest?.(target, '')
    if (!file) return null
    return { href: file.path, linktext: file.basename }
  } catch {
    return null
  }
}

/** 追加85: 引用原文的独立展示窗——ref chip 点击弹出。引用到的选中原文
 *  不进官方预览窗（官方弹窗只渲染笔记本体，我们一行都不碰 = 最不会翻车）；
 *  独立小窗用官方 Modal——定位/层级/Esc 关闭/卸载清理全由 Obsidian 托管，
 *  没有自绘浮层的定位/z-index 风险。 */
class SnippetModal extends Modal {
  private readonly snippetTitle: string
  private readonly snippetText: string
  private readonly snippetHref: string | null

  constructor(
    app: App,
    title: string,
    snippet: string,
    href: string | null,
  ) {
    super(app)
    this.snippetTitle = title
    this.snippetText = snippet
    this.snippetHref = href
  }

  onOpen(): void {
    // 追加86: 弹窗要适配 AI 侧边栏场景——默认 dialog 宽度对侧边栏/手机太宽，
    // 给 modalEl 挂自有类后用 CSS 限宽（官方 Modal 托管定位/层级，只改尺寸）。
    this.modalEl.addClass('UNagent-snippet-modal-wrap')
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('UNagent-snippet-modal')
    contentEl.createEl('div', {
      cls: 'UNagent-snippet-modal-title',
      text: `引用原文 · ${this.snippetTitle}`,
    })
    contentEl.createEl('blockquote', {
      cls: 'UNagent-snippet-modal-text',
      text: this.snippetText,
    })
    if (this.snippetHref) {
      const href = this.snippetHref
      const btn = contentEl.createEl('button', { text: '打开来源笔记' })
      btn.addEventListener('click', () => {
        this.close()
        void this.app.workspace.openLinkText(href, '')
      })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** 引用 chip 内嵌原文摘要的最大字符数（追加94），超长截断加省略号。 */
const SNIPPET_CHIP_MAX = 24

function truncateSnippet(s: string): string {
  return s.length > SNIPPET_CHIP_MAX ? `${s.slice(0, SNIPPET_CHIP_MAX)}…` : s
}

/** One "引用"/"文件"/"标签" chip as raw DOM — same look and behavior as the
 *  previous React ReferenceChip: icon + label, hover pops the note's native
 *  preview, click never navigates. */
function buildChip(run: MentionRun, plugin: ChipPlugin): HTMLElement {
  // 追加73: chip 外观保持简洁的「引用」，选中原文收进悬停 tooltip（title）
  // ——内部可见、外部干净（用户指示）。
  const snippet =
    run.kind === 'ref' && run.texts.length === 1
      ? refTokenSnippet(run.texts[0])
      : ''
  // 追加94（推翻「外部干净」）：气泡里直接可见选中原文——悬停 chip 时官方
  // HoverPopover 抢先弹笔记预览、原生 title tooltip 被抢占，原文「毫无显
  // 示」。chip 内嵌截断摘要，完整原文仍留在 title（悬停）与点击弹窗
  // （SnippetModal）。
  const base = runMarkerText(run.kind as MentionTokenKind, run.texts.length)
  const label = snippet
    ? `${base}「${truncateSnippet(snippet)}」`
    : base
  const ref = hrefFor(plugin, run.texts[0] ?? '')
  const cls = 'UNagent-output-mention UNagent-composer-mention-chip'

  const el = ref
    ? document.createElement('a')
    : document.createElement('span')
  el.className = cls
  if (snippet) el.title = snippet

  // 追加93: icon 前置、label 后置（恢复视觉顺序 @引用）——追加89 为
  // inline-flex 基线语义把 label 前置，追加90 回归 inline-block 后基线 =
  // 行盒文字基线、与子元素顺序无关，顺序反转的理由已不存在。
  const iconEl = document.createElement('span')
  setIcon(iconEl, KIND_ICON[run.kind] ?? 'file')
  el.appendChild(iconEl)
  const labelEl = document.createElement('span')
  labelEl.className = 'UNagent-chip-label'
  labelEl.textContent = label
  el.appendChild(labelEl)

  if (ref) {
    const a = el as HTMLAnchorElement
    a.href = ref.href
    a.setAttribute('data-href', ref.href.replace(/\.md$/, ''))
    // 追加84（推翻追加83）：逆向官方 page-preview 的 onLinkHover 后确认，弹窗
    // 去重按 `hoverParent.hoverPopover` + targetEl 匹配——
    //   (o = e.hoverPopover) && o.state !== Hidden && o.targetEl === t ? 跳过
    // 追加83 的「每次 enter 换新 hoverParent」恰恰让官方去重永远匹配不上：
    // 鼠标在 chip 上每动一下、弹窗与 chip 之间每次进出，都叠出一个新窗——
    // 阴影叠加就是用户看到的「边框一圈圈黑环，按住 Command 更剧烈」。
    // 正解：每个 chip 一个**稳定** hoverParent（字段名 hoverPopover 必须与
    // 官方一致），后续所有触发被官方 onLinkHover 自动去重；弹窗的开/关/
    // 「按住修饰键等待」语义全部交给官方 HoverPopover 状态机（onTarget /
    // transition），我们不写任何自己的开合逻辑。modifier 语义由 main.ts 的
    // registerHoverLinkSource('UNagent', { defaultMod: false }) 决定：
    // 普通悬停直接弹（保持原 UX），按住 Cmd 立即弹、不再进等待循环。
    const hoverParent: { hoverPopover: unknown } = { hoverPopover: null }
    a.addEventListener('mouseover', (evt) => {
      ;(
        plugin.app.workspace as unknown as {
          trigger: (name: string, opts: unknown) => void
        }
      ).trigger('hover-link', {
        event: evt,
        source: 'UNagent',
        hoverParent,
        targetEl: a,
        // 追加85: linktext 用完整路径——官方 embed 解析
        // getFirstLinkpathDest(linktext, sourcePath) 对完整路径是确定性
        // 命中；basename 依赖 vault 的链接格式设置，是「无法预览」的隐患。
        linktext: ref.href,
        sourcePath: '',
      })
    })
    // 追加84: 无 mouseleave 关窗——官方 HoverPopover 自己监听离开并隐藏；
    // 追加83 的手动 onClose 会在「按住 Cmd 等待弹窗」状态里把官方正在等的
    // 窗杀掉，正是「command 下预览渲染崩溃」的帮凶之一。
    a.addEventListener('click', (evt) => {
      evt.preventDefault()
      // 追加85: 带选中原文的引用 chip——点击弹独立原文窗（官方 Modal）。
      // 纯文件引用保持原行为：点击不跳转、不弹窗。运行时 plugin.app 就是
      // 真 App（ReferenceText 传整个插件），此处的结构型收窄只为测试 fake。
      if (snippet) {
        new SnippetModal(
          plugin.app as unknown as App,
          ref.linktext,
          snippet,
          ref.href,
        ).open()
      }
    })
  }
  return el
}

/** Replace every placeholder token in the NATIVE-rendered tree with its
 *  chip. Bulletproof by construction: an unknown index degrades to NOTHING
 *  (the PUA chars must never reach visible text), never a crash. */
export function injectChips(
  root: HTMLElement,
  chips: MentionRun[],
  plugin: ChipPlugin,
): void {
  replaceTokens(root, PH_RE, (idx) => {
    const run = chips[Number(idx)]
    return run ? buildChip(run, plugin) : null
  })
}

/** One inline command pill for the message bubbles (追加㊺): label + icon
 *  are resolved at mark time, so no plugin surface is needed here. */
export interface CommandChip {
  label: string
  icon: string
}

/** Swap the command-token placeholders for inline pills — same walker and
 *  same degrade-to-nothing guarantee as injectChips. */
export function injectCommandChips(
  root: HTMLElement,
  chips: CommandChip[],
): void {
  replaceTokens(root, PH_CMD_RE, (idx) => {
    const chip = chips[Number(idx)]
    if (!chip) return null
    const el = document.createElement('span')
    el.className = 'UNagent-output-command'
    // 追加93: 与引用 chip 同款——icon 前置、label 后置（见上注）。
    const iconEl = document.createElement('span')
    setIcon(iconEl, chip.icon)
    el.appendChild(iconEl)
    const labelEl = document.createElement('span')
    labelEl.className = 'UNagent-chip-label'
    labelEl.textContent = chip.label
    el.appendChild(labelEl)
    return el
  })
}

/** Shared placeholder-scan + replace walker for both chip kinds. */
function replaceTokens(
  root: HTMLElement,
  re: RegExp,
  build: (idx: string) => Node | null,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    re.lastIndex = 0
    if (re.test(node.nodeValue ?? '')) targets.push(node as Text)
  }
  for (const textNode of targets) {
    const text = textNode.nodeValue ?? ''
    const frag = document.createDocumentFragment()
    re.lastIndex = 0
    let pos = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, m.index)))
      }
      const el = build(m[1])
      if (el) frag.appendChild(el)
      // No else: an orphan token is dropped, not echoed.
      pos = m.index + m[0].length
    }
    if (pos < text.length) {
      frag.appendChild(document.createTextNode(text.slice(pos)))
    }
    textNode.parentNode?.replaceChild(frag, textNode)
  }
}
