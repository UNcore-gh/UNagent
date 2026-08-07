import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

import { Icon } from '../Icon'
import { Highlight } from './MentionPicker'

export interface CommandPickerHandle {
  move(delta: number): void
  selectActive(): void
}

/** A small icon button rendered at a row's right edge (row management
 *  actions, e.g. branch / delete on the conversation list). Clicking one
 *  fires onAction instead of selecting the row. */
export interface PickerItemAction {
  id: string
  /** Lucide icon name. */
  icon: string
  iconFallback?: string
  /** Tooltip + aria label. */
  label: string
  /** Render in the destructive (error) color. */
  danger?: boolean
}

export interface PickerItem {
  id: string
  label: string
  description?: string
  /** Faint secondary word right after the label (e.g. the English command). */
  sub?: string
  /** Lucide icon name. */
  icon?: string
  /** Fallback icon when `icon` is missing from this Obsidian build. */
  iconFallback?: string
  /** Optional right-edge badge (e.g. 当前 / usage hint). */
  badge?: string
  /** Optional per-row action buttons (requires the picker's onAction). */
  actions?: PickerItemAction[]
  /** Tree depth — indents the row (conversation manager children). */
  depth?: number
  /** Soft accent tint + left border (the conversation open right now). */
  current?: boolean
}

interface CommandPickerProps {
  ariaLabel: string
  title: React.ReactNode
  hint: string
  items: PickerItem[]
  /** Text to bold inside labels (usually the typed query). */
  query?: string
  emptyText: string
  onSelect: (id: string) => void
  /** Fired by a row's action button; the row itself is NOT selected. */
  onAction?: (itemId: string, actionId: string) => void
  onClose: () => void
  /** Visual variant — 'chats' styles the conversation manager page. */
  variant?: 'default' | 'chats'
  /** Rendered in-flow (portaled into the header dock, 追加⑯) instead of
   *  absolutely anchored above the composer. */
  docked?: boolean
}

// Generic bottom-sheet list used by the '/' command palette and its two
// submenus (think levels, saved branches). Visually a sibling of
// MentionPicker — same container/row classes.
export const CommandPicker = forwardRef<CommandPickerHandle, CommandPickerProps>(
  ({ ariaLabel, title, hint, items, query = '', emptyText, onSelect, onAction, onClose, variant = 'default', docked = false }, ref) => {
    const [activeIndex, setActiveIndex] = useState(0)
    const itemRefs = useRef<Array<HTMLDivElement | null>>([])

    useEffect(() => {
      setActiveIndex(0)
    }, [items.length, query])
    useEffect(() => {
      if (activeIndex >= items.length && items.length > 0) {
        setActiveIndex(items.length - 1)
      }
    }, [items.length, activeIndex])
    useEffect(() => {
      itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex])

    useImperativeHandle(
      ref,
      () => ({
        move(delta: number) {
          if (items.length === 0) return
          setActiveIndex((i) => (i + delta + items.length) % items.length)
        },
        selectActive() {
          const item = items[activeIndex] ?? items[0]
          if (item) onSelect(item.id)
        },
      }),
      [items, activeIndex, onSelect],
    )

    return (
      <div
        className={`UNagent-mention${
          variant === 'chats' ? ' UNagent-chats' : ''
        }${docked ? ' UNagent-mention--docked' : ''}`}
        role="listbox"
        aria-label={ariaLabel}
      >
        <div className="UNagent-mention-head">
          {/* The conversation manager has NO header — no title, no hint, no
              close button (追补刀: 用户报白条和叉，Esc/点击外部自动关). */}
          {variant !== 'chats' ? (
            <>
              <span className="UNagent-mention-title">{title}</span>
              <span className="UNagent-mention-hint">{hint}</span>
              <button
                className="UNagent-mention-close"
                onClick={onClose}
                aria-label={`关闭${ariaLabel}`}
              >
                <Icon name="x" />
              </button>
            </>
          ) : null}
        </div>

        <div className="UNagent-mention-list">
          {items.length === 0 && (
            <div className="UNagent-mention-empty">{emptyText}</div>
          )}

          {items.map((item, index) => (
            <div
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              role="option"
              aria-selected={index === activeIndex}
              className={
                'UNagent-mention-item' +
                (index === activeIndex ? ' UNagent-mention-item--active' : '') +
                (item.current ? ' is-current' : '')
              }
              style={
                item.depth && item.depth > 0
                  ? { paddingLeft: `${10 + item.depth * 14}px` }
                  : undefined
              }
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item.id)
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {item.icon && (
                <span className="UNagent-mention-icon">
                  <Icon name={item.icon} fallback={item.iconFallback} />
                </span>
              )}
              <span className="UNagent-mention-text">
                <span className="UNagent-mention-name">
                  <Highlight text={item.label} query={query} />
                  {item.sub && (
                    <span className="UNagent-mention-cmd">{item.sub}</span>
                  )}
                </span>
                {item.description && (
                  <span className="UNagent-mention-sub">{item.description}</span>
                )}
              </span>
              {item.badge && (
                <span className="UNagent-mention-badge UNagent-mention-badge--active">
                  {item.badge}
                </span>
              )}
              {item.actions && item.actions.length > 0 && (
                <span className="UNagent-mention-actions">
                  {item.actions.map((a) => (
                    <button
                      key={a.id}
                      className={`UNagent-mention-action${
                        a.danger ? ' is-danger' : ''
                      }`}
                      aria-label={a.label}
                      title={a.label}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onAction?.(item.id, a.id)
                      }}
                    >
                      <Icon name={a.icon} fallback={a.iconFallback ?? 'x'} />
                    </button>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  },
)

CommandPicker.displayName = 'CommandPicker'
