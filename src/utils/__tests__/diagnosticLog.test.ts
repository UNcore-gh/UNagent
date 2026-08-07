// Opt-in diagnostic log (utils/diagnosticLog): pins the contract that the
// logger is a complete no-op while disabled, buffers + flushes when enabled,
// caps the on-disk file, and never throws from broken adapter I/O.

import { App } from 'obsidian'

type DiagModule = typeof import('../diagnosticLog')

interface FakeState {
  app: App
  store: Record<string, string>
  writes: string[]
}

/** Minimal adapter fake (config dir only — the log lives outside the vault
 *  note index, mirroring boot-log). */
function mkApp(initial: Record<string, string> = {}): FakeState {
  const store: Record<string, string> = { ...initial }
  const writes: string[] = []
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: {
        exists: async (p: string) => p in store,
        read: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p]
        },
        write: async (p: string, data: string) => {
          store[p] = data
          writes.push(p)
        },
        remove: async (p: string) => {
          delete store[p]
        },
      },
    },
  } as unknown as App
  return { app, store, writes }
}

const LOG_PATH = '.obsidian/plugins/UNagent/diag-log.txt'

describe('diagnosticLog', () => {
  let mod: DiagModule

  beforeEach(() => {
    // Module-level singleton state — re-import per test for isolation.
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../diagnosticLog') as DiagModule
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('formatLine (pure)', () => {
    it('renders level, scope and message with an injected timestamp', () => {
      expect(mod.formatLine('info', 'llm', 'ok', '2026-08-05T00:00:00.000Z')).toBe(
        '2026-08-05T00:00:00.000Z\tINFO\t[llm] ok',
      )
    })

    it('collapses whitespace and truncates long messages', () => {
      const line = mod.formatLine(
        'error',
        'tool',
        `  a\n\nb  ${'x'.repeat(1000)}`,
        'T',
      )
      // Cleaned body = "a b " (4 chars) + 1000 x's → sliced to 500 → 496 x's.
      expect(line).toBe(`T\tERROR\t[tool] a b ${'x'.repeat(496)}`)
      expect(line.length).toBeLessThanOrEqual('T\tERROR\t[tool] '.length + mod.DIAG_LINE_MAX)
    })
  })

  describe('trimLines (pure)', () => {
    it('keeps the most recent N lines', () => {
      expect(mod.trimLines(['a', 'b', 'c'], 2)).toEqual(['b', 'c'])
      expect(mod.trimLines(['a'], 5)).toEqual(['a'])
    })
  })

  describe('disabled = complete silence', () => {
    it('records nothing and writes nothing to disk', async () => {
      const { app, store } = mkApp()
      mod.setDiagnostics(app, false)
      mod.dlog('error', 'anywhere', 'this must never land')
      await jest.advanceTimersByTimeAsync(mod.DIAG_FLUSH_DELAY_MS * 2)
      await mod.flushDiagBuffer()
      expect(store).toEqual({})
      expect(mod.diagnosticsEnabled()).toBe(false)
    })

    it('is disabled by default (fresh install)', () => {
      expect(mod.diagnosticsEnabled()).toBe(false)
    })
  })

  describe('enabled recording', () => {
    it('flushes buffered lines to the on-disk log', async () => {
      const { app, store } = mkApp()
      mod.setDiagnostics(app, true)
      mod.dlog('info', 'chat', 'turn model=qwen-max provider=openai-compatible')
      await mod.flushDiagBuffer()
      const content = store[LOG_PATH]
      expect(content).toBeDefined()
      expect(content).toContain('[chat] turn model=qwen-max')
      expect(content.endsWith('\n')).toBe(true)
    })

    it('auto-flushes after the idle debounce', async () => {
      const { app, store } = mkApp()
      mod.setDiagnostics(app, true)
      mod.dlog('warn', 'llm', 'retry host=api.example.com')
      expect(store[LOG_PATH]).toBeUndefined()
      await jest.advanceTimersByTimeAsync(mod.DIAG_FLUSH_DELAY_MS)
      expect(store[LOG_PATH]).toContain('retry host=api.example.com')
    })

    it('appends to an existing on-disk log', async () => {
      const { app, store } = mkApp({ [LOG_PATH]: 'old-line\n' })
      mod.setDiagnostics(app, true)
      mod.dlog('info', 'lifecycle', 'onload complete')
      await mod.flushDiagBuffer()
      const lines = store[LOG_PATH].split('\n').filter(Boolean)
      expect(lines[0]).toBe('old-line')
      expect(lines[lines.length - 1]).toContain('onload complete')
    })

    it('caps the file at the most recent DIAG_FILE_MAX_LINES', async () => {
      const { app, store } = mkApp()
      mod.setDiagnostics(app, true)
      for (let i = 0; i < mod.DIAG_FILE_MAX_LINES + 20; i++) {
        mod.dlog('info', 't', `line-${i}`)
        if ((i + 1) % mod.DIAG_BUFFER_MAX === 0) await mod.flushDiagBuffer()
      }
      await mod.flushDiagBuffer()
      const lines = store[LOG_PATH].split('\n').filter(Boolean)
      expect(lines.length).toBe(mod.DIAG_FILE_MAX_LINES)
      expect(lines[lines.length - 1]).toContain(
        `line-${mod.DIAG_FILE_MAX_LINES + 19}`,
      )
      expect(lines[0]).not.toContain('line-0')
    })

    it('flushes the remainder when turned back off', async () => {
      const { app, store } = mkApp()
      mod.setDiagnostics(app, true)
      mod.dlog('info', 'x', 'last line before off')
      mod.setDiagnostics(app, false)
      await mod.flushDiagBuffer()
      expect(store[LOG_PATH]).toContain('last line before off')
      // And nothing more lands afterwards.
      mod.dlog('error', 'x', 'after off')
      await mod.flushDiagBuffer()
      expect(store[LOG_PATH]).not.toContain('after off')
    })
  })

  describe('resilience', () => {
    it('never throws when the adapter read fails', async () => {
      const { app } = mkApp()
      mod.setDiagnostics(app, true)
      mod.dlog('info', 'x', 'hello')
      await expect(mod.flushDiagBuffer()).resolves.toBeUndefined()
    })

    it('readDiagnosticLog returns empty string when the log is absent', async () => {
      const { app } = mkApp()
      expect(await mod.readDiagnosticLog(app)).toBe('')
    })

    it('clearDiagnosticLog deletes the file and is idempotent', async () => {
      const { app, store } = mkApp({ [LOG_PATH]: 'x\n' })
      await mod.clearDiagnosticLog(app)
      expect(store[LOG_PATH]).toBeUndefined()
      await expect(mod.clearDiagnosticLog(app)).resolves.toBeUndefined()
    })
  })
})
