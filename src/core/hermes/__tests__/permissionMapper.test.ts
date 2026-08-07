// M2-T7：权限帧（session/request_permission 载荷）→ 审批面板数据模型的
// 纯映射单测。载荷结构对照 hermes-agent-main/acp_adapter/：
// permissions.py（execute：{type:'content'} 文本块）与 edit_approval.py
// （edit：{type:'diff', path, oldText?, newText?}，oldText=null = 新建文件
// 或 V4A 多文件 patch）。scripted fake 帧直接构造线上形态的对象。

import type { HermesPermissionRequest } from '../types'
import {
  computeUnifiedDiff,
  parseHermesPermissionRequest,
} from '../blockMapper'

/** edit 类载荷：write_file 新建文件（oldText=null）。 */
const editNewFileRequest = (): HermesPermissionRequest => ({
  sessionId: 's1',
  toolCall: {
    toolCallId: 'edit-approval-1',
    title: 'Approve edit: notes/todo.md',
    kind: 'edit',
    status: 'pending',
    content: [
      {
        type: 'diff',
        path: 'notes/todo.md',
        oldText: null,
        newText: '# 待办\n- 买牛奶\n- 写周报\n',
      },
    ],
    rawInput: { tool: 'write_file', arguments: { path: 'notes/todo.md' } },
  },
  options: [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
    { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
  ],
})

/** edit 类载荷：patch replace（oldText/newText 都有）。 */
const editPatchRequest = (): HermesPermissionRequest => ({
  sessionId: 's1',
  toolCall: {
    toolCallId: 'edit-approval-2',
    title: 'Approve edit: src/main.ts',
    kind: 'edit',
    status: 'pending',
    content: [
      {
        type: 'diff',
        path: 'src/main.ts',
        oldText: 'const a = 1\nconst b = 2\nconst c = 3\n',
        newText: 'const a = 1\nconst b = 42\nconst c = 3\n',
      },
    ],
    rawInput: { tool: 'patch', arguments: { path: 'src/main.ts' } },
  },
  options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' }],
})

/** execute 类载荷：危险命令（permissions.py 的文本块形态）。 */
const executeRequest = (): HermesPermissionRequest => ({
  sessionId: 's1',
  toolCall: {
    toolCallId: 'perm-check-1',
    title: '删除文件: rm -rf build',
    kind: 'execute',
    status: 'pending',
    content: [
      { type: 'content', content: { type: 'text', text: '删除文件\n$ rm -rf build' } },
    ],
    rawInput: { command: 'rm -rf build', description: '删除文件' },
  },
  options: [{ optionId: 'allow_once', kind: 'allow_once', name: '允许' }],
})

describe('parseHermesPermissionRequest: edit 类载荷', () => {
  it('新建文件：路径 + 全量新增行 + isNewFile', () => {
    const model = parseHermesPermissionRequest(editNewFileRequest())
    expect(model.kind).toBe('edit')
    expect(model.title).toBe('Approve edit: notes/todo.md')
    expect(model.texts).toEqual([])
    expect(model.diffs).toHaveLength(1)
    const file = model.diffs[0]
    expect(file.path).toBe('notes/todo.md')
    expect(file.isNewFile).toBe(true)
    expect(file.lines.map((l) => l.type)).toEqual(['add', 'add', 'add'])
    expect(file.lines.map((l) => l.text)).toEqual(['# 待办', '- 买牛奶', '- 写周报'])
    expect(file.additions).toBe(3)
    expect(file.deletions).toBe(0)
    expect(file.truncated).toBe(false)
  })

  it('patch replace：LCS 行级 diff（上下文 + 删旧增新）', () => {
    const model = parseHermesPermissionRequest(editPatchRequest())
    const file = model.diffs[0]
    expect(file.path).toBe('src/main.ts')
    expect(file.isNewFile).toBe(false)
    expect(file.lines).toEqual([
      { type: 'ctx', text: 'const a = 1' },
      { type: 'del', text: 'const b = 2' },
      { type: 'add', text: 'const b = 42' },
      { type: 'ctx', text: 'const c = 3' },
    ])
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
    expect(file.totalLines).toBe(4)
  })

  it('V4A 多文件 patch（oldText=null）按新增渲染', () => {
    const req = editNewFileRequest()
    req.toolCall.content = [
      {
        type: 'diff',
        path: 'a.md, b.md',
        oldText: null,
        newText: '*** Update File: a.md\n+新增行\n*** Add File: b.md\n+内容',
      },
    ]
    const model = parseHermesPermissionRequest(req)
    expect(model.diffs[0].path).toBe('a.md, b.md')
    expect(model.diffs[0].isNewFile).toBe(true)
    expect(model.diffs[0].lines.every((l) => l.type === 'add')).toBe(true)
    expect(model.diffs[0].additions).toBe(4)
  })
})

describe('parseHermesPermissionRequest: 兜底与非 edit', () => {
  it('无 content 的请求：diffs/texts 为空，kind 与标题保留', () => {
    const req: HermesPermissionRequest = {
      toolCall: { toolCallId: 'x', kind: 'edit', title: 'Approve edit: f.md' },
      options: [],
    }
    const model = parseHermesPermissionRequest(req)
    expect(model.kind).toBe('edit')
    expect(model.title).toBe('Approve edit: f.md')
    expect(model.diffs).toEqual([])
    expect(model.texts).toEqual([])
  })

  it('畸形 diff 块（缺 path）被跳过，不崩', () => {
    const req = editNewFileRequest()
    req.toolCall.content = [
      { type: 'diff', oldText: null, newText: 'x' } as never,
      { type: 'diff', path: 'ok.md', oldText: null, newText: 'y' },
      'garbage' as never,
      null as never,
    ]
    const model = parseHermesPermissionRequest(req)
    expect(model.diffs).toHaveLength(1)
    expect(model.diffs[0].path).toBe('ok.md')
  })

  it('execute 类请求保持原语义：文本进 texts，diffs 为空', () => {
    const model = parseHermesPermissionRequest(executeRequest())
    expect(model.kind).toBe('execute')
    expect(model.texts).toEqual(['删除文件\n$ rm -rf build'])
    expect(model.diffs).toEqual([])
  })

  it('缺 kind 归一为 other', () => {
    const req: HermesPermissionRequest = {
      toolCall: { toolCallId: 'x', content: [] },
      options: [],
    }
    expect(parseHermesPermissionRequest(req).kind).toBe('other')
  })
})

describe('computeUnifiedDiff', () => {
  it('oldText=null → 全部 add；newText 空 → 全部 del', () => {
    const created = computeUnifiedDiff(null, 'a\nb')
    expect(created.lines.map((l) => l.type)).toEqual(['add', 'add'])
    const removed = computeUnifiedDiff('a\nb', '')
    expect(removed.lines.map((l) => l.type)).toEqual(['del', 'del'])
  })

  it('结尾换行不产生多余空行', () => {
    const r = computeUnifiedDiff('a\n', 'a\n')
    expect(r.lines).toEqual([{ type: 'ctx', text: 'a' }])
  })

  it('超大 diff 降级为整体替换并截断', () => {
    // 1200 × 1200 > LCS 上限 → 全删+全增 = 2400 行 > 1500 → 截断
    const oldText = Array.from({ length: 1200 }, (_, i) => `old-${i}`).join('\n')
    const newText = Array.from({ length: 1200 }, (_, i) => `new-${i}`).join('\n')
    const r = computeUnifiedDiff(oldText, newText)
    expect(r.totalLines).toBe(2400)
    expect(r.lines).toHaveLength(1500)
    expect(r.truncated).toBe(true)
    expect(r.additions).toBe(1200)
    expect(r.deletions).toBe(1200)
    expect(r.lines[0].type).toBe('del')
    expect(r.lines[1200].type).toBe('add')
  })
})
