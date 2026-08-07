/**
 * @jest-environment jsdom
 *
 * ConversationNav must mirror the live message list (追加⑪ 契约回归):
 * after a rewind/delete shrinks the list, the dash for the removed turn
 * must disappear and the remaining nodes must stay navigable. The items
 * are derived purely from the `messages` prop, so this pins the contract
 * end to end: render 3 turns → rewind to turn 1 → only 1 node survives.
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import { ConversationNav } from '../ConversationNav'
import type { UiMessage } from '../types'

// React 18.3 exposes React.act; older 18.x needs react-dom/test-utils.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const act: (cb: () => void) => void =
  (React as unknown as { act?: typeof import('react-dom/test-utils').act }).act ??
  require('react-dom/test-utils').act

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

describe('ConversationNav — nodes track the message list', () => {
  let container: HTMLDivElement
  let scroll: HTMLDivElement
  let root: Root
  const scrollRef = { current: null } as React.RefObject<HTMLDivElement>

  beforeEach(() => {
    container = document.createElement('div')
    scroll = document.createElement('div')
    document.body.appendChild(container)
    document.body.appendChild(scroll)
    ;(scrollRef as { current: HTMLDivElement | null }).current = scroll
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    scroll.remove()
  })

  const nodes = () => container.querySelectorAll('.UNagent-nav-node')

  it('drops the dashes of removed turns after a rewind', () => {
    // a、b、c 三轮 —— 导航栏三个节点。
    const three: UiMessage[] = [
      userMsg('u1', '第一问'),
      aiMsg('a1', '回答一'),
      userMsg('u2', '第二问'),
      aiMsg('a2', '回答二'),
      userMsg('u3', '第三问'),
      aiMsg('a3', '回答三'),
    ]
    act(() => {
      root.render(<ConversationNav messages={three} scrollRef={scrollRef} />)
    })
    expect(nodes()).toHaveLength(3)

    // 回溯到第一轮（追加70 语义）：b、c 被移除 + 一条 assistant note。
    const after: UiMessage[] = [
      userMsg('u1', '第一问'),
      aiMsg('a1', '回答一'),
      aiMsg('note', '已回溯到第 1 轮（移除了 2 轮对话）。'),
    ]
    act(() => {
      root.render(<ConversationNav messages={after} scrollRef={scrollRef} />)
    })
    expect(nodes()).toHaveLength(1)
    expect(nodes()[0].getAttribute('aria-label')).toContain('第一问')
  })

  it('renders nothing once every question is gone', () => {
    const one: UiMessage[] = [userMsg('u1', '唯一一问'), aiMsg('a1', '回答')]
    act(() => {
      root.render(<ConversationNav messages={one} scrollRef={scrollRef} />)
    })
    expect(nodes()).toHaveLength(1)

    // 清空（删除当前对话后 messages = []）—— 整条导航栏消失。
    act(() => {
      root.render(<ConversationNav messages={[]} scrollRef={scrollRef} />)
    })
    expect(container.querySelectorAll('.UNagent-nav')).toHaveLength(0)
  })

  it('keeps surviving node ids in DOM order for querySelector navigation', () => {
    const msgs: UiMessage[] = [
      userMsg('u1', '第一问'),
      aiMsg('a1', '回答一'),
      userMsg('u2', '第二问'),
      aiMsg('a2', '回答二'),
    ]
    act(() => {
      root.render(<ConversationNav messages={msgs} scrollRef={scrollRef} />)
    })
    // 消息列表里的节点与导航项一一对应 —— goTo 靠 [data-ai-msg-id] 定位。
    for (const id of ['u1', 'a1']) {
      const el = document.createElement('div')
      el.setAttribute('data-ai-msg-id', id)
      scroll.appendChild(el)
    }
    // 回溯后仅剩 u1 —— 被移除消息的节点找不到时必须静默放弃，不抛错。
    const after: UiMessage[] = [userMsg('u1', '第一问'), aiMsg('a1', '回答一')]
    act(() => {
      root.render(<ConversationNav messages={after} scrollRef={scrollRef} />)
    })
    expect(nodes()).toHaveLength(1)
  })
})
