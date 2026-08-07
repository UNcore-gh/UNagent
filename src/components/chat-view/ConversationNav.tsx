import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UiMessage } from './types'

export interface NavItem {
  id: string
  /** Turn number among real (non-ephemeral) turns — matches /rewind's numbering. */
  turn: number | null
  label: string
  ephemeral: boolean
}

/** Hard cap on the locator label; overflow is elided with "…". */
const LABEL_CAP = 40
const FLASH_MS = 1300

/** Strip "![[…]]"/"[[…]]" down to human text: alias wins, bare image embeds
 *  become 〔图片〕, other binary embeds become 〔附件〕, notes keep their name. */
function wikilinkToText(inner: string): string {
  const [target, alias] = inner.split('|')
  if (alias && alias.trim()) return alias.trim()
  const t = (target ?? '').trim()
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(t)) return '〔图片〕'
  if (/\.(pdf|mp[34]|wav|m4a|ogg|webm|canvas|excalidraw)$/i.test(t)) {
    return '〔附件〕'
  }
  return t
}

/**
 * Short locator label for a user message: its first non-empty line, with a
 * leading slash directive ("/btw …", "//skill …") dropped and wikilink
 * attachments reduced to a readable token. `cap` bounds the length
 * (tooltips pass a smaller cap than the default).
 */
export function navLabel(
  content: string | undefined,
  cap: number = LABEL_CAP,
): string {
  const raw = (content ?? '').trim()
  if (!raw) return '（附件）'
  let line = ''
  for (const part of raw.split(/\r?\n/)) {
    const t = part.trim()
    if (t) {
      line = t
      break
    }
  }
  line = line
    .replace(/^\/{1,2}\S+\s+/, '') // "/btw 问题" → "问题"
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => wikilinkToText(inner))
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return '（附件）'
  return line.length > cap ? `${line.slice(0, cap)}…` : line
}

interface ConversationNavProps {
  messages: UiMessage[]
  /** The scrollable message list (its children carry data-ai-msg-id). */
  scrollRef: React.RefObject<HTMLDivElement>
}

