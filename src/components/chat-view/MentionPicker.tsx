import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import { usePlugin } from '../../contexts/plugin-context'
import { aiFolderExclusion, effectiveExclusions } from '../../utils/exclusions'
import { Icon } from '../Icon'
import {
  buildCandidates,
  buildFileCandidates,
  MentionCandidate,
  MentionKind,
  MentionLevel,
} from './mention'

export interface MentionPickerHandle {
  /** Move keyboard highlight by delta (wraps). */
  move(delta: number): void
  /** Enter: confirm the multi-select, or insert the highlighted one if none. */
  selectActive(): void
  /** Space / tap: toggle the highlighted candidate in the selection, keep open. */
  addActive(): void
}

interface MentionPickerProps {
  /** '@' level: 1 notes, 2 folders, 3 tags — decides the candidate kind. */
  level: MentionLevel
  query: string
  onSelect: (insert: string) => void
  /** Multi-select confirm: all chosen references at once. */
  onMultiSelect: (inserts: string[]) => void
  onClose: () => void
  /**
   * Paperclip attach mode: lists EVERY vault file type (images / pdfs / any
   * attachment) with its own search box — the query is typed into the picker
   * itself, not the composer textarea.
   */
  fileMode?: boolean
}

const KIND_ICON: Record<MentionKind, string> = {
  note: 'file',
  folder: 'folder',
  tag: 'tag',
  file: 'file',
}

/** Chinese short names for the multi-select summary ("笔记×3 · 文件夹×2"). */
const KIND_NAME: Record<MentionKind, string> = {
  note: '笔记',
  folder: '文件夹',
  tag: '标签',
  file: '笔记',
}

/** Icons that may be absent from an Obsidian build's bundled subset. */
const ICON_FALLBACK: Partial<Record<string, string>> = {
  image: 'file',
}

const LEVEL_HEAD: Record<MentionLevel, { label: string; kind: MentionKind }> = {
  1: { label: '引用 · 笔记', kind: 'note' },
  2: { label: '引用 · 文件夹', kind: 'folder' },
  3: { label: '引用 · 标签', kind: 'tag' },
}

const EMPTY_TEXT: Record<MentionLevel, string> = {
  1: '没有匹配的笔记',
  2: '没有匹配的文件夹',
  3: '没有匹配的标签',
}

const FILE_HEAD_LABEL = '添加 · 库文件'
const FILE_EMPTY_TEXT = '没有匹配的文件'
const FILE_SEARCH_PLACEHOLDER = '搜索库里的文件 / 图片…'

