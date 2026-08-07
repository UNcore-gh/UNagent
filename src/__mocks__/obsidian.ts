// Minimal `obsidian` stub for jest. Only what tested modules touch at runtime
// (instanceof checks + normalizePath). tsc still type-checks src against the
// real obsidian.d.ts; this file only satisfies jest's module resolution.

export class TAbstractFile {
  path = ''
  name = ''
  parent: unknown = null
}

export class TFile extends TAbstractFile {
  basename = ''
  extension = 'md'
  stat = { ctime: 0, mtime: 0, size: 0 }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = []
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
}

export class Notice {
  constructor(_message?: string) {}
}

export class Modal {
  app: unknown
  contentEl: unknown = {}
  constructor(app: unknown) {
    this.app = app
  }
  open(): void {}
  close(): void {}
  onClose(): void {}
}

export class App {}

// Platform stub — a MUTABLE object so tests can flip isMobile to exercise
// desktop-only gating (补刀·五十四). Default = desktop.
export const Platform = {
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isMacOS: true,
  isWindows: false,
  isLinux: false,
  isSafari: false,
}

// FileSystemAdapter stub — the hermes ACP path checks
// `adapter instanceof FileSystemAdapter` + getBasePath() for the
// child-process cwd.
export class FileSystemAdapter {
  getBasePath(): string {
    return '/tmp/fake-vault'
  }
  getName(): string {
    return ''
  }
}

// no-op in jest (real implementation comes from the obsidian module)
export function setIcon(): void {}

// Native markdown rendering is an Obsidian-runtime concern — the stub just
// wraps the source in a <p> so DOM-level tests can assert on placeholders.
export class Component {
  load(): void {}
  unload(): void {}
  addChild<T>(child: T): T {
    return child
  }
}

export const MarkdownRenderer = {
  render(
    _app: unknown,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: Component,
  ): Promise<void> {
    el.innerHTML = `<p>${markdown}</p>`
    return Promise.resolve()
  },
}
