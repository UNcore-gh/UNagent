import React from 'react'

import { useNativeMarkdown } from './nativeMarkdown'

/** Renders assistant text with Obsidian's NATIVE MarkdownRenderer (追加㉛,
 *  用户要求「始终原生渲染」) — the same DOM structure the reading view
 *  produces, so themes style AI output exactly like notes (tables get their
 *  wrappers, code blocks their native chrome). The `markdown-preview-view`
 *  class carries reading-view typography; `.obsidian-ai-markdown` is our
 *  layout-neutralizing scope (see styles.css). */
export const Markdown = React.memo(function Markdown({
  content,
}: {
  content: string
}) {
  const elRef = useNativeMarkdown(content)
  return (
    <div
      ref={elRef}
      className="UNagent-markdown markdown-preview-view markdown-rendered"
    />
  )
})