/** Bold the first occurrence of the query inside a label. */
export const Highlight = ({ text, query }: { text: string; query: string }) => {
  const q = query.trim()
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

interface Row {
  candidate: MentionCandidate
  pinned: boolean
}

// Bottom-sheet style popup anchored above the composer. The '@' run length
// (level) fixes the candidate kind — one single-type ranked list, so no type
// badges except "当前" for the pinned active note (level 1 only). Keyboard-
// driven from the textarea via the imperative handle; tap/click on touch.
//
// fileMode (paperclip): driven by an internal search input instead of the
// textarea, and lists all file types — used to attach images / files.
export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(
  ({ level, query, onSelect, onMultiSelect, onClose, fileMode = false }, ref) => {
    const plugin = usePlugin()
    const [activeIndex, setActiveIndex] = useState(0)
    const [search, setSearch] = useState('')
    const [selected, setSelected] = useState<MentionCandidate[]>([])
    const itemRefs = useRef<Array<HTMLDivElement | null>>([])

    // fileMode reuses the attach UI (self-owned search box + tap-to-insert).
    const isAttach = fileMode
    const effQuery = isAttach ? search : query
    const headLabel = fileMode
      ? FILE_HEAD_LABEL
      : LEVEL_HEAD[level].label
    const emptyText = fileMode
      ? FILE_EMPTY_TEXT
      : EMPTY_TEXT[level]

    const rows: Row[] = useMemo(() => {
      const exclusions = effectiveExclusions(
        plugin.app,
        plugin.settings.general.excludedFolders,
        aiFolderExclusion(
          plugin.settings.general.hideAiFolder,
          plugin.settings.general.aiFolder,
        ),
      )
      if (fileMode) {
        return buildFileCandidates(plugin.app, effQuery, exclusions).map((c) => ({
          candidate: c,
          pinned: false,
        }))
      }
      const { active, results } = buildCandidates(plugin.app, effQuery, level, exclusions)
      const list: Row[] = results.map((c) => ({ candidate: c, pinned: false }))
      if (active) list.unshift({ candidate: active, pinned: true })
      return list
    }, [plugin, effQuery, level, fileMode])

    // Reset highlight when the query/level changes; clamp as lists shrink.
    useEffect(() => {
      setActiveIndex(0)
    }, [effQuery, level, fileMode])
    useEffect(() => {
      if (activeIndex >= rows.length && rows.length > 0) {
        setActiveIndex(rows.length - 1)
      }
    }, [rows.length, activeIndex])
    useEffect(() => {
      itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex])

    useImperativeHandle(
      ref,
      () => ({
        move(delta: number) {
          if (rows.length === 0) return
          setActiveIndex((i) => (i + delta + rows.length) % rows.length)
        },
        selectActive() {
          if (selected.length > 0) {
            onMultiSelect(selected.map((c) => c.insert))
            return
          }
          const row = rows[activeIndex] ?? rows[0]
          if (row) onSelect(row.candidate.insert)
        },
        addActive() {
          const row = rows[activeIndex] ?? rows[0]
          if (!row) return
          // 追加㉟：空格可取消选择（toggle），不再只能加。
          setSelected((prev) =>
            prev.some((c) => c.id === row.candidate.id)
              ? prev.filter((c) => c.id !== row.candidate.id)
              : [...prev, row.candidate],
          )
          setActiveIndex((i) => (i + 1 + rows.length) % rows.length)
        },
      }),
      [rows, activeIndex, selected, onSelect, onMultiSelect],
    )

    // "文件×3 · 文件夹×2" — the running multi-select summary.
    const selectedSummary = useMemo(() => {
      const counts: Partial<Record<MentionKind, number>> = {}
      for (const c of selected) counts[c.kind] = (counts[c.kind] ?? 0) + 1
      return Object.entries(counts)
        .map(([kind, n]) => `${KIND_NAME[kind as MentionKind]}×${n}`)
        .join(' · ')
    }, [selected])

    return (
      <div className="UNagent-mention" role="listbox" aria-label={headLabel}>
        <div className="UNagent-mention-head">
          {isAttach ? (
            <>
              <span className="UNagent-mention-title">
                <Icon name="paperclip" fallback="plus" />
                {headLabel}
              </span>
              <span className="UNagent-mention-hint">
                ↑↓ 选择 · Enter 插入 · Esc 关闭
              </span>
            </>
          ) : (
            // 追加㉟：列表头只留一句操作提示——「引用·笔记」字样、
            // 「@查询词」代码块、键盘教程全部移除。
            <span className="UNagent-mention-guide">空格或点击可以多选</span>
          )}
          {!isAttach && selected.length > 0 && (
            // 追加㊳（用户指示）：确认按钮与数量徽章并排又太大又别扭——
            // 合成一个元素：数量徽章本身就是确认钮，点它即提交多选。
            <button
              className="UNagent-mention-summary"
              title="确认插入这些引用"
              onClick={() => onMultiSelect(selected.map((c) => c.insert))}
            >
              ✓ {selectedSummary}
            </button>
          )}
          <button
            className="UNagent-mention-close"
            onClick={onClose}
            aria-label="关闭引用选择"
          >
            <Icon name="x" />
          </button>
        </div>

        {isAttach && (
          <div className="UNagent-mention-searchrow">
            <input
              className="UNagent-mention-search"
              type="search"
              placeholder={FILE_SEARCH_PLACEHOLDER}
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Own the arrow/enter keys so the textarea handler stays out.
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  e.stopPropagation()
                  if (rows.length) setActiveIndex((i) => (i + 1) % rows.length)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  e.stopPropagation()
                  if (rows.length)
                    setActiveIndex((i) => (i - 1 + rows.length) % rows.length)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  e.stopPropagation()
                  const row = rows[activeIndex] ?? rows[0]
                  if (row) onSelect(row.candidate.insert)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  onClose()
                }
              }}
            />
          </div>
        )}

        <div className="UNagent-mention-list">
          {rows.length === 0 && (
            <div className="UNagent-mention-empty">{emptyText}</div>
          )}

          {rows.map((row, index) => {
            const item = row.candidate
            const icon = item.icon ?? KIND_ICON[item.kind]
            const isSelected = selected.some((c) => c.id === item.id)
            return (
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
                  (isSelected ? ' is-selected' : '')
                }
                // mousedown (not click) so the textarea keeps focus on
                // desktop; touch taps synthesize mousedown too. A tap
                // TOGGLES the multi-select (追加㉟)；空格/回车 确认提交。
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (isAttach) {
                    onSelect(item.insert)
                    return
                  }
                  setSelected((prev) =>
                    prev.some((c) => c.id === item.id)
                      ? prev.filter((c) => c.id !== item.id)
                      : [...prev, item],
                  )
                  setActiveIndex(index)
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="UNagent-mention-icon">
                  <Icon
                    name={row.pinned ? 'pin' : isSelected ? 'check' : icon}
                    fallback={ICON_FALLBACK[icon]}
                  />
                </span>
                <span className="UNagent-mention-text">
                  <span className="UNagent-mention-name">
                    <Highlight text={item.title} query={effQuery} />
                  </span>
                  {item.subtitle && (
                    <span className="UNagent-mention-sub">{item.subtitle}</span>
                  )}
                </span>
                {row.pinned && (
                  <span className="UNagent-mention-badge UNagent-mention-badge--active">
                    当前
                  </span>
                )}
                {isSelected && (
                  <span className="UNagent-mention-badge UNagent-mention-badge--selected">
                    已选
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  },
)

MentionPicker.displayName = 'MentionPicker'
