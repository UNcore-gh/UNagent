import type { TodoItem, TodoStatus } from '../../tools/todoWrite'
import { Icon } from '../Icon'
import type { UiBlock } from './types'

export type TodoBlockData = Extract<UiBlock, { kind: 'todo' }>

/** Status icon per item: pending = hollow circle, in_progress = spinning
 *  loader, completed = check. Fallbacks guard against missing glyphs in
 *  older Obsidian builds' bundled icon subset. */
const STATUS_ICON: Record<TodoStatus, { name: string; fallback: string }> = {
  pending: { name: 'circle', fallback: 'circle' },
  in_progress: { name: 'loader', fallback: 'arrow-right' },
  completed: { name: 'check', fallback: 'check-circle' },
}

/**
 * The live task list (清单) — Claude Code's TodoWrite visualization. ONE
 * block per assistant message: every todo_write call upserts it, so items
 * visibly move pending → in_progress → completed while the agent works.
 * Persisted with the conversation, so re-opening a chat replays the final
 * list state. Pure static markup (no buttons) — mobile-safe, zero handlers.
 */
export const TodoBlock = ({ block }: { block: TodoBlockData }) => {
  const total = block.items.length
  const done = block.items.filter((i) => i.status === 'completed').length
  const running = block.state === 'running'

  return (
    <div
      className={`UNagent-todo${
        block.state === 'error' ? ' UNagent-todo--error' : ''
      }`}
    >
      <div className="UNagent-todo-head">
        <span
          className={`UNagent-todo-head-icon${
            running ? ' UNagent-todo-head-icon--running' : ''
          }`}
        >
          <Icon name="list-checks" fallback="check-circle" />
        </span>
        <span className="UNagent-todo-head-title">任务清单</span>
        <span className="UNagent-todo-head-meta">
          {running
            ? `${done}/${total} · 进行中…`
            : done === total
              ? `${total} 项全部完成`
              : `${done}/${total} 已完成`}
        </span>
      </div>
      <div className="UNagent-todo-items">
        {block.items.map((item: TodoItem, index: number) => {
          const icon = STATUS_ICON[item.status] ?? STATUS_ICON.pending
          return (
            <div
              key={`${index}-${item.content}`}
              className={`UNagent-todo-item UNagent-todo-item--${item.status}`}
            >
              <span
                className={`UNagent-todo-item-icon${
                  item.status === 'in_progress'
                    ? ' UNagent-todo-item-icon--spin'
                    : ''
                }`}
              >
                <Icon name={icon.name} fallback={icon.fallback} />
              </span>
              <span className="UNagent-todo-item-text">{item.content}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
