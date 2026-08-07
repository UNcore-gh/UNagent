// Locator-label logic behind the conversation nav: first non-empty line of a
// user message, slash directives and wikilink attachments reduced to
// readable text, hard-capped so the panel ellipsis handles the rest.

import { navLabel } from '../ConversationNav'

describe('navLabel', () => {
  it('keeps the first non-empty line only', () => {
    expect(navLabel('\n\n帮我总结一下这篇\n第二段内容')).toBe('帮我总结一下这篇')
  })

  it('strips a leading slash directive', () => {
    expect(navLabel('/btw 这个函数干嘛的')).toBe('这个函数干嘛的')
    expect(navLabel('//weekly-report 写周报')).toBe('写周报')
  })

  it('keeps a bare directive when it is the whole message', () => {
    expect(navLabel('/branch')).toBe('/branch')
  })

  it('reduces wikilinks to their display text', () => {
    expect(navLabel('看看 [[项目计划|计划]] 这份')).toBe('看看 计划 这份')
    expect(navLabel('读一下 [[项目计划]]')).toBe('读一下 项目计划')
  })

  it('marks attachment-only messages', () => {
    expect(navLabel('![[截图.png]]')).toBe('〔图片〕')
    expect(navLabel('![[报告.pdf]]')).toBe('〔附件〕')
    expect(navLabel('![[图.jpg|封面]]')).toBe('封面')
    expect(navLabel('')).toBe('（附件）')
    expect(navLabel(undefined)).toBe('（附件）')
    expect(navLabel('   \n  ')).toBe('（附件）')
  })

  it('caps very long lines with an ellipsis', () => {
    const out = navLabel('问'.repeat(60))
    expect(out).toHaveLength(41) // 40 chars + …
    expect(out.endsWith('…')).toBe(true)
  })

  it('accepts a custom cap (node tooltips stay short)', () => {
    const out = navLabel('问'.repeat(50), 20)
    expect(out).toHaveLength(21) // 20 chars + …
    expect(out.endsWith('…')).toBe(true)
  })

  it('collapses inner whitespace', () => {
    expect(navLabel('多个   空白\t字符')).toBe('多个 空白 字符')
  })
})