// Question index riding the right edge exactly where the scrollbar used to
// be: the message list's own scrollbar is hidden (see the --nav CSS) and
// replaced by one short ink dash per user question. The dashes cluster
// around the vertical middle of the track (≈ half height) instead of
// stretching top-to-bottom — a compact tick column, not a ladder. Hovering
// the rail pops ONE panel listing every question (追加78: the old per-dash
// tooltip is gone — the panel shows the whole conversation index at once,
// and clicking a row jumps there); small arrows above and below the dash
// cluster step to the previous / next question. Clicking a dash still jumps
// straight there and flashes the message. A scrollspy accents the dash of
// the question currently being read. The whole rail is a pointer-events:none
// overlay — nothing in it can widen the page, so there is no empty region
// to scroll to on the right. (An earlier revision hid an expanded panel
// off-canvas with translateX — that still extended the overflow area and
// let the whole view pan right into nothing; gone now.)
export const ConversationNav = ({ messages, scrollRef }: ConversationNavProps) => {
  const [activeId, setActiveId] = useState<string | null>(null)
  // 追加78: hover 弹出的全量问题面板（纯白卡片）。触屏没有 hover，
  // matchMedia 守卫保证它只在真悬停设备上出现（触屏走 scrub + 箭头）。
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Touch scrubbing (追加⑱ 补刀): on touch, pressing the rail and dragging
  // scrubs through the questions instantly; a quick tap still jumps. State
  // drives a render (scrub affordance), the ref is read inside move
  // handlers so a fast drag never reads a stale closure.
  const [scrubbing, setScrubbing] = useState(false)
  const scrubbingRef = useRef(false)
  const nodesRef = useRef<HTMLDivElement>(null)
  const scrubTargetRef = useRef<{ id: string } | null>(null)

  const items = useMemo<NavItem[]>(() => {
    const out: NavItem[] = []
    let turn = 0
    for (const m of messages) {
      if (m.role !== 'user') continue
      const ephemeral = m.ephemeral === true
      if (!ephemeral) turn += 1
      out.push({
        id: m.id,
        turn: ephemeral ? null : turn,
        label: navLabel(m.content),
        ephemeral,
      })
    }
    return out
  }, [messages])

  // Scrollspy: the active question is the last user message whose top has
  // crossed a line a little below the container's top edge.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || items.length === 0) return
    let raf = 0
    const compute = () => {
      raf = 0
      const top = el.getBoundingClientRect().top
      let current: string | null = null
      for (const item of items) {
        const node = el.querySelector(`[data-ai-msg-id="${item.id}"]`)
        if (!node) continue
        if (node.getBoundingClientRect().top - top <= 56) current = item.id
        else break // messages sit in DOM order — no need to look further
      }
      setActiveId(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 追加: 用 rAF 延迟一帧再 compute，确保回溯/删除消息后 DOM 布局
    // 已稳定，getBoundingClientRect 不会读到过渡态值（避免 scrollspy
    // activeId 偏差）。
    raf = requestAnimationFrame(compute)
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollRef, items])

  const flash = useCallback(
    (id: string) => {
      const el = scrollRef.current
      if (!el) return
      const node = el.querySelector<HTMLElement>(`[data-ai-msg-id="${id}"]`)
      if (!node) return
      node.classList.add('UNagent-message--flash')
      window.setTimeout(
        () => node.classList.remove('UNagent-message--flash'),
        FLASH_MS,
      )
    },
    [scrollRef],
  )

  const goTo = useCallback(
    (id: string, smooth = true, doFlash = true) => {
      const el = scrollRef.current
      if (!el) return
      const node = el.querySelector<HTMLElement>(`[data-ai-msg-id="${id}"]`)
      if (!node) return
      const offset =
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        10
      el.scrollTo({
        top: Math.max(0, offset),
        behavior: smooth ? 'smooth' : 'auto',
      })
      if (doFlash) flash(id)
    },
    [scrollRef, flash],
  )

  // 追加78: 上/下箭头 —— 以 scrollspy 的当前问题为基准跳到前一问 / 后一问；
  // 尚无焦点（停在最顶部）时，▼ 去第一问、▲ 去最后一问。跳完立刻更新
  // activeId —— 平滑滚动触发的 scrollspy 还没来得及追上，连续点箭头
  // 必须能一轮一轮链式推进。
  const step = useCallback(
    (dir: -1 | 1) => {
      if (items.length === 0) return
      const idx = items.findIndex((it) => it.id === activeId)
      const target =
        idx === -1
          ? dir === 1
            ? items[0]
            : items[items.length - 1]
          : items[Math.min(items.length - 1, Math.max(0, idx + dir))]
      setActiveId(target.id)
      goTo(target.id)
    },
    [items, activeId, goTo],
  )

  // 追加78: 面板只在真悬停设备上弹出（触屏没有 hover，tap 会误触发
  // mouseenter —— 用媒体查询挡掉，触屏继续走 scrub + 箭头）。
  const openPanel = useCallback(() => {
    if (window.matchMedia('(hover: none)').matches) return
    setOpen(true)
  }, [])
  const closePanel = useCallback(() => setOpen(false), [])

  // 面板打开（或当前问题变化）时，把正在读的那一行滚进视野。
  useEffect(() => {
    if (!open) return
    const row = panelRef.current?.querySelector('.obsidian-ai-nav-row.is-active')
    row?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId])

  // Scrub: the finger's y maps linearly onto the question list. The scroll
  // is instant so it tracks the finger (smooth would lag behind it).
  const scrubAt = useCallback(
    (clientY: number) => {
      const el = nodesRef.current
      if (!el || items.length === 0) return
      const rect = el.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
      const index = Math.min(
        items.length - 1,
        Math.max(0, Math.round(frac * (items.length - 1))),
      )
      const target = items[index]
      scrubTargetRef.current = { id: target.id }
      goTo(target.id, false, false)
    },
    [items, goTo],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return
    // 追加78: 上下箭头按钮自带 click 跳转，不能被 scrub 抢走手势。
    if ((e.target as HTMLElement).closest('.obsidian-ai-nav-step')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubbingRef.current = true
    setScrubbing(true)
    scrubAt(e.clientY)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return
    scrubAt(e.clientY)
  }

  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return
    scrubbingRef.current = false
    setScrubbing(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Pointer may already be released on cancel.
    }
    const target = scrubTargetRef.current
    if (target?.id) flash(target.id) // confirm where the scrub landed
  }

  if (items.length === 0) return null

  return (
    <div className="UNagent-nav" role="navigation" aria-label="对话导航">
      <div
        className={`UNagent-nav-nodes${scrubbing ? ' is-scrubbing' : ''}`}
        ref={nodesRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onContextMenu={(e) => e.preventDefault()}
        onMouseEnter={openPanel}
        onMouseLeave={closePanel}
      >
        {/* 追加78: dash 簇 + 上下箭头收进一个居中的小簇里，箭头贴着
            浮动条区域的上下沿，快速跳前一问 / 后一问。 */}
        <div className="UNagent-nav-cluster">
          <button
            type="button"
            className="UNagent-nav-step"
            aria-label="上一问"
            onClick={() => step(-1)}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m6 15 6-6 6 6"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                'UNagent-nav-node' +
                (item.id === activeId ? ' is-active' : '') +
                (item.ephemeral ? ' is-ephemeral' : '')
              }
              onClick={(e) => {
                // Touch taps are handled by the rail's scrub handlers (they
                // jump on pointer-down); this click path is mouse-only.
                if ((e.nativeEvent as PointerEvent).pointerType === 'touch')
                  return
                goTo(item.id)
                // Never leave the node focused: a lingering :focus-visible
                // ring reads as a box around the dash.
                e.currentTarget.blur()
              }}
              aria-label={
                item.turn
                  ? `第 ${item.turn} 问：${item.label}`
                  : `顺便一问：${item.label}`
              }
            >
              <span className="UNagent-nav-dash" aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            className="UNagent-nav-step"
            aria-label="下一问"
            onClick={() => step(1)}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m6 9 6 6 6-6"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        {/* 追加78: 悬停弹出的全量问题面板 —— 纯白卡片，锚在导航条左侧
            垂直居中处，点击任一行即定位到那一问。 */}
        {open && (
          <div className="UNagent-nav-panel" ref={panelRef} role="menu">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={
                  'UNagent-nav-row' +
                  (item.id === activeId ? ' is-active' : '') +
                  (item.ephemeral ? ' is-ephemeral' : '')
                }
                onClick={() => goTo(item.id)}
              >
                <span className="UNagent-nav-row-num">{item.turn ?? '·'}</span>
                <span className="UNagent-nav-row-text">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
