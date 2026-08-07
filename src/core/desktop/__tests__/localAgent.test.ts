// 本地 agent 子进程层（补刀·五十四）：argv 构造、版本解析、输出截断，
// 以及 runLocalAgent 的成功/失败/spawn 错误/超时/abort/截断路径——全部
// 经注入的 fake spawn 完成，绝不真起进程。child_process 被 mock 成无
// spawn——只为 spawnDetachedLocal 的「spawn 不可用」分支服务（getDesktopSpawn
// 内部懒加载 require，其它用例全部注入 spawnImpl，不受影响）。

// jest.mock 会 hoist 到文件顶部；getDesktopSpawn 的缓存只在未注入时触发。
jest.mock('child_process', () => ({ spawn: undefined }))

import { EventEmitter } from 'events'
import {
  MAX_OUTPUT_CHARS,
  buildHermesChatPrompt,
  commandFallbacks,
  parseHermesVersion,
  runLocalAgent,
  spawnDetachedLocal,
  truncateOutput,
  type LocalAgentChild,
  type SpawnLike,
} from '../localAgent'

interface FakeChildHandle {
  child: LocalAgentChild
  emitStdout(text: string): void
  emitStderr(text: string): void
  emitError(err: Error): void
  close(code: number | null): void
  kills: string[]
}

function makeFakeChild(autoCloseOnKill = false): FakeChildHandle {
  const proc = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const kills: string[] = []
  const child = proc as unknown as LocalAgentChild
  ;(child as unknown as { stdout: unknown }).stdout = stdout
  ;(child as unknown as { stderr: unknown }).stderr = stderr
  ;(child as { kill: (s?: NodeJS.Signals) => boolean }).kill = (s) => {
    kills.push(String(s))
    if (autoCloseOnKill) {
      // A real process dies shortly after the signal lands.
      setTimeout(() => proc.emit('close', null, s ?? 'SIGTERM'), 5)
    }
    return true
  }
  return {
    child,
    emitStdout: (t) => stdout.emit('data', Buffer.from(t, 'utf8')),
    emitStderr: (t) => stderr.emit('data', Buffer.from(t, 'utf8')),
    emitError: (e) => proc.emit('error', e),
    close: (code) => proc.emit('close', code, null),
    kills,
  }
}

describe('hermes contract helpers', () => {
  it('parseHermesVersion accepts the --version first line only', () => {
    expect(
      parseHermesVersion('Hermes Agent v0.19.1 (2026-07-01)\nInstall directory: /x'),
    ).toBe('Hermes Agent v0.19.1 (2026-07-01)')
    expect(parseHermesVersion('some other tool v1')).toBeNull()
    expect(parseHermesVersion('')).toBeNull()
  })

  it('truncateOutput caps with a marker and reports the cut', () => {
    expect(truncateOutput('short', 100)).toEqual({ text: 'short', truncated: false })
    const long = 'a'.repeat(150)
    const res = truncateOutput(long, 100)
    expect(res.truncated).toBe(true)
    expect(res.text.startsWith('a'.repeat(100))).toBe(true)
    expect(res.text).toContain('已截断')
  })

  it('commandFallbacks lists common install spots for bare commands only', () => {
    const home = process.env.HOME ?? ''
    const fb = commandFallbacks('hermes')
    expect(fb).toContain(`${home}/.local/bin/hermes`)
    expect(fb).toContain(`${home}/.hermes/hermes-agent/venv/bin/hermes`)
    expect(fb).toContain('/opt/homebrew/bin/hermes')
    expect(fb).toContain('/usr/local/bin/hermes')
    // Absolute/relative paths are left to the caller — no guessing.
    expect(commandFallbacks('/usr/local/bin/hermes')).toEqual([])
    expect(commandFallbacks('  ')).toEqual([])
  })

  it('buildHermesChatPrompt assembles persona + transcript + task', () => {
    const p = buildHermesChatPrompt({
      persona: '你是一位严谨的档案管理员。',
      transcript: '用户：你好\n\n助手：你好！',
      task: '整理标签',
    })
    expect(p).toContain('人格设定')
    expect(p).toContain('严谨的档案管理员')
    expect(p).toContain('对话实录')
    expect(p).toContain('用户：你好')
    expect(p).toContain('用户的最新输入：\n整理标签')
  })

  it('buildHermesChatPrompt omits empty sections (the /hermes aside shape)', () => {
    const p = buildHermesChatPrompt({ task: '只问一句' })
    expect(p).not.toContain('人格设定')
    expect(p).not.toContain('对话实录')
    expect(p).not.toContain('用户画像与长期记忆')
    expect(p).toContain('用户的最新输入：\n只问一句')
  })

  it('buildHermesChatPrompt injects the plugin memory snapshot between persona and transcript', () => {
    const p = buildHermesChatPrompt({
      persona: '档案管理员',
      memory: '【用户画像】\n- 偏好中文\n\n【长期记忆】\n- 库里有项目 A',
      transcript: '用户：你好',
      task: '继续',
    })
    expect(p).toContain('用户画像与长期记忆')
    expect(p).toContain('- 库里有项目 A')
    // 段落顺序：人设 → 记忆 → 实录 → 最新输入。
    expect(p.indexOf('人格设定')).toBeLessThan(p.indexOf('用户画像与长期记忆'))
    expect(p.indexOf('用户画像与长期记忆')).toBeLessThan(p.indexOf('对话实录'))
    expect(p.indexOf('对话实录')).toBeLessThan(p.indexOf('用户的最新输入'))
  })
})

