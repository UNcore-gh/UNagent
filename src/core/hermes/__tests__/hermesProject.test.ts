// 显式项目层同步（方案 B）：`hermes project list` 解析、幂等 ensure
// （已存在跳过 / 缺失 create / 失败落 ok:false）、自动路径去重与失败重试
// ——全部经注入的 fake spawn 完成，绝不真起进程。

import { EventEmitter } from 'events'

import {
  ensureHermesProject,
  ensureHermesProjectOnce,
  parseProjectList,
  projectNameFromRoot,
  resetHermesProjectCache,
} from '../hermesProject'
import type { LocalAgentChild, SpawnLike } from '../../desktop/localAgent'

interface FakeChildHandle {
  child: LocalAgentChild
  emitStdout(text: string): void
  emitStderr(text: string): void
  close(code: number | null): void
}

function makeFakeChild(): FakeChildHandle {
  const proc = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = proc as unknown as LocalAgentChild
  ;(child as unknown as { stdout: unknown }).stdout = stdout
  ;(child as unknown as { stderr: unknown }).stderr = stderr
  ;(child as { kill: (s?: NodeJS.Signals) => boolean }).kill = () => true
  return {
    child,
    emitStdout: (t) => stdout.emit('data', Buffer.from(t, 'utf8')),
    emitStderr: (t) => stderr.emit('data', Buffer.from(t, 'utf8')),
    close: (code) => proc.emit('close', code, null),
  }
}

/** 按脚本回复每个 spawn 调用：fn(index) → { stdout, stderr?, exit }。 */
function scriptedSpawn(
  fn: (index: number, args: string[]) => {
    stdout?: string
    stderr?: string
    exit: number
  },
): { spawnSpy: jest.Mock; calls: { args: string[]; index: number }[] } {
  const calls: { args: string[]; index: number }[] = []
  let index = 0
  const spawnSpy = jest.fn((_cmd: string, args: string[]) => {
    const script = fn(index, args)
    const fake = makeFakeChild()
    // runLocalAgent 在 spawn 返回后才注册 stdout/close 监听——发射必须
    // 延后到微任务，否则事件在监听注册前丢失、promise 永不 settle。
    queueMicrotask(() => {
      if (script.stdout) fake.emitStdout(script.stdout)
      if (script.stderr) fake.emitStderr(script.stderr)
      fake.close(script.exit)
    })
    calls.push({ args, index })
    index += 1
    return fake.child
  }) as jest.Mock
  return { spawnSpy, calls }
}

const LIST_OUTPUT = [
  '* main                     main  [4 folder(s)]',
  '  my-project               Hermes Agent  [2 folder(s)]',
].join('\n')

/** 含目标项目（梦幻岛）的列表输出——「已存在」分支的 fixture。 */
const LIST_WITH_TARGET = [
  '* main                     main  [4 folder(s)]',
  '  obsidian-x               梦幻岛  [1 folder(s)]',
].join('\n')

describe('parseProjectList', () => {
  it('parses slug (no spaces) and name (may contain spaces), ignoring the active marker', () => {
    expect(parseProjectList(LIST_OUTPUT)).toEqual([
      { slug: 'main', name: 'main' },
      { slug: 'my-project', name: 'Hermes Agent' },
    ])
  })

  it('handles CJK names and the empty/onboarding output', () => {
    expect(
      parseProjectList('  obsidian-x               梦幻岛  [1 folder(s)]\n'),
    ).toEqual([{ slug: 'obsidian-x', name: '梦幻岛' }])
    expect(parseProjectList('No projects yet. Create one with `hermes project create <name>`.'))
      .toEqual([])
    expect(parseProjectList('')).toEqual([])
  })

  it('skips unrelated lines', () => {
    expect(parseProjectList('usage: hermes project list\n')).toEqual([])
  })
})

describe('projectNameFromRoot', () => {
  it('takes the basename with both separators', () => {
    expect(projectNameFromRoot('/Users/zh/obsidian/梦幻岛')).toBe('梦幻岛')
    expect(projectNameFromRoot('C:\\Users\\zh\\vault')).toBe('vault')
  })
})

