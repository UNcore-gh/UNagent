/**
 * @jest-environment jsdom
 *
 * 追加78：浮动导航从「悬停单个短横显示单条 tooltip」改为「悬停弹出全量
 * 问题面板（纯白卡片）+ 上下箭头快速跳转」。这里锁定新契约：
 *   ① 悬停导航条 → 面板列出所有问题，点行即定位（flash 目标消息）；
 *   ② 移开光标 → 面板收起；
 *   ③ ▲/▼ 以当前问题为基准链式跳前一问 / 后一问。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import { ConversationNav } from '../ConversationNav'
import type { UiMessage } from '../types'

// React 18.3 exposes React.act; older 18.x needs react-dom/test-utils.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const act: (cb: () => void | Promise<void>) => Promise<void> =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

// jsdom 缺 matchMedia / scrollIntoView / Element.scrollTo —— 组件只用到
// 「是否触屏」与「滚进视野」的语义，stub 掉即可。
beforeAll(() => {
  const w = window as unknown as {
    matchMedia?: (q: string) => MediaQueryList
  }
  if (!w.matchMedia) {
    w.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as (q: string) => MediaQueryList
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined
  }
})

const userMsg = (id: string, content: string): UiMessage => ({
  id,
  role: 'user',
  content,
})
const aiMsg = (id: string, text: string): UiMessage => ({
  id,
  role: 'assistant',
  blocks: [{ kind: 'text', text }],
})

describe('ConversationNav — 追加78 全量面板 + 上下箭头', () => {
  let container: HTMLDivElement
  let scroll: HTMLDivElement
  let root: Root
  const scrollRef = { current: null } as React.RefObject<HTMLDivElement>

  const threeTurns: UiMessage[] = [
    userMsg('u1', '第一问'),
    aiMsg('a1', '回答一'),
    userMsg('u2', '第二问'),
    aiMsg('a2', '回答二'),
    userMsg('u3', '第三问'),
    aiMsg('a3', '回答三'),
  ]

  beforeEach(async () => {
    container = document.createElement('div')
    scroll = document.createElement('div')
    // goTo 靠 el.scrollTo —— jsdom 没实现，记一下调用即可。
    ;(scroll as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo =
      () => undefined
    document.body.appendChild(container)
    document.body.appendChild(scroll)
    for (const id of ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']) {
      const el = document.createElement('div')
      el.setAttribute('data-ai-msg-id', id)
      scroll.appendChild(el)
    }
    ;(scrollRef as { current: HTMLDivElement | null }).current = scroll
    root = createRoot(container)
    await act(async () => {
      root.render(<ConversationNav messages={threeTurns} scrollRef={scrollRef} />)
    })
    // 等 scrollspy 的首帧 rAF 跑完（jsdom 里 rect 全 0 → active = 最后一问）。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    scroll.remove()
  })

  const hoverRail = async () => {
    const rail = container.querySelector('.UNagent-nav-nodes')!
    await act(async () => {
      // React 用冒泡的 mouseover/mouseout 合成 enter/leave。
      rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
  }
  const leaveRail = async () => {
    const rail = container.querySelector('.UNagent-nav-nodes')!
    await act(async () => {
      rail.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      )
    })
  }
  const clickEl = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const flashed = (): string[] =>
    [...scroll.querySelectorAll('.UNagent-message--flash')].map(
      (n) => n.getAttribute('data-ai-msg-id') ?? '',
    )
  // flash 类 1300ms 后才移除——断言「这一跳落在哪」前先清场。
  const clearFlash = () => {
    for (const n of scroll.querySelectorAll('.UNagent-message--flash')) {
      n.classList.remove('UNagent-message--flash')
    }
  }

  it('悬停弹出面板：列出全部三轮，点行定位到对应消息', async () => {
    expect(container.querySelector('.UNagent-nav-panel')).toBeNull()

    await hoverRail()
    const panel = container.querySelector('.UNagent-nav-panel')
    expect(panel).not.toBeNull()
    const rows = panel!.querySelectorAll('.UNagent-nav-row')
    expect(rows).toHaveLength(3)
    expect(panel!.textContent).toContain('第一问')
    expect(panel!.textContent).toContain('第二问')
    expect(panel!.textContent).toContain('第三问')

    // 点第一行 → 定位并 flash u1。
    await clickEl(rows[0])
    expect(flashed()).toEqual(['u1'])

    // 面板保持打开（光标还在面板里）——换点第三行也能继续定位。
    expect(container.querySelector('.UNagent-nav-panel')).not.toBeNull()
    clearFlash()
    await clickEl(container.querySelectorAll('.UNagent-nav-row')[2])
    expect(flashed()).toEqual(['u3'])
  })

  it('移开光标后面板收起', async () => {
    await hoverRail()
    expect(container.querySelector('.UNagent-nav-panel')).not.toBeNull()
    await leaveRail()
    expect(container.querySelector('.UNagent-nav-panel')).toBeNull()
  })

  it('上下箭头以当前问题为基准链式跳转', async () => {
    // scrollspy 首帧（rect 全 0）把 active 定在最后一问 u3。
    const steps = container.querySelectorAll('.UNagent-nav-step')
    expect(steps).toHaveLength(2)
    const [up, down] = [steps[0], steps[1]]

    await clickEl(up) // u3 → u2
    expect(flashed()).toEqual(['u2'])
    clearFlash()
    await clickEl(up) // u2 → u1（activeId 已随上一跳推进，链式不退回）
    expect(flashed()).toEqual(['u1'])
    clearFlash()
    await clickEl(up) // 已到第一问，保持 u1
    expect(flashed()).toEqual(['u1'])
    clearFlash()
    await clickEl(down) // u1 → u2
    expect(flashed()).toEqual(['u2'])
  })
})
