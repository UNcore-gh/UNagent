import React from 'react'

/**
 * A React error boundary that catches rendering errors in a sub-tree. When a
 * crash happens (user ran into "大量内容时整个界面消失", 补刀·五十二),
 * it shows a muted fallback message instead of silently unmounting the entire
 * React root — one broken block never takes the whole chat with it.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; kind?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[UNagent] Rendering crashed in sub-tree${this.props.kind ? ` (${this.props.kind})` : ''}: %s`,
      error.message,
      info.componentStack?.slice(0, 300),
    )
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: '8px 12px',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-ui-smaller)',
          }}
        >
          渲染出错，已降级。
        </div>
      )
    }
    return this.props.children
  }
}
