// Pure-helper tests for the unified selection→reference builder (追加68).
// DOM-dependent buildSelectionRef itself is exercised manually in the vault.

import {
  cleanSelection,
  findCanvasFileWithNodeId,
  findCanvasNodeIdByText,
  markdownTableRowContext,
  tableRowContext,
} from '../selectionRef'

// Minimal fake vault: getFiles() + read() only — tests never touch the real
// Obsidian runtime.
function fakeApp(files: Array<{ path: string; content: string }>) {
  return {
    vault: {
      getFiles: () =>
        files.map((f) => ({
          path: f.path,
          basename: f.path.split('/').pop()!.replace(/\.[^.]+$/, ''),
          extension: f.path.split('.').pop() ?? '',
        })),
      read: async (f: { path: string }) => {
        const found = files.find((x) => x.path === f.path)
        if (!found) throw new Error('missing')
        return found.content
      },
    },
  } as never
}

describe('cleanSelection', () => {
  it('strips markdown markers and newlines', () => {
    expect(cleanSelection('==高亮== 和 **加粗**\n下一行')).toBe('高亮 和 加粗下一行')
  })

  it('strips 」 so ref tokens never truncate mid-way (补刀85)', () => {
    // 引用 token 是 `[[…]]「…」`，片段里残留 」 会让 token 半路截断、
    // 剩余文字漏到 chip 旁边——所有片段入 token 前都必须过这道清洗。
    expect(cleanSelection('关于「存储重构」的问题')).toBe('关于「存储重构的问题')
  })
})

describe('findCanvasNodeIdByText', () => {
  const canvas = JSON.stringify({
    nodes: [
      { id: 'aaa', type: 'text', text: '今天学了 **React** 状态管理' },
      { id: 'bbb', type: 'text', text: '购物清单\n- 牛奶' },
      { id: 'ccc', type: 'file', file: 'note.md' },
    ],
  })

  it('matches rendered selection against raw markdown node text', () => {
    // Selection renders without the ** markers — matching must strip them.
    expect(findCanvasNodeIdByText(canvas, 'React 状态管理')).toBe('aaa')
  })

  it('matches multi-line selection flattened', () => {
    expect(findCanvasNodeIdByText(canvas, '购物清单 - 牛奶')).toBe('bbb')
  })

  it('matches card (file) nodes by filename — 选中卡片无选区时引用整卡（追加70）', () => {
    expect(findCanvasNodeIdByText(canvas, 'note')).toBe('ccc')
  })

  it('returns null on no match / bad json / empty probe', () => {
    expect(findCanvasNodeIdByText(canvas, '不存在的内容')).toBeNull()
    expect(findCanvasNodeIdByText('{oops', 'x')).toBeNull()
    expect(findCanvasNodeIdByText(canvas, '  ')).toBeNull()
  })
})

describe('findCanvasFileWithNodeId', () => {
  const mk = (year: string, id?: string) => ({
    path: `Memos/${year}.canvas`,
    content: JSON.stringify({
      nodes: id ? [{ id, type: 'text', text: 'memo' }] : [],
    }),
  })

  it('finds the canvas file containing the node id', async () => {
    const app = fakeApp([mk('2025'), mk('2026', '2026072601370000')])
    const file = await findCanvasFileWithNodeId(app, '2026072601370000')
    expect(file?.path).toBe('Memos/2026.canvas')
  })

  it('returns null when no canvas file holds the id', async () => {
    const app = fakeApp([mk('2025'), mk('2026')])
    expect(await findCanvasFileWithNodeId(app, '2026072601370000')).toBeNull()
  })

  it('returns null when there are no canvas files at all', async () => {
    const app = fakeApp([{ path: 'note.md', content: 'hi' }])
    expect(await findCanvasFileWithNodeId(app, '2026072601370000')).toBeNull()
  })
})

describe('tableRowContext', () => {
  it('pairs each cell with its header', () => {
    expect(
      tableRowContext(['姓名', '年龄'], ['张三', '20']),
    ).toBe('姓名: 张三 | 年龄: 20')
  })

  it('falls back to 列N when a header is missing and drops empty cells', () => {
    expect(tableRowContext(['姓名'], ['张三', '', 'x'])).toBe(
      '姓名: 张三 | 列3: x',
    )
  })
})

describe('markdownTableRowContext', () => {
  const note = [
    '# 预算表',
    '',
    '| 项目 | 金额 | 备注 |',
    '| --- | ---: | --- |',
    '| 房租 | 3000 | 每月 1 号 |',
    '| 水电 | 200 | ==浮动== |',
    '',
    '正文段落，不是表格。',
  ].join('\n')

  it('single-cell selection → precise 「表头: 选中文字」 (追加71)', () => {
    // 实时预览源码模式下选中的是渲染文本（无 == 标记）——要能对上源码行。
    expect(markdownTableRowContext(note, '3000')).toBe('金额: 3000')
  })

  it('matches through markdown markers inside the cell', () => {
    expect(markdownTableRowContext(note, '浮动')).toBe('备注: 浮动')
  })

  it('partial-cell selection keeps the exact selected text', () => {
    // 只选了单元格里的一部分——引用必须是选中的那几个字，不是整格。
    expect(markdownTableRowContext(note, '每月 1')).toBe('备注: 每月 1')
  })

  it('cross-cell selection falls back to full-row context', () => {
    expect(markdownTableRowContext(note, '房租 3000')).toBe(
      '项目: 房租 | 金额: 3000 | 备注: 每月 1 号',
    )
  })

  it('never matches the header or separator row itself', () => {
    expect(markdownTableRowContext(note, '---:')).toBeNull()
  })

  it('returns null when the probe matches no table row', () => {
    expect(markdownTableRowContext(note, '正文段落')).toBeNull()
    expect(markdownTableRowContext(note, '  ')).toBeNull()
  })
})
