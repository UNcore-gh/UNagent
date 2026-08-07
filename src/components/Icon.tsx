import { setIcon } from 'obsidian'
import { useEffect, useRef } from 'react'

// Wraps Obsidian's bundled Lucide set. Stroke icons inherit the current text
// color, so they match Obsidian's native UI everywhere — emoji glyphs render
// inconsistently across mobile platforms and clash with the app chrome.
// Size follows the parent's font-size (1em); color follows CSS `color`.
// `fallback` guards against icons missing from a given Obsidian build's
// bundled subset: if setIcon leaves the span empty, retry with the fallback.
export const Icon = ({ name, fallback }: { name: string; fallback?: string }) => {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setIcon(el, name)
    if (fallback && el.childNodes.length === 0) setIcon(el, fallback)
  }, [name, fallback])
  return <span ref={ref} className="UNagent-icon" aria-hidden="true" />
}
