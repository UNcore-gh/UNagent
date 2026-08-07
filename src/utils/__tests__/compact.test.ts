// Context-compression helpers (/compact): the one-shot prompt (default
// lossless method + optional user strategy), transcript rendering (ephemeral
// asides excluded), output parsing on the 【记忆】 marker, and the result
// bubble text.

import type { UiMessage } from '../../components/chat-view/types'
import {
  MAX_COMPACT_MEMORIES,
  MEMORY_MARKER,
  MIN_COMPACT_MESSAGES,
  buildCompactPrompt,
  buildCompactTranscript,
  compactionMessageText,
  parseCompactResult,
} from '../compact'

const msg = (
  role: 'user' | 'assistant',
  text: string,
  ephemeral = false,
): UiMessage => ({
  id: 'x',
  role,
  ...(role === 'user'
    ? { content: text }
    : { blocks: [{ kind: 'text' as const, text }] }),
  ...(ephemeral ? { ephemeral: true } : {}),
})

describe('buildCompactPrompt', () => {
  it('carries the lossless-summary rules and the output format', () => {
    const p = buildCompactPrompt()
    expect(p).toContain('无损摘要')
    expect(p).toContain('必须保留')
    expect(p).toContain(MEMORY_MARKER)
    expect(p).toContain(String(MAX_COMPACT_MEMORIES))
    expect(p).not.toContain('用户的压缩策略要求')
  })

  it('appends the user strategy with priority when given', () => {
    const p = buildCompactPrompt('只保留决策和文件路径')
    expect(p).toContain('用户的压缩策略要求（优先遵循）：只保留决策和文件路径')
  })

  it('treats a blank strategy as the default method', () => {
    expect(buildCompactPrompt('   ')).not.toContain('用户的压缩策略要求')
    expect(buildCompactPrompt('')).not.toContain('用户的压缩策略要求')
  })
})

describe('buildCompactTranscript', () => {
  it('renders user / assistant turns with role labels', () => {
    const t = buildCompactTranscript([
      msg('user', '帮我建个笔记'),
      msg('assistant', '已创建 [[甲]]'),
    ])
    expect(t).toContain('用户：帮我建个笔记')
    expect(t).toContain('助手：已创建 [[甲]]')
  })

  it('skips ephemeral /btw asides and empty messages', () => {
    const t = buildCompactTranscript([
      msg('user', '顺便问下', true),
      msg('user', ''),
      msg('user', '真正的问题'),
    ])
    expect(t).not.toContain('顺便问下')
    expect(t).toBe('用户：真正的问题')
  })

  it('reads assistant text from blocks', () => {
    const t = buildCompactTranscript([msg('assistant', '块里的文字')])
    expect(t).toBe('助手：块里的文字')
  })

  it('includes the tool trace for assistant messages with tool blocks (Task #8)', () => {
    // 转录走 historyTextOfBlocks：工具块现在会以【工具轨迹】进入压缩实录。
    const m: UiMessage = {
      id: 'x',
      role: 'assistant',
      blocks: [
        { kind: 'text', text: '已经处理好了。' },
        {
          kind: 'tool',
          callId: 'c1',
          name: 'create_note',
          args: { path: '甲.md' },
          state: 'done',
          summary: '已创建 甲.md',
        },
      ],
    }
    const t = buildCompactTranscript([m])
    expect(t).toContain('助手：已经处理好了。')
    expect(t).toContain('【工具轨迹】')
    expect(t).toContain('[工具] create_note(')
    expect(t).toContain('已创建 甲.md')
  })
})

describe('parseCompactResult', () => {
  it('splits the summary from the memory bullets', () => {
    const raw = `这是摘要。\n\n${MEMORY_MARKER}\n- 用户喜欢中文\n- 偏好移动端优先`
    const r = parseCompactResult(raw)
    expect(r.summary).toBe('这是摘要。')
    expect(r.memories).toEqual(['用户喜欢中文', '偏好移动端优先'])
  })

  it('drops the 无 placeholder and empty bullets', () => {
    const raw = `摘要\n${MEMORY_MARKER}\n- 无\n-\n  \n`
    const r = parseCompactResult(raw)
    expect(r.summary).toBe('摘要')
    expect(r.memories).toEqual([])
  })

  it('tolerates a missing marker (summary only)', () => {
    const r = parseCompactResult('只有摘要，没有记忆节。')
    expect(r.summary).toBe('只有摘要，没有记忆节。')
    expect(r.memories).toEqual([])
  })
})

describe('compactionMessageText', () => {
  it('reports the saved-memory count and embeds the summary', () => {
    const t = compactionMessageText('摘要内容', 2)
    expect(t).toContain('2 条长期记忆')
    expect(t).toContain('摘要内容')
  })

  it('says so when no memories were saved', () => {
    expect(compactionMessageText('s', 0)).toContain('未写入新的长期记忆')
  })

  it('echoes the user strategy when one was given', () => {
    const t = compactionMessageText('s', 0, '只留结论')
    expect(t).toContain('按你的压缩策略：只留结论')
    expect(compactionMessageText('s', 0, '  ')).not.toContain('按你的压缩策略')
  })
})

describe('limits', () => {
  it('ship the agreed bounds', () => {
    expect(MAX_COMPACT_MEMORIES).toBe(5)
    expect(MIN_COMPACT_MESSAGES).toBe(4)
  })
})
