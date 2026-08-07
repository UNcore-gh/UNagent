// Persistent boot breadcrumbs (utils/bootLog): the mobile auto-disable
// diagnostics. Pins the contract: append-with-timestamp, 240-line cap,
// missing-file reads, and the synchronous unload marker round-trip.

import { App } from 'obsidian'
import {
  bootLog,
  lastUnloadMark,
  markUnload,
  readBootLog,
} from '../bootLog'

const LOG_PATH = '.obsidian/plugins/UNagent/boot-log.txt'

function mkApp(initial: Record<string, string> = {}): {
  app: App
  store: Record<string, string>
} {
  const store: Record<string, string> = { ...initial }
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: {
        read: async (p: string) => {
          if (!(p in store)) throw new Error(`missing: ${p}`)
          return store[p]
        },
        write: async (p: string, data: string) => {
          store[p] = data
        },
      },
    },
  } as unknown as App
  return { app, store }
}

describe('bootLog', () => {
  it('writes to <configDir>/plugins/<id>/boot-log.txt', async () => {
    const { app, store } = mkApp()
    await bootLog(app, 'onload:start')
    expect(store[LOG_PATH]).toBeDefined()
    expect(store[LOG_PATH]).toContain('\tonload:start\n')
  })

  it('appends phase lines in order with timestamps', async () => {
    const { app, store } = mkApp()
    await bootLog(app, 'onload:start')
    await bootLog(app, 'onload:complete')
    const lines = store[LOG_PATH].trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*\tonload:start$/)
    expect(lines[1]).toMatch(/\tonload:complete$/)
  })

  it('caps the log at the last 240 lines', async () => {
    const seed = Array.from({ length: 260 }, (_, i) => `t\told-${i}`).join('\n')
    const { app, store } = mkApp({ [LOG_PATH]: seed + '\n' })
    await bootLog(app, 'newest')
    const lines = store[LOG_PATH].trim().split('\n')
    expect(lines).toHaveLength(240)
    expect(lines[lines.length - 1]).toContain('\tnewest')
    expect(lines[0]).toContain('old-21') // oldest 21 dropped
  })

  it('never throws when the adapter rejects writes', async () => {
    const app = {
      vault: {
        configDir: '.obsidian',
        adapter: {
          read: async () => {
            throw new Error('boom')
          },
          write: async () => {
            throw new Error('boom')
          },
        },
      },
    } as unknown as App
    await expect(bootLog(app, 'x')).resolves.toBeUndefined()
    await expect(readBootLog(app)).resolves.toBe('')
  })
})

describe('readBootLog', () => {
  it("returns '' when the log file is missing", async () => {
    const { app } = mkApp()
    expect(await readBootLog(app)).toBe('')
  })

  it('returns the raw log content', async () => {
    const { app } = mkApp({ [LOG_PATH]: 'a\nb\n' })
    expect(await readBootLog(app)).toBe('a\nb\n')
  })
})

describe('unload marker', () => {
  // The jest node environment has no localStorage — shim an in-memory one.
  beforeAll(() => {
    if (!globalThis.localStorage) {
      const mem = new Map<string, string>()
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: (k: string) => mem.get(k) ?? null,
          setItem: (k: string, v: string) => {
            mem.set(k, String(v))
          },
          removeItem: (k: string) => {
            mem.delete(k)
          },
        },
        configurable: true,
      })
    }
  })

  it('round-trips a timestamp through localStorage', () => {
    globalThis.localStorage.removeItem('UNagent-unload-mark')
    expect(lastUnloadMark()).toBe('')
    markUnload()
    expect(lastUnloadMark()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
