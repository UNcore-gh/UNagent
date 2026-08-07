// catalog: heuristic summary extraction (pure — no obsidian needed).

import { heuristicSummary } from '../catalog'

describe('heuristicSummary', () => {
  it('strips frontmatter and returns the first meaningful body line', () => {
    const content = `---
tags: [x]
---
# 标题

这是第一句正文。
第二句不算。`
    expect(heuristicSummary(content)).toBe('这是第一句正文。')
  })

  it('skips headings, hr, code fences and embeds', () => {
    const content = `## 大纲
---
\`\`\`js
code
\`\`\`
![[image.png]]
真正的正文在这里。`
    expect(heuristicSummary(content)).toBe('真正的正文在这里。')
  })

  it('removes list/quote markers and cleans markdown links', () => {
    expect(heuristicSummary('- 列表项内容')).toBe('列表项内容')
    expect(heuristicSummary('> 引用块内容')).toBe('引用块内容')
    expect(heuristicSummary('参考 [[另一篇笔记]] 和 [链接](https://x.com) 写的')).toBe(
      '参考 另一篇笔记 和 链接 写的',
    )
    expect(heuristicSummary('**加粗**和*斜体*以及`代码`')).toBe('加粗和斜体以及代码')
  })

  it('truncates at 80 chars with an ellipsis', () => {
    const line = '长'.repeat(120)
    const out = heuristicSummary(line)
    expect(out).toHaveLength(81)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string when nothing qualifies', () => {
    expect(heuristicSummary('')).toBe('')
    expect(heuristicSummary('# 只有标题')).toBe('')
    expect(heuristicSummary('![[only-embed.png]]')).toBe('')
  })
})
