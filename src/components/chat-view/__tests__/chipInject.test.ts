/** @jest-environment jsdom */
// chipInject — the DOM half of the reference chips on the native renderer
// (追加㉛): after Obsidian renders the marked markdown, every placeholder
// token in the text nodes is swapped for a chip element. Runs in jsdom.

import { injectChips, injectCommandChips } from '../chipInject'
import type { MentionRun } from '../mention'
import { Modal } from 'obsidian'

const PH_A = '\uE000'
const PH_B = '\uE001'
const PH_C = '\uE002'
const PH_D = '\uE003'

const plugin = {
  app: {
    metadataCache: {
      getFirstLinkpathDest: (target: string) =>
        target === 'A' ? { path: 'folder/A.md', basename: 'A' } : null,
    },
    workspace: { trigger: jest.fn() },
  },
}

const run = (kind: MentionRun['kind'], texts: string[]): MentionRun => ({
  type: 'mention',
  kind,
  texts,
  raw: texts.join(' '),
})

const rootWith = (html: string): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('injectChips', () => {
  it('swaps a placeholder for an inline chip inside the same paragraph', () => {
    const root = rootWith(`<p>看 ${PH_A}0${PH_B} 这里</p>`)
    injectChips(root, [run('file', ['[[A]]'])], plugin)
    const chip = root.querySelector('.UNagent-output-mention')
    expect(chip).not.toBeNull()
    expect(chip?.tagName).toBe('A')
    expect(chip?.getAttribute('href')).toBe('folder/A.md')
    expect(chip?.getAttribute('data-href')).toBe('folder/A')
    expect(chip?.textContent).toContain('文件')
    // Chip flows inline: text before and after share the same <p>.
    expect(root.querySelector('p')?.textContent).toContain('看 ')
    expect(root.querySelector('p')?.textContent).toContain(' 这里')
  })

  it('uses a span (no href) for an unresolvable reference', () => {
    const root = rootWith(`<p>提到 ${PH_A}0${PH_B} 试试</p>`)
    injectChips(root, [run('file', ['[[不存在]]'])], plugin)
    const chip = root.querySelector('.UNagent-output-mention')
    expect(chip?.tagName).toBe('SPAN')
    expect(chip?.getAttribute('href')).toBeNull()
  })

  it('shows a count label for a multi-token run', () => {
    const root = rootWith(`<p>${PH_A}0${PH_B} 两处</p>`)
    injectChips(root, [run('file', ['[[A]]', '[[A]]'])], plugin)
    expect(root.textContent).toContain('文件×2')
  })

  it('handles several placeholders in one text node', () => {
    const root = rootWith(`<p>${PH_A}0${PH_B} 和 ${PH_A}1${PH_B}</p>`)
    injectChips(root, [run('file', ['[[A]]']), run('tag', ['#标签'])], plugin)
    expect(root.querySelectorAll('.UNagent-output-mention')).toHaveLength(2)
    expect(root.textContent).toContain('标签')
  })

  it('never leaks a placeholder token and never crashes on a bad index', () => {
    const root = rootWith(`<p>${PH_A}9${PH_B} 结尾</p>`)
    injectChips(root, [run('file', ['[[A]]'])], plugin)
    expect(root.textContent).not.toContain(PH_A)
    expect(root.textContent).not.toContain(PH_B)
  })

  it('is a no-op without chips', () => {
    const root = rootWith('<p>普通文本</p>')
    injectChips(root, [], plugin)
    expect(root.innerHTML).toBe('<p>普通文本</p>')
  })
})

