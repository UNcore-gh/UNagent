/**
 * Jest setup: polyfill Obsidian's HTMLElement/SVGElement CSS helpers.
 *
 * Obsidian augments HTMLElement (and SVGElement) at runtime with
 * `setCssStyles()` / `setCssProps()`. jsdom does not provide these, so tests
 * that render components using them (e.g. Composer auto-resize) would throw.
 * Mirror the runtime behaviour here so component tests match production.
 */
function install(proto) {
  if (!proto || proto.setCssStyles) return
  proto.setCssStyles = function (styles) {
    Object.assign(this.style, styles)
  }
  proto.setCssProps = function (props) {
    Object.assign(this.style, props)
  }
}

if (typeof window !== 'undefined' && typeof window.HTMLElement !== 'undefined') {
  install(window.HTMLElement.prototype)
  if (typeof window.SVGElement !== 'undefined') {
    install(window.SVGElement.prototype)
  }
}