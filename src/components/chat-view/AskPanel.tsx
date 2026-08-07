// AskPanel (追加63): the AI-initiated question surface for the ask_user tool.
// Rendered above the composer while the agent is waiting for an answer —
// preset quick answers the user can tap, PLUS a free-input box that is
// always present (the user may answer with anything). Submitting an answer
// resolves the pending ask_user tool call and the agent loop continues.
// 追加76: 多问题批 —— questions 数组按顺序逐题展示，答完一题自动切下一题
// （标题显示 2/3 进度），换题时输入框清空。
// 追加77: 多选模式 —— multiSelect=true 时选项为 checkbox 风格，用户勾选
// 多项后点击确认按钮统一提交；不设 multiSelect 或 false 时保持单选点击即交。

import { useCallback, useEffect, useRef, useState } from 'react'

import { Icon } from '../Icon'
import type { AskQuestion } from '../../core/agent/types'

export function AskPanel(props: {
  questions: AskQuestion[]
  index: number
  onAnswer: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const { questions, index, onAnswer, onCancel } = props
  const [draft, setDraft] = useState('')
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set())
  const question = questions[index] ?? { question: '' }
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  const batch = questions.length > 1
  // 追加65: 收集预设按钮供 ↑/↓ 键盘导航（桌面键盘流：↓ 进入预设项并逐项
  // 下移，↑ 回退，Enter 选择当前项）。
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  // 追加76: 换题时清空草稿与选项引用，避免上一题的残留。
  // 追加77: 多选模式下同时重置已选项。
  useEffect(() => {
    setDraft('')
    setSelectedOptions(new Set())
    optionRefs.current = []
  }, [index])

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onAnswer(text)
  }

  // 追加77: 多选模式——点击选项切换选中状态，不提交。
  const toggleOption = useCallback((opt: string): void => {
    setSelectedOptions((prev) => {
      const next = new Set(prev)
      if (next.has(opt)) {
        next.delete(opt)
      } else {
        next.add(opt)
      }
      return next
    })
  }, [])

  // 追加77: 提交多选结果。
  const submitMultiSelect = useCallback((): void => {
    const picked = Array.from(selectedOptions)
    if (picked.length === 0) return
    setSelectedOptions(new Set())
    onAnswer(picked.join(', '))
  }, [selectedOptions, onAnswer])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (options.length === 0) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const active = document.activeElement
    let idx = optionRefs.current.findIndex((el) => el === active)
    if (idx === -1) {
      // 焦点在输入框/面板其他处：↓ 从第一项开始，↑ 从最后一项开始。
      idx = e.key === 'ArrowDown' ? -1 : options.length
    }
    const step = e.key === 'ArrowDown' ? 1 : -1
    const next =
      (idx + step + options.length) % options.length
    optionRefs.current[next]?.focus()
  }

  // 追加77: 多选模式——选项点击切换，不提交；确认按钮调用 submitMultiSelect。
  const handleOptionClick = (opt: string): void => {
    if (multiSelect) {
      toggleOption(opt)
    } else {
      onAnswer(opt)
    }
  }

  // 追加77: 多选选项键盘——空格/回车切换选中。
  const handleOptionKeyDown = (
    e: React.KeyboardEvent,
    opt: string,
  ): void => {
    if (multiSelect && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      toggleOption(opt)
    }
  }

  return (
    <div className="UNagent-ask-panel" onKeyDown={onKeyDown}>
      <div className="UNagent-ask-header">
        <span className="UNagent-ask-title">
          <Icon name="help-circle" />
          AI 提问
          {batch && (
            <span className="UNagent-ask-progress">
              {index + 1}/{questions.length}
            </span>
          )}
        </span>
        <button
          className="UNagent-ask-close"
          onClick={onCancel}
          title="关闭提问（AI 继续自行处理）"
          aria-label="关闭提问"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="UNagent-ask-question">{question.question}</div>

      {options.length > 0 && (
        <div className="UNagent-ask-options">
          {options.map((opt, i) => (
            <button
              key={opt}
              ref={(el) => {
                optionRefs.current[i] = el
              }}
              className={
                'UNagent-ask-option' +
                (multiSelect && selectedOptions.has(opt)
                  ? ' UNagent-ask-option-selected'
                  : '')
              }
              data-multi-select={multiSelect || undefined}
              onClick={() => handleOptionClick(opt)}
              onKeyDown={(e) => handleOptionKeyDown(e, opt)}
            >
              {multiSelect && (
                <span className="UNagent-ask-option-check">
                  {selectedOptions.has(opt) ? (
                    <Icon name="check-square" fallback="check-circle" />
                  ) : (
                    <Icon name="square" fallback="circle" />
                  )}
                </span>
              )}
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* 追加77: 多选模式——确认按钮 */}
      {multiSelect && selectedOptions.size > 0 && (
        <button
          className="UNagent-ask-confirm"
          onClick={submitMultiSelect}
        >
          <Icon name="check" />
          确认选择（{selectedOptions.size}）
        </button>
      )}

      <div className="UNagent-ask-input-row">
        <input
          className="UNagent-ask-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="自由回答…"
          enterKeyHint="send"
        />
        <button
          className="UNagent-ask-send"
          onClick={submit}
          disabled={!draft.trim()}
          title="发送回答"
          aria-label="发送回答"
        >
          <Icon name="send" />
        </button>
      </div>
    </div>
  )
}
