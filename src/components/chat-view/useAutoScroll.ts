import { useCallback, useEffect, useRef } from 'react'

const PROGRAMMATIC_SCROLL_DEBOUNCE_MS = 50
const SCROLL_AWAY_FROM_BOTTOM_THRESHOLD = 20

// Auto-scrolls the message list to the bottom as new tokens stream in, but
// stops interfering once the user has deliberately scrolled up to read.
export function useAutoScroll(
  scrollContainerRef: React.RefObject<HTMLElement>,
) {
  const preventAutoScrollRef = useRef(false)
  const lastProgrammaticScrollRef = useRef<number>(0)

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const handleScroll = () => {
      if (
        Date.now() - lastProgrammaticScrollRef.current <
        PROGRAMMATIC_SCROLL_DEBOUNCE_MS
      ) {
        return
      }
      preventAutoScrollRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight >
        SCROLL_AWAY_FROM_BOTTOM_THRESHOLD
    }

    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [scrollContainerRef])

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (el && el.scrollTop !== el.scrollHeight) {
      lastProgrammaticScrollRef.current = Date.now()
      el.scrollTop = el.scrollHeight
    }
  }, [scrollContainerRef])

  const autoScrollToBottom = useCallback(() => {
    if (!preventAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [scrollToBottom])

  /** 回溯/删除消息后重置防止自动滚动标志，确保后续新消息能继续自动滚到底部。 */
  const resetPreventAutoScroll = useCallback(() => {
    preventAutoScrollRef.current = false
  }, [])

  return { autoScrollToBottom, resetPreventAutoScroll }
}
