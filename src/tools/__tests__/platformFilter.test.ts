// 补刀·五十四：desktopOnly 工具的注册过滤——移动端连 schema 都看不到。
// run_local_agent（补刀·五十四）已在能力门控收口时移除（/hermes 任务分发
// 取代它），ALL_TOOLS 目前没有 desktopOnly 工具；此套件守住过滤机制本身，
// 未来新增桌面专属工具时照此断言。
// Platform 是 jest stub 里的可变对象，测完必须还原。

import { Platform } from 'obsidian'
import type { Tool } from '../../core/agent/types'
import { ALL_TOOLS, filterToolsForPlatform } from '../index'

afterEach(() => {
  Platform.isMobile = false
})

describe('filterToolsForPlatform', () => {
  it('has no desktopOnly tool left in ALL_TOOLS (run_local_agent removed)', () => {
    expect(ALL_TOOLS.filter((t) => t.metadata.desktopOnly)).toHaveLength(0)
  })

  it('keeps every tool on desktop', () => {
    Platform.isMobile = false
    expect(filterToolsForPlatform(ALL_TOOLS)).toHaveLength(ALL_TOOLS.length)
  })

  it('keeps the full set on mobile while nothing is desktopOnly', () => {
    Platform.isMobile = true
    expect(filterToolsForPlatform(ALL_TOOLS)).toHaveLength(ALL_TOOLS.length)
    // Core note tools survive — mobile functionality is untouched.
    expect(ALL_TOOLS.find((t) => t.metadata.name === 'search_notes')).toBeDefined()
    expect(ALL_TOOLS.find((t) => t.metadata.name === 'save_memory')).toBeDefined()
  })

  it('drops desktopOnly tools on mobile but keeps the rest (mechanism)', () => {
    // Synthetic desktopOnly tool — the filter must still hide it on mobile.
    const synthetic: Tool = {
      ...ALL_TOOLS[0],
      metadata: { ...ALL_TOOLS[0].metadata, name: 'synthetic_desktop', desktopOnly: true },
    }
    const withSynthetic = [...ALL_TOOLS, synthetic]
    Platform.isMobile = true
    const filtered = filterToolsForPlatform(withSynthetic)
    expect(filtered).toHaveLength(withSynthetic.length - 1)
    expect(filtered.find((t) => t.metadata.name === 'synthetic_desktop')).toBeUndefined()

    Platform.isMobile = false
    expect(filterToolsForPlatform(withSynthetic)).toHaveLength(withSynthetic.length)
  })

  it('leaves a custom tool list without desktopOnly entries untouched', () => {
    const plain: Tool[] = ALL_TOOLS.filter((t) => !t.metadata.desktopOnly).slice(0, 3)
    Platform.isMobile = true
    expect(filterToolsForPlatform(plain)).toHaveLength(3)
  })
})
