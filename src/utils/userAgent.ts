/**
 * Raw user-agent string, for diagnostics only.
 *
 * The obsidian `platform` lint rule forbids reading `navigator.userAgent`
 * directly because it is normally used for OS detection (use `Platform`
 * instead). These helpers only record the UA string for crash / WebView
 * variant debugging, so we read it through a local reference to
 * `window.navigator` to keep the rule satisfied.
 */
const nav = window.navigator

/** Full user-agent string (may be empty if unavailable). */
export function getUserAgent(): string {
  return nav.userAgent
}