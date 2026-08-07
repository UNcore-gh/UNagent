/**
 * Shim for import.meta.url compatibility in a CommonJS bundle.
 *
 * Some ESM dependencies (e.g. react-markdown in Phase 1) reference
 * import.meta.url, which is unavailable in Obsidian's CJS renderer context.
 * esbuild's `define` rewrites `import.meta.url` to `import_meta_url`,
 * which is provided by this injected module.
 */

const import_meta_url =
  typeof document === 'undefined'
    ? require('url').pathToFileURL(__filename).href
    : (document.currentScript && document.currentScript.src) ||
      new URL('main.js', document.baseURI).href

export { import_meta_url }
