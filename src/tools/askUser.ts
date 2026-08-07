// ask_user: the agent asks the user for key information / a decision mid-run.
// The chat UI surfaces a panel above the composer with the preset options and
// a free-input box; the answer comes back here as the tool result, and the
// agent loop continues with it (追加63). 追加76: 可选 questions 数组 = 一次
// 调用顺序询问多个问题（答完一个再显示下一个），全部答完才返回。

import type {
  AskQuestion,
  AskQuestionBatch,
  Tool,
  ToolRunResult,
} from '../core/agent/types'

export const askUserTool: Tool = {
  metadata: {
    name: 'ask_user',
    description:
      'Ask the user a question when you lack key information or need a decision to proceed (e.g. which folder to use, whether to overwrite, what tone to pick). Provide 2-4 preset options AND leave room for free text — the user may answer with anything. Never invent critical details you could ask about; ask first, then continue. To ask several independent questions at once, pass them as a questions array (2+ items) — the user answers them one by one, in order. Set multiSelect=true to let the user pick multiple options at once (checkbox-style); the answer is the selected options joined by ", ".',
    category: 'manage',
    destructive: false,
    requiresVault: false,
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The question, clear and specific — the user answers this directly. Mutually exclusive with questions; when both are given, questions wins.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            '2-4 preset quick answers the user can tap (optional; a free-input box is always shown too).',
        },
        multiSelect: {
          type: 'boolean',
          description:
            'When true, options render as checkboxes the user can select multiple then confirm; the answer is the joined selections (default false).',
        },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'One question the user answers before seeing the next.',
              },
              options: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '2-4 preset quick answers for this question (optional).',
              },
              multiSelect: {
                type: 'boolean',
                description:
                  'When true, options render as checkboxes (default false).',
              },
            },
            required: ['question'],
          },
          description:
            '2+ questions asked sequentially in one call — the user answers each before the next appears; all answers come back together (optional; replaces question).',
        },
      },
      required: ['question'],
    },
  },

  async run(args, ctx): Promise<ToolRunResult> {
    // 追加76: questions 数组提供时按批量询问（长度 1 退化为单问题）。
    const rawQuestions = Array.isArray(args.questions) ? args.questions : []
    const questions: AskQuestion[] = []
    for (const item of rawQuestions) {
      if (typeof item !== 'object' || item === null) continue
      const q = String((item as { question?: unknown }).question ?? '').trim()
      if (!q) continue
      const options = Array.isArray((item as { options?: unknown }).options)
        ? ((item as { options?: unknown[] }).options ?? []).filter(
            (o): o is string => typeof o === 'string',
          )
        : []
      const multiSelect = (item as { multiSelect?: unknown }).multiSelect === true
      questions.push({ question: q, options, ...(multiSelect ? { multiSelect: true } : {}) })
    }

    let ask: AskQuestion | AskQuestionBatch
    if (questions.length >= 2) {
      ask = { questions }
    } else if (questions.length === 1) {
      ask = questions[0]
    } else {
      const question = typeof args.question === 'string' ? args.question : ''
      if (!question.trim()) {
        return {
          ok: false,
          summary: 'ask_user 缺少问题文本',
          output: { error: 'missing_question' },
        }
      }
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string')
        : []
      const multiSelect = args.multiSelect === true
      ask = { question, options, ...(multiSelect ? { multiSelect: true } : {}) }
    }

    if (!ctx.askUser) {
      return {
        ok: false,
        summary: '当前环境不支持向用户提问',
        output: { error: 'unsupported' },
      }
    }
    const res = await ctx.askUser(ask)
    if (res.cancelled) {
      // 批量中途关闭：已答部分仍交给 AI 用（不白费），一条没答才是取消。
      if (res.answers && res.answers.length > 0) {
        return {
          ok: true,
          summary: `用户回答了 ${res.answers.length}/${questions.length} 个问题后关闭：${res.answers.join(' / ')}`,
          output: { answers: res.answers, partial: true },
        }
      }
      return {
        ok: false,
        summary: '用户关闭了提问',
        output: { error: 'user_cancelled' },
      }
    }
    if (res.answers && res.answers.length > 1) {
      return {
        ok: true,
        summary: `用户回答：${res.answers.join(' / ')}`,
        output: { answers: res.answers },
      }
    }
    return {
      ok: true,
      summary: `用户回答：${res.answer}`,
      output: { answer: res.answer },
    }
  },
}