// 追加84（推翻追加83 的自管防线）：逆向官方 page-preview 确认，弹窗去重
// 按 hoverParent.hoverPopover + targetEl 匹配。我们的契约只剩两条：
// 每次触发传**同一个**稳定 hoverParent（字段名 hoverPopover 与官方一致），
// 且不自作主张关窗——开合与修饰键语义全归官方 HoverPopover 状态机。
describe('chip hover → hover-link (追加84)', () => {
  const trigger = plugin.app.workspace.trigger as jest.Mock

  const chipEl = (): HTMLElement => {
    const root = rootWith(`<p>${PH_A}0${PH_B}</p>`)
    injectChips(root, [run('file', ['[[A]]'])], plugin)
    return root.querySelector('.UNagent-output-mention') as HTMLElement
  }

  beforeEach(() => trigger.mockClear())

  it('passes the SAME stable hoverParent on every mouseover (官方去重键)', () => {
    const chip = chipEl()
    chip.dispatchEvent(new MouseEvent('mouseover'))
    chip.dispatchEvent(new MouseEvent('mouseover', { metaKey: true }))
    expect(trigger).toHaveBeenCalledTimes(2)
    expect(trigger.mock.calls[0][0]).toBe('hover-link')
    const a = trigger.mock.calls[0][1] as Record<string, unknown>
    const b = trigger.mock.calls[1][1] as Record<string, unknown>
    // 同一个对象——「每次换新 hoverParent」正是叠窗黑环的根因（追加84）。
    expect(a.hoverParent).toBe(b.hoverParent)
    expect(
      Object.prototype.hasOwnProperty.call(a.hoverParent, 'hoverPopover'),
    ).toBe(true)
    expect(a.source).toBe('UNagent')
    expect(a.targetEl).toBe(chip)
    // 追加85: linktext 用完整路径，embed 解析确定性命中。
    expect(a.linktext).toBe('folder/A.md')
  })

  it('never closes the popover itself — lifecycle belongs to the official state machine', () => {
    const chip = chipEl()
    chip.dispatchEvent(new MouseEvent('mouseover'))
    const opts = trigger.mock.calls[0][1] as {
      hoverParent: { hoverPopover: { onClose: () => void } | null }
    }
    const onClose = jest.fn()
    opts.hoverParent.hoverPopover = { onClose }
    // 追加83 的手动 onClose 会在「按住修饰键等待弹窗」状态里把官方正在等
    // 的窗杀掉——mouseleave 现在必须是 no-op。
    chip.dispatchEvent(new MouseEvent('mouseleave'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

// 追加85: 带选中原文的引用 chip，点击弹独立原文窗（官方 Modal）——
// 原文不进官方预览窗；纯文件引用点击不弹窗。
describe('chip click → snippet modal (追加85)', () => {
  it('opens the snippet modal only for refs that carry quoted text', () => {
    const openSpy = jest.spyOn(Modal.prototype, 'open')
    try {
      // ref chip：[[A]]「选中原文」→ 点击弹窗。
      const withSnippet = rootWith(`<p>${PH_A}0${PH_B}</p>`)
      injectChips(
        withSnippet,
        [run('ref', ['[[A]]「选中原文」'])],
        plugin,
      )
      const refChip = withSnippet.querySelector(
        '.UNagent-output-mention',
      ) as HTMLElement
      const click = new MouseEvent('click', { cancelable: true })
      refChip.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
      expect(openSpy).toHaveBeenCalledTimes(1)

      // 纯文件 chip：点击不弹窗、也不跳转。
      const plain = rootWith(`<p>${PH_A}0${PH_B}</p>`)
      injectChips(plain, [run('file', ['[[A]]'])], plugin)
      const fileChip = plain.querySelector(
        '.UNagent-output-mention',
      ) as HTMLElement
      const click2 = new MouseEvent('click', { cancelable: true })
      fileChip.dispatchEvent(click2)
      expect(click2.defaultPrevented).toBe(true)
      expect(openSpy).toHaveBeenCalledTimes(1)
    } finally {
      openSpy.mockRestore()
    }
  })
})

describe('injectCommandChips (追加㊺)', () => {
  it('swaps a command placeholder for an inline pill with icon + label', () => {
    const root = rootWith(`<p>用 ${PH_C}0${PH_D} 试试</p>`)
    injectCommandChips(root, [{ label: '顺便一问', icon: 'message-circle' }])
    const pill = root.querySelector('.UNagent-output-command')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toContain('顺便一问')
    // 追加93: icon span 前置（first-child）、label 后置（setIcon 在 obsidian
    // mock 里是 no-op，无 svg——两个 span 是稳定契约）。
    expect(pill?.children.length).toBe(2)
    expect(pill?.children[1].className).toBe('UNagent-chip-label')
    expect(pill?.children[1].textContent).toBe('顺便一问')
    expect(root.querySelector('p')?.textContent).toContain('用 ')
    expect(root.querySelector('p')?.textContent).toContain(' 试试')
  })

  it('never leaks a placeholder and degrades a bad index to nothing', () => {
    const root = rootWith(`<p>${PH_C}9${PH_D} 结尾</p>`)
    injectCommandChips(root, [{ label: 'x', icon: 'y' }])
    expect(root.textContent).not.toContain(PH_C)
    expect(root.textContent).not.toContain(PH_D)
  })

  it('is a no-op without chips', () => {
    const root = rootWith('<p>普通文本</p>')
    injectCommandChips(root, [])
    expect(root.innerHTML).toBe('<p>普通文本</p>')
  })
})
