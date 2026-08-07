import { Component, MarkdownRenderer } from 'obsidian'
import { useEffect, useRef } from 'react'

import { usePlugin } from '../../contexts/plugin-context'
import type ObsidianAI from '../../main'

/** The AI answer rendered with Obsidian's NATIVE markdown renderer (追加㉛,
 *  用户要求「始终原生渲染」): identical DOM structure to the reading view
 *  (.markdown-rendered blocks, .table-wrapper tables, native code-block
 *  chrome), so EVERY theme that styles notes also styles the AI output —
 *  no more raw-element fallbacks to maintain per theme.
 *
 *  Lifecycle: a fresh Component per render carries the renderer's children
 *  (unload releases them); the previous render's DOM is emptied first.
 *  Streaming note: only the in-flight block re-renders per coalesced patch —
 *  memo'd sibling blocks keep their DOM untouched. */
export function useNativeMarkdown(
  content: string,
  post?: (el: HTMLElement) => void,
) {
  const plugin = usePlugin()
  const elRef = useRef<HTMLDivElement>(null)
  // Latest callback without retriggering the effect (identity churn).
  const postRef = useRef(post)
  postRef.current = post

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const comp = new Component()
    comp.load()
    el.empty()
    let cancelled = false
    void MarkdownRenderer.render(plugin.app, content, el, '', comp).then(
      () => {
        if (cancelled) return
        postRef.current?.(el)
        wireLinks(el, plugin)
      },
    )
    return () => {
      cancelled = true
      comp.unload()
    }
  }, [content, plugin])

  return elRef
}

/** Rendered links are inert outside a real view — wire them (pattern from
 *  the reference plugins): internal links open + pop the native hover
 *  preview; external links open in the system browser instead of
 *  navigating the plugin's webview. */
function wireLinks(el: HTMLElement, plugin: ObsidianAI) {
  el.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach((a) => {
    a.addEventListener('click', (evt) => {
      evt.preventDefault()
      const linktext = a.getAttribute('href')
      if (linktext) void plugin.app.workspace.openLinkText(linktext, '')
    })
    a.addEventListener('mouseenter', (evt) => {
      const linktext = a.getAttribute('href')
      if (!linktext) return
      ;(
        plugin.app.workspace as unknown as {
          trigger: (name: string, opts: unknown) => void
        }
      ).trigger('hover-link', {
        event: evt,
        source: 'UNagent',
        hoverParent: { popover: null },
        targetEl: a,
        linktext,
        sourcePath: '',
      })
    })
  })
  el.querySelectorAll<HTMLAnchorElement>('a.external-link').forEach((a) => {
    a.addEventListener('click', (evt) => {
      evt.preventDefault()
      const href = a.getAttribute('href')
      if (href) window.open(href, '_blank', 'noopener')
    })
  })
}
