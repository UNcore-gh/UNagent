// SuggestionsPanel (进化 B 案): confirmation surface for the AI's post-turn
// reflection suggestions. Rendered above the composer (AskPanel owns that
// slot while an ask_user question is open). ✓ approves ONE suggestion —
// memory/user entries land via the save_memory store, skill proposals run
// the /learn crystallization turn; × dismisses the whole panel. Nothing here
// writes on its own (B 案契约：默认不写盘，点确认才落盘).

import { Icon } from '../Icon'
import type { ReflectSuggestion } from '../../utils/reflect'

const TYPE_LABEL: Record<ReflectSuggestion['type'], string> = {
  memory: '长期记忆',
  user: '用户画像',
  skill: '技能结晶',
}

export function SuggestionsPanel(props: {
  suggestions: ReflectSuggestion[]
  onApprove: (s: ReflectSuggestion) => void
  onDismiss: () => void
}): JSX.Element {
  const { suggestions, onApprove, onDismiss } = props
  if (suggestions.length === 0) return <></>
  return (
    <div className="UNagent-suggest-panel">
      <div className="UNagent-suggest-header">
        <span className="UNagent-suggest-title">
          <Icon name="sparkles" />
          复盘建议 · 确认后才会保存
        </span>
        <button
          className="UNagent-suggest-close"
          onClick={onDismiss}
          title="全部忽略"
          aria-label="全部忽略"
        >
          <Icon name="x" />
        </button>
      </div>
      {suggestions.map((s) => (
        <div key={s.id} className="UNagent-suggest-row">
          <div className="UNagent-suggest-body">
            <span
              className="UNagent-suggest-badge"
              data-type={s.type}
            >
              {TYPE_LABEL[s.type]}
            </span>
            <span className="UNagent-suggest-content">{s.content}</span>
            {s.reason && (
              <span className="UNagent-suggest-reason">{s.reason}</span>
            )}
          </div>
          <button
            className="UNagent-suggest-approve"
            onClick={() => onApprove(s)}
            title="确认保存"
            aria-label="确认保存"
          >
            <Icon name="check" />
          </button>
        </div>
      ))}
    </div>
  )
}
