import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { Skill } from '../../core/skills/types'
import { Icon } from '../Icon'
import { buildSkillCandidates, SkillItem } from './slash'
import { Highlight } from './MentionPicker'

export interface SlashPickerHandle {
  move(delta: number): void
  selectActive(): void
}

interface SlashPickerProps {
  query: string
  /** Skills visible this run (master toggle + disabled list applied). */
  skills: Skill[]
  /** Called with the chosen skill name; the composer wraps it as "/name ". */
  onSelect: (name: string) => void
  onClose: () => void
}

// Skill picker opened by a leading '//'. Visually a sibling of MentionPicker
// (same container/row classes), listing skills with a source badge; selecting
// one prefixes the message with "//skill-name" which useAgent resolves into a
// force-loaded skill for that turn.
//
// Badge policy (补刀·五十八): badges only carry *differentiating* info.
//   builtin      → 官方 (main-agent picker: official vs user)
//   user         → 用户 (main-agent picker)
//   hermes       → no badge — the hermes picker lists hermes skills only,
//                  so a per-row source label would be noise with no signal
//   hermes-local → 用户 — self-installed hermes skills, the one genuinely
//                  differentiating bit within the hermes list
export const SlashPicker = forwardRef<SlashPickerHandle, SlashPickerProps>(
  ({ query, skills, onSelect, onClose }, ref) => {
    const [activeIndex, setActiveIndex] = useState(0)
    const itemRefs = useRef<Array<HTMLDivElement | null>>([])

    const items: SkillItem[] = useMemo(
      () => buildSkillCandidates(skills, query),
      [skills, query],
    )

    useEffect(() => {
      setActiveIndex(0)
    }, [query])
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
          if (item) onSelect(item.name)
        },
      }),
      [items, activeIndex, onSelect],
    )

    return (
      <div className="UNagent-mention" role="listbox" aria-label="技能选择">
        <div className="UNagent-mention-head">
          <span className="UNagent-mention-title">
            <Icon name="zap" />
            技能{query.trim() ? <code>//{query}</code> : null}
          </span>
          <span className="UNagent-mention-hint">↑↓ 选择 · Enter 调用 · Esc 关闭</span>
          <button
            className="UNagent-mention-close"
            onClick={onClose}
            aria-label="关闭技能选择"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="UNagent-mention-list">
          {items.length === 0 && (
            <div className="UNagent-mention-empty">没有匹配的技能</div>
          )}

          {items.map((item, index) => (
            <div
              key={`${item.source}:${item.name}`}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              role="option"
              aria-selected={index === activeIndex}
              className={
                'UNagent-mention-item' +
                (index === activeIndex ? ' UNagent-mention-item--active' : '')
              }
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item.name)
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="UNagent-mention-icon">
                {item.emoji ?? <Icon name="puzzle" />}
              </span>
              <span className="UNagent-mention-text">
                <span className="UNagent-mention-name">
                  <Highlight text={item.name} query={query} />
                </span>
                {item.description ? (
                  <span className="UNagent-mention-sub">
                    {item.description}
                  </span>
                ) : null}
              </span>
              {item.source !== 'hermes' && (
                <span
                  className={
                    'UNagent-mention-badge UNagent-mention-badge--' +
                    (item.source === 'builtin' ? 'active' : 'tag')
                  }
                >
                  {item.source === 'builtin' ? '官方' : '用户'}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  },
)

SlashPicker.displayName = 'SlashPicker'
