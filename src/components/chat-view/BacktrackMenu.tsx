import type { TurnPoint } from './types'

interface BacktrackMenuProps {
  /** Viewport position of the button that opened it (fixed positioning). */
  x: number
  y: number
  /** The turns the user may rewind to (追加51: index > 0 only — rewinding
   *  before the very first turn has nowhere to go). */
  points: TurnPoint[]
  /** Rewind to before the chosen turn (its user-message index). */
  onPick(index: number): void
  /** Dismiss — tapping anywhere outside the menu. */
  onClose(): void
}

/**
 * The backtrack picker (追加51): a floating turn list replacing the old
 * "rewind to the nearest earlier turn" guess. Ten messages in, the user
 * picks WHICH turn to jump back to — every entry shows a preview of the
 * question, and rewinding cuts everything from that turn onward (the
 * /rewind contract), then the conversation continues from there.
 * 追加66: 去掉「第 N 轮」前缀（列表顺序即轮次，序号无意义）——预览文字
 * 成为唯一主体；/rewind 命令与回溯按钮共用此浮层，同一设计、不同入口。
 */
export const BacktrackMenu = ({
  x,
  y,
  points,
  onPick,
  onClose,
}: BacktrackMenuProps) => (
  <div className="UNagent-backtrack-scrim" onClick={onClose}>
    <div
      className="UNagent-backtrack-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      <div className="UNagent-backtrack-title">
        回溯到这一轮，移除之后的对话
      </div>
      {points.length === 0 ? (
        <div className="UNagent-backtrack-empty">只有一轮对话，没有可回溯的位置</div>
      ) : (
        points.map((p) => (
          <button
            key={p.index}
            className="UNagent-backtrack-item"
            onClick={() => onPick(p.index)}
            role="menuitem"
          >
            <span className="UNagent-backtrack-preview">{p.preview}</span>
          </button>
        ))
      )}
    </div>
  </div>
)