describe('ensureHermesProject', () => {
  const base = { command: 'hermes', vaultRoot: '/Users/zh/obsidian/梦幻岛' }

  it('skips create when a project with the vault name already exists', async () => {
    const { spawnSpy, calls } = scriptedSpawn(() => ({
      stdout: LIST_WITH_TARGET,
      exit: 0,
    }))
    const res = await ensureHermesProject(base, spawnSpy as SpawnLike)
    expect(res).toEqual({ ok: true, created: false, projectName: '梦幻岛' })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['project', 'list'])
  })

  it('creates the project when missing (name = vault basename, vaultRoot as primary folder)', async () => {
    const { spawnSpy, calls } = scriptedSpawn((i, args) =>
      i === 0
        ? { stdout: '  main  main  [1 folder(s)]\n', exit: 0 }
        : args[1] === 'create'
          ? { stdout: 'Created project 梦幻岛 (p_abc)\n', exit: 0 }
          : { exit: 1, stderr: 'unexpected' },
    )
    const res = await ensureHermesProject(base, spawnSpy as SpawnLike)
    expect(res).toEqual({ ok: true, created: true, projectName: '梦幻岛' })
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual([
      'project',
      'create',
      '梦幻岛',
      '/Users/zh/obsidian/梦幻岛',
    ])
  })

  it('creates on the empty-project output', async () => {
    const { spawnSpy, calls } = scriptedSpawn((i) =>
      i === 0
        ? { stdout: 'No projects yet. Create one with `hermes project create <name>`.\n', exit: 0 }
        : { stdout: 'Created project 梦幻岛 (p_abc)\n', exit: 0 },
    )
    const res = await ensureHermesProject(base, spawnSpy as SpawnLike)
    expect(res.created).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('fails gracefully when `project list` exits non-zero (never rejects)', async () => {
    const { spawnSpy } = scriptedSpawn(() => ({
      stderr: 'project: db locked\n',
      exit: 1,
    }))
    const res = await ensureHermesProject(base, spawnSpy as SpawnLike)
    expect(res.ok).toBe(false)
    expect(res.created).toBe(false)
    expect(res.error).toContain('list 失败')
    expect(res.error).toContain('db locked')
  })

  it('fails gracefully when `project create` exits non-zero', async () => {
    const { spawnSpy } = scriptedSpawn((i) =>
      i === 0
        ? { stdout: '  main  main  [1 folder(s)]\n', exit: 0 }
        : { stderr: 'project: slug conflict\n', exit: 1 },
    )
    const res = await ensureHermesProject(base, spawnSpy as SpawnLike)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('create 失败')
    expect(res.error).toContain('slug conflict')
  })
})

describe('ensureHermesProjectOnce', () => {
  afterEach(() => resetHermesProjectCache())

  it('deduplicates concurrent calls for the same vault (single spawn)', async () => {
    const { spawnSpy, calls } = scriptedSpawn(() => ({
      stdout: '  x  a  [1 folder(s)]\n',
      exit: 0,
    }))
    const [a, b] = await Promise.all([
      ensureHermesProjectOnce(
        { command: 'hermes', vaultRoot: '/vault/a' },
        spawnSpy as SpawnLike,
      ),
      ensureHermesProjectOnce(
        { command: 'hermes', vaultRoot: '/vault/a' },
        spawnSpy as SpawnLike,
      ),
    ])
    expect(a).toEqual({ ok: true, created: false, projectName: 'a' })
    expect(b).toEqual(a)
    expect(calls).toHaveLength(1)
  })

  it('re-runs after a failure (failed sync is not cached)', async () => {
    let fail = true
    const { spawnSpy, calls } = scriptedSpawn(() =>
      fail
        ? { stderr: 'boom', exit: 1 }
        : { stdout: '  x  a  [1 folder(s)]\n', exit: 0 },
    )
    const first = await ensureHermesProjectOnce(
      { command: 'hermes', vaultRoot: '/vault/a' },
      spawnSpy as SpawnLike,
    )
    expect(first.ok).toBe(false)
    fail = false
    const second = await ensureHermesProjectOnce(
      { command: 'hermes', vaultRoot: '/vault/a' },
      spawnSpy as SpawnLike,
    )
    expect(second.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('resetHermesProjectCache forces a fresh sync', async () => {
    const { spawnSpy, calls } = scriptedSpawn(() => ({
      stdout: '  x  a  [1 folder(s)]\n',
      exit: 0,
    }))
    await ensureHermesProjectOnce(
      { command: 'hermes', vaultRoot: '/vault/a' },
      spawnSpy as SpawnLike,
    )
    resetHermesProjectCache()
    await ensureHermesProjectOnce(
      { command: 'hermes', vaultRoot: '/vault/a' },
      spawnSpy as SpawnLike,
    )
    expect(calls).toHaveLength(2)
  })
})
