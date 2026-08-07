// ask_user tool (追加63): the agent asks the user for key information / a
// decision mid-run; the answer comes back as the tool result and the agent
// loop continues. No vault involved — ctx.askUser IS the interaction surface.
// 追加76: questions 数组 = 一次调用顺序询问多题，全部答完（或中途关闭）
// 才返回；单问题路径行为不变。

import type {
  AskQuestion,
  AskQuestionBatch,
  ToolContext,
} from '../../core/agent/types'
import { askUserTool } from '../askUser'

function mkCtx(
  askUser?: (
    q: AskQuestion | AskQuestionBatch,
  ) => Promise<{ answer: string; answers?: string[]; cancelled: boolean }>,
): ToolContext {
  return { app: {} as never, confirm: async () => true, askUser } as unknown as ToolContext
}

describe('ask_user tool', () => {
  it('fails fast when question is missing/blank', async () => {
    const calls: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      if ('question' in q) calls.push(q)
      return Promise.resolve({ answer: 'x', cancelled: false })
    })
    const missing = await askUserTool.run({}, ctx)
    expect(missing.ok).toBe(false)
    expect(missing.output).toEqual({ error: 'missing_question' })

    const blank = await askUserTool.run({ question: '   ' }, ctx)
    expect(blank.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('degrades when the context offers no askUser surface', async () => {
    const res = await askUserTool.run({ question: 'hi?' }, mkCtx())
    expect(res.ok).toBe(false)
    expect(res.output).toEqual({ error: 'unsupported' })
  })

  it('returns the free-text answer to the agent', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      if ('question' in q) seen.push(q)
      return Promise.resolve({ answer: '我的回答', cancelled: false })
    })
    const res = await askUserTool.run(
      { question: '要用哪个文件夹？', options: ['A', 'B'] },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({ answer: '我的回答' })
    expect(res.summary).toContain('我的回答')
    expect(seen).toEqual([
      { question: '要用哪个文件夹？', options: ['A', 'B'] },
    ])
  })

  it('reports a dismissed panel as user_cancelled', async () => {
    const ctx = mkCtx(() => Promise.resolve({ answer: '', cancelled: true }))
    const res = await askUserTool.run({ question: '继续吗？' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.output).toEqual({ error: 'user_cancelled' })
  })

  it('filters non-string options before showing them', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestion)
      return Promise.resolve({ answer: 'A', cancelled: false })
    })
    await askUserTool.run(
      { question: 'q', options: ['A', 42, 'B', null] },
      ctx,
    )
    expect(seen[0].options).toEqual(['A', 'B'])
  })

  // 追加76: 多问题批。
  it('asks a questions batch sequentially and returns all answers', async () => {
    const seen: AskQuestionBatch[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestionBatch)
      return Promise.resolve({
        answer: '答案一',
        answers: ['答案一', '答案二'],
        cancelled: false,
      })
    })
    const res = await askUserTool.run(
      {
        questions: [
          { question: '第一个问题？', options: ['A', 'B'] },
          { question: '第二个问题？' },
        ],
      },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({ answers: ['答案一', '答案二'] })
    expect(res.summary).toContain('答案一')
    expect(res.summary).toContain('答案二')
    expect(seen).toEqual([
      {
        questions: [
          { question: '第一个问题？', options: ['A', 'B'] },
          { question: '第二个问题？', options: [] },
        ],
      },
    ])
  })

  it('treats a single-item questions array as a plain question', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestion)
      return Promise.resolve({ answer: '就它', cancelled: false })
    })
    const res = await askUserTool.run({ questions: [{ question: '单选？' }] }, ctx)
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({ answer: '就它' })
    expect(seen).toEqual([{ question: '单选？', options: [] }])
  })

  it('prefers questions over question when both are given', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestion)
      return Promise.resolve({ answer: 'x', cancelled: false })
    })
    await askUserTool.run(
      { question: '旧问题', questions: [{ question: '新问题' }, { question: '问题2' }] },
      ctx,
    )
    expect(seen).toEqual([
      {
        questions: [
          { question: '新问题', options: [] },
          { question: '问题2', options: [] },
        ],
      },
    ])
  })

  it('returns partial answers when the user closes the panel mid-batch', async () => {
    const ctx = mkCtx(() =>
      Promise.resolve({
        answer: '',
        answers: ['已答第一题'],
        cancelled: true,
      }),
    )
    const res = await askUserTool.run(
      {
        questions: [{ question: '一' }, { question: '二' }],
      },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({ answers: ['已答第一题'], partial: true })
    expect(res.summary).toContain('1/2')
  })

  it('reports user_cancelled when the batch is closed before any answer', async () => {
    const ctx = mkCtx(() =>
      Promise.resolve({ answer: '', answers: [], cancelled: true }),
    )
    const res = await askUserTool.run(
      {
        questions: [{ question: '一' }, { question: '二' }],
      },
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(res.output).toEqual({ error: 'user_cancelled' })
  })

  it('skips malformed batch items and falls back when none remain', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestion)
      return Promise.resolve({ answer: '兜底', cancelled: false })
    })
    const res = await askUserTool.run(
      {
        questions: [null, { options: ['无问题'] }, { question: '   ' }],
        question: '真的问题？',
      },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(seen).toEqual([{ question: '真的问题？', options: [] }])
  })

  it('filters non-string options inside batch items', async () => {
    const seen: AskQuestionBatch[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestionBatch)
      return Promise.resolve({
        answer: 'a',
        answers: ['a', 'b'],
        cancelled: false,
      })
    })
    await askUserTool.run(
      {
        questions: [
          { question: '一', options: ['A', 42, null] },
          { question: '二', options: ['B'] },
        ],
      },
      ctx,
    )
    expect(seen[0].questions[0].options).toEqual(['A'])
    expect(seen[0].questions[1].options).toEqual(['B'])
  })

  // 追加77: 多选模式。
  it('passes multiSelect=true through for single question', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestion)
      return Promise.resolve({
        answer: '标签1, 标签2',
        cancelled: false,
      })
    })
    const res = await askUserTool.run(
      {
        question: '选你喜欢的标签',
        options: ['标签1', '标签2', '标签3'],
        multiSelect: true,
      },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.output).toEqual({ answer: '标签1, 标签2' })
    expect(seen[0].multiSelect).toBe(true)
  })

  it('passes multiSelect through in batch items', async () => {
    const seen: AskQuestionBatch[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestionBatch)
      return Promise.resolve({
        answer: 'a',
        answers: ['a', 'b'],
        cancelled: false,
      })
    })
    await askUserTool.run(
      {
        questions: [
          { question: '单/多？', options: ['单', '多'], multiSelect: true },
          { question: '普通？', options: ['是', '否'] },
        ],
      },
      ctx,
    )
    expect(seen[0].questions[0].multiSelect).toBe(true)
    expect(seen[0].questions[1].multiSelect).toBeUndefined()
  })

  it('defaults multiSelect to false/undefined when not set', async () => {
    const seen: AskQuestion[] = []
    const ctx = mkCtx((q) => {
      seen.push(q as AskQuestion)
      return Promise.resolve({ answer: 'A', cancelled: false })
    })
    await askUserTool.run(
      { question: '普通问题？', options: ['A', 'B'] },
      ctx,
    )
    expect(seen[0].multiSelect).toBeUndefined()
  })
})
