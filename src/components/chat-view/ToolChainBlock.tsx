import { useState } from 'react'

import { Icon } from '../Icon'
import type { UiBlock } from './types'

export type ToolBlock = Extract<UiBlock, { kind: 'tool' }>

/** Full args listing for the expanded detail ("key = value", one per line). */
function argsFull(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  return Object.entries(args)
    .map(([key, value]) => {
      const raw = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key} = ${raw ?? String(value)}`
    })
    .join('\n')
}

/** The step's title line ("类似标题的内容", 追加⑱ 补刀): the concise summary
 *  the tool produced, or a status phrase while running / on failure. */
function stepTitle(block: ToolBlock): string {
  const name = block.name
  switch (block.state) {
    case 'running':
      if (name === 'generate_image') return '正在生成图片…'
      if (name === 'web_search') return '正在联网搜索…'
      return `正在调用 ${name}…`
    case 'retrying':
      return (block.summary || `${name} 失败，正在重试…`).trim()
    case 'error':
      return (block.summary || `${name} 调用失败`).trim()
    default:
      return (block.summary || name).trim()
  }
}

/** Source links of a server-side web_search step (Responses API built-in
 *  tool): the runner packs them into `output.sources`. */
function webSearchSources(block: ToolBlock): Array<{ url: string; title?: string }> {
  const out = (block.output as { sources?: unknown } | undefined)?.sources
  if (!Array.isArray(out)) return []
  return out.filter(
    (s): s is { url: string; title?: string } =>
      !!s && typeof (s as { url?: unknown }).url === 'string',
  )
}

/** Hostname for a compact source label (falls back to the raw url). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// A run of consecutive tool calls as ONE thought chain. The steps are ALWAYS
// shown (追加⑱ 补刀: no auto-collapse) — each is a dot-on-connector row with
// a title; the verbose args / image output stay collapsed until that title
// is clicked. Dot colors carry the state: running = green pulse, done =
// green, error = red, retrying (a failed call the model immediately fires
// again) = red pulse.
export const ToolChainBlock = ({ blocks }: { blocks: ToolBlock[] }) => {
  const running = blocks.filter(
    (b) => b.state === 'running' || b.state === 'retrying',
  )
  const anyRunning = running.length > 0
  const anyError = blocks.some(
    (b) => b.state === 'error' || b.state === 'retrying',
  )
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (callId: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(callId)) next.delete(callId)
      else next.add(callId)
      return next
    })

  const status = anyRunning
    ? running.every((b) => b.name === 'web_search')
      ? '联网搜索中…'
      : '思考中…'
    : anyError
      ? '完成（有失败）'
      : '完成'

  return (
    <div className="UNagent-chain">
      <div className="UNagent-chain-head">
        <span
          className={`UNagent-chain-head-icon${
            anyRunning ? ' UNagent-chain-head-icon--running' : ''
          }`}
        >
          <Icon name={anyError && !anyRunning ? 'alert-triangle' : 'zap'} />
        </span>
        <span className="UNagent-chain-head-title">思考链路</span>
        <span className="UNagent-chain-head-meta">
          {blocks.length} 步 · {status}
        </span>
      </div>
      <div className="UNagent-chain-steps">
        {blocks.map((block, index) => (
          <ChainStep
            key={block.callId}
            block={block}
            open={open.has(block.callId)}
            onToggle={() => toggle(block.callId)}
            isLast={index === blocks.length - 1}
          />
        ))}
      </div>
    </div>
  )
}

const ChainStep = ({
  block,
  open,
  onToggle,
  isLast,
}: {
  block: ToolBlock
  open: boolean
  onToggle: () => void
  /** No connector after the final node. */
  isLast: boolean
}) => {
  const argsText = argsFull(block.args)
  const sources = block.name === 'web_search' ? webSearchSources(block) : []
  return (
    <div
      className={`UNagent-chain-step UNagent-chain-step--${block.state}`}
    >
      {/* A real element, not a pseudo — the connector must always render
          (追加⑱ 补刀). Positioned below this node, reaching toward the next. */}
      {!isLast && (
        <span className="UNagent-chain-connector" aria-hidden="true" />
      )}
      {/* Node + title share one row, centered — the dot sits exactly on the
          title line even when the detail below grows the step. */}
      <div className="UNagent-chain-step-row">
        <span className="UNagent-chain-node" aria-hidden="true" />
        <button
          className="UNagent-chain-step-title"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? '收起详情' : '查看详情'}
        >
          <span className="UNagent-chain-step-title-text">
            {stepTitle(block)}
          </span>
          <span
            className={`UNagent-chain-chevron${
              open ? ' UNagent-chain-chevron--open' : ''
            }`}
          >
            <Icon name="chevron-down" />
          </span>
        </button>
      </div>
      {/* Thinking preview — always visible when present, independent of the
          args detail toggle. Semi-collapsed by default (2-line clamp); click
          the header to expand the full reasoning text. */}
      {block.thinking && <ThinkingSection text={block.thinking} />}
      {open && (
        <div className="UNagent-chain-step-detail">
          <div className="UNagent-chain-step-row">
            <span className="UNagent-chain-step-key">工具</span>
            <code className="UNagent-chain-step-value">
              {block.name}
            </code>
          </div>
          {argsText && (
            <div className="UNagent-chain-step-row">
              <span className="UNagent-chain-step-key">参数</span>
              <span className="UNagent-chain-step-value UNagent-chain-step-value--wrap">
                {argsText}
              </span>
            </div>
          )}
          {block.summary && (
            <div className="UNagent-chain-step-row">
              <span className="UNagent-chain-step-key">结果</span>
              <span className="UNagent-chain-step-value UNagent-chain-step-value--wrap">
                {block.summary}
              </span>
            </div>
          )}
          {/* 联网搜索来源：服务端 web_search 内置工具返回的链接列表，
              点击在系统浏览器打开（Obsidian 拦截外链统一处理）。 */}
          {sources.length > 0 && (
            <div className="UNagent-chain-step-row">
              <span className="UNagent-chain-step-key">来源</span>
              <div className="UNagent-chain-sources">
                {sources.map((s, i) => (
                  <a
                    key={`${s.url}-${i}`}
                    className="UNagent-chain-source"
                    href={s.url}
                    title={s.url}
                  >
                    <span className="UNagent-chain-source-index">
                      {i + 1}
                    </span>
                    <span className="UNagent-chain-source-title">
                      {s.title || hostOf(s.url)}
                    </span>
                    <span className="UNagent-chain-source-host">
                      {hostOf(s.url)}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {block.state === 'running' && (
            <div className="UNagent-chain-step-status">
              {block.name === 'generate_image'
                ? '正在生成图片（约 5–30 秒）…'
                : '正在执行…'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Collapsible reasoning preview shown inside a tool node when the model
 *  produced extended-thinking / reasoning_content before this call.
 *  Default: semi-collapsed (2-line clamp via CSS). Click the header to
 *  expand the full text; click again to collapse. Independent of the
 *  step's args detail toggle — always visible when thinking exists. */
const ThinkingSection = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="UNagent-chain-thinking">
      <button
        className="UNagent-chain-thinking-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? '收起思考' : '展开思考'}
      >
        <span className="UNagent-chain-thinking-icon">
          <Icon name="brain" fallback="zap" />
        </span>
        <span className="UNagent-chain-thinking-label">思考</span>
        <span
          className={`UNagent-chain-chevron${
            expanded ? ' UNagent-chain-chevron--open' : ''
          }`}
        >
          <Icon name="chevron-down" />
        </span>
      </button>
      <div
        className={`UNagent-chain-thinking-body${
          expanded ? ' UNagent-chain-thinking-body--expanded' : ''
        }`}
      >
        {text}
      </div>
    </div>
  )
}
