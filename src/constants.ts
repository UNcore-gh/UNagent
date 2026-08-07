export const PLUGIN_ID = 'UNagent'
export const PLUGIN_NAME = 'UNagent'
export const VIEW_TYPE_CHAT = 'UNagent-chat'

// Custom ribbon/command icon, registered via addIcon() in main.ts so it always
// renders regardless of Obsidian's bundled icon set. The glyph is lucide
// "wand-2" (a magic wand with a sparkle) — reads as "AI assistant" at a glance
// and doesn't collide with the robot-head icons other AI plugins use
// (追加⑱ 补刀: the previous lucide "bot" was already taken elsewhere).
// IMPORTANT: the markup is a FULL <svg> element with its own viewBox="0 0 24 24".
// Obsidian's addIcon parses the element it is given; if only bare <path> markup
// is passed, the icon silently falls back to a 100×100 viewBox and the 24×24
// drawing collapses into the top-left corner of its frame (the bug we shipped
// before — the `size` third argument alone did not fix it on real devices).
// Embedding the viewBox is the version-proof fix; main.ts still forwards
// size=24 as belt-and-suspenders for builds honoring that argument.
export const ICON_NAME = 'ai-assistant-wand'
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>`