describe('runLocalAgent', () => {
  const baseOpts = {
    command: 'hermes',
    args: ['-z', 'task'],
    cwd: '/vault',
    timeoutMs: 60000,
  }

  it('collects stdout and maps exit 0 to success', async () => {
    const fake = makeFakeChild()
    const spawnSpy = jest.fn(() => fake.child)
    const promise = runLocalAgent(baseOpts, spawnSpy as SpawnLike)
    fake.emitStdout('最终回答')
    fake.close(0)
    const res = await promise

    expect(spawnSpy).toHaveBeenCalledWith(
      'hermes',
      ['-z', 'task'],
      expect.objectContaining({
        cwd: '/vault',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    // GUI PATH 补全：spawn 的 env.PATH 前置常见 bin 目录。
    const spawnOpts = (
      spawnSpy.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ]
    )[2]
    expect(spawnOpts.env.PATH).toContain('/opt/homebrew/bin')
    expect(res.ok).toBe(true)
    expect(res.output).toBe('最终回答')
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.aborted).toBe(false)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('merges extra env vars over the desktop base env (COLUMNS 通道)', async () => {
    const fake = makeFakeChild()
    const spawnSpy = jest.fn(() => fake.child)
    const promise = runLocalAgent(
      { ...baseOpts, env: { COLUMNS: '300' } },
      spawnSpy as SpawnLike,
    )
    fake.close(0)
    await promise
    const spawnOpts = (
      spawnSpy.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ]
    )[2]
    expect(spawnOpts.env.COLUMNS).toBe('300')
    // 桌面基础 env（PATH 补全）不被覆盖。
    expect(spawnOpts.env.PATH).toContain('/opt/homebrew/bin')
  })

  it('maps non-zero exit to failure with the stderr tail', async () => {
    const fake = makeFakeChild()
    const promise = runLocalAgent(baseOpts, (() => fake.child) as SpawnLike)
    fake.emitStderr('hermes -z: agent failed: AuthError(no provider configured)')
    fake.close(1)
    const res = await promise

    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(1)
    expect(res.stderrTail).toContain('AuthError')
  })

  it('surfaces spawn-level errors (ENOENT) without a close event', async () => {
    const fake = makeFakeChild()
    const promise = runLocalAgent(baseOpts, (() => fake.child) as SpawnLike)
    fake.emitError(new Error('spawn hermes ENOENT'))
    const res = await promise

    expect(res.ok).toBe(false)
    expect(res.error).toContain('ENOENT')
    expect(res.exitCode).toBeNull()
  })

  it('kills the child and reports timedOut at the wall-clock cap', async () => {
    const fake = makeFakeChild(true) // dies shortly after the signal
    const res = await runLocalAgent(
      { ...baseOpts, timeoutMs: 30 },
      (() => fake.child) as SpawnLike,
    )

    expect(res.timedOut).toBe(true)
    expect(res.ok).toBe(false)
    expect(fake.kills[0]).toBe('SIGTERM')
  })

  it('honors a pre-aborted signal immediately', async () => {
    const fake = makeFakeChild(true)
    const controller = new AbortController()
    controller.abort()
    const res = await runLocalAgent(
      { ...baseOpts, signal: controller.signal },
      (() => fake.child) as SpawnLike,
    )

    expect(res.aborted).toBe(true)
    expect(res.ok).toBe(false)
    expect(fake.kills.length).toBeGreaterThan(0)
  })

  it('honors a mid-run abort', async () => {
    const fake = makeFakeChild(true)
    const controller = new AbortController()
    const promise = runLocalAgent(
      { ...baseOpts, signal: controller.signal },
      (() => fake.child) as SpawnLike,
    )
    fake.emitStdout('partial')
    controller.abort()
    const res = await promise

    expect(res.aborted).toBe(true)
    expect(res.ok).toBe(false)
  })

  it('caps oversized stdout and flags the truncation', async () => {
    const fake = makeFakeChild()
    const promise = runLocalAgent(baseOpts, (() => fake.child) as SpawnLike)
    fake.emitStdout('x'.repeat(MAX_OUTPUT_CHARS + 500))
    fake.close(0)
    const res = await promise

    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
    expect(res.output.length).toBeLessThan(MAX_OUTPUT_CHARS + 100)
  })

  it('falls back to the next candidate when the bare command ENOENTs (GUI PATH 坑)', async () => {
    const good = makeFakeChild()
    const spawnSpy = jest
      .fn()
      // 1st attempt: bare 'hermes' invisible to the GUI PATH → ENOENT.
      .mockImplementationOnce(() => {
        const f = makeFakeChild()
        setTimeout(() => f.emitError(new Error('spawn hermes ENOENT')), 1)
        return f.child
      })
      // 2nd attempt: the ~/.local/bin fallback launches and answers.
      .mockImplementationOnce(() => {
        setTimeout(() => {
          good.emitStdout('回答')
          good.close(0)
        }, 2)
        return good.child
      })

    const res = await runLocalAgent(
      { ...baseOpts, fallbackCommands: ['/home/u/.local/bin/hermes'] },
      spawnSpy as SpawnLike,
    )

    expect(spawnSpy).toHaveBeenCalledTimes(2)
    expect(spawnSpy.mock.calls[0][0]).toBe('hermes')
    expect(spawnSpy.mock.calls[1][0]).toBe('/home/u/.local/bin/hermes')
    expect(res.ok).toBe(true)
    expect(res.output).toBe('回答')
  })

  it('reports the last error when every candidate fails to launch', async () => {
    const mkEnoent = () => {
      const f = makeFakeChild()
      setTimeout(() => f.emitError(new Error('spawn hermes ENOENT')), 1)
      return f.child
    }
    const res = await runLocalAgent(
      { ...baseOpts, fallbackCommands: ['/a/hermes', '/b/hermes'] },
      (() => mkEnoent()) as SpawnLike,
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ENOENT')
  })

  it('does NOT fall back for non-launch failures (exit-level errors)', async () => {
    const fake = makeFakeChild()
    const spawnSpy = jest.fn(() => fake.child)
    const promise = runLocalAgent(
      { ...baseOpts, fallbackCommands: ['/a/hermes'] },
      spawnSpy as SpawnLike,
    )
    // exit 1 = hermes ran but the agent failed — retrying another binary is wrong.
    fake.emitStderr('hermes -z: agent failed: AuthError')
    fake.close(1)
    const res = await promise

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(1)
  })
})

describe('spawnDetachedLocal (fire-and-forget GUI launch)', () => {
  it('spawns with detached + stdio ignore + unref, returns true immediately', () => {
    const fake = makeFakeChild()
    // unref 是 Node ChildProcess 的可选成员——挂到 fake 上验证被调用。
    const unref = jest.fn()
    ;(fake.child as unknown as { unref?: () => void }).unref = unref
    const spawnSpy = jest.fn(
      (_cmd: string, _args: string[], _opts: Record<string, unknown>) => fake.child,
    )

    const ok = spawnDetachedLocal(
      'hermes',
      ['desktop', '--skip-build', '--cwd', '/vault'],
      { cwd: '/vault' },
      spawnSpy as SpawnLike,
    )

    expect(ok).toBe(true)
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawnSpy.mock.calls[0]
    expect(cmd).toBe('hermes')
    expect(args).toEqual(['desktop', '--skip-build', '--cwd', '/vault'])
    expect(opts).toMatchObject({ cwd: '/vault', detached: true, stdio: 'ignore' })
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('swallows async spawn errors (no listener → would throw otherwise)', () => {
    const fake = makeFakeChild()
    const spawnSpy = jest.fn(() => fake.child)
    const ok = spawnDetachedLocal('hermes', [], { cwd: '/' }, spawnSpy as SpawnLike)
    expect(ok).toBe(true)
    // 无监听器的 EventEmitter 收到 'error' 会抛——挂上了空监听即安全。
    expect(() => fake.emitError(new Error('spawn hermes ENOENT'))).not.toThrow()
  })

  it('returns false when spawn throws synchronously', () => {
    const spawnSpy = jest.fn(() => {
      throw new Error('boom')
    })
    expect(
      spawnDetachedLocal('hermes', [], { cwd: '/' }, spawnSpy as SpawnLike),
    ).toBe(false)
  })

  it('returns false when spawn is unavailable (mobile / no spawn)', () => {
    // 不注入 spawnImpl → 走 getDesktopSpawn()；child_process 已被 mock 成
    // 无 spawn → 返回 null → false。注入 null 测不到该分支（`??` 会
    // fallback 到真实 spawn）。
    expect(spawnDetachedLocal('hermes', [], { cwd: '/' })).toBe(false)
  })
})
