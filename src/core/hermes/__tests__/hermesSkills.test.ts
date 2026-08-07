// Hermes 侧技能清单（补刀·五十七）：「//」选择器数据面——
// `hermes skills list` Rich 表格解析（表头/框线/长名/空输出）+ 拉取
// （--enabled-only、COLUMNS=300 防截断、cwd 透传、失败落 ok:false）。
// 全部经注入的 fake spawn 完成，绝不真起进程。

import { EventEmitter } from 'events'

import { listHermesSkills, parseHermesSkillsTable } from '../hermesSkills'
import type { LocalAgentChild, SpawnLike } from '../../desktop/localAgent'

// spawn 不可用分支：getDesktopSpawn() 依赖 child_process.spawn，mock 成
// undefined 后返回 null → runLocalAgent 直接落 spawn_unavailable（注入
// fake 的用例不受影响——注入优先于 getDesktopSpawn）。
jest.mock('child_process', () => ({ spawn: undefined }))

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

interface SpawnCall {
  args: string[]
  options?: Record<string, unknown>
  index: number
}

/** 按脚本回复每个 spawn 调用，并捕获 args 与 options（env 断言用）。 */
function scriptedSpawn(
  fn: (index: number, args: string[]) => {
    stdout?: string
    stderr?: string
    exit: number
  },
): { spawnSpy: jest.Mock; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  let index = 0
  const spawnSpy = jest.fn(
    (
      _cmd: string,
      args: string[],
      options: Record<string, unknown> | undefined,
    ) => {
      const script = fn(index, args)
      const fake = makeFakeChild()
      // runLocalAgent 在 spawn 返回后才注册 stdout/close 监听——发射必须
      // 延后到微任务，否则事件在监听注册前丢失、promise 永不 settle。
      queueMicrotask(() => {
        if (script.stdout) fake.emitStdout(script.stdout)
        if (script.stderr) fake.emitStderr(script.stderr)
        fake.close(script.exit)
      })
      calls.push({ args, options, index })
      index += 1
      return fake.child
    },
  )
  return { spawnSpy, calls }
}

/** 真实输出形态（COLUMNS=300 下长名字完整不截断）。 */
const SKILLS_TABLE = [
  '                                Installed Skills                                ',
  '┏━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━┳━━━━━━━━┳━━━━━━━━━┓',
  '┃ Name                    ┃ Category             ┃ Source ┃ Trust  ┃ Status  ┃',
  '┡━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━╇━━━━━━━━╇━━━━━━━━━┩',
  '│ hermes-desktop-plugins  │                      │ local  │ local  │ enabled │',
  '│ obsidian-markdown       │                      │ local  │ local  │ enabled │',
  '│ py-homework-solver      │ software-development │ local  │ local  │ enabled │',
  '│ yuanbao                 │                      │ official│ official│ enabled │',
  '└─────────────────────────┴──────────────────────┴────────┴────────┴─────────┘',
].join('\n')

describe('parseHermesSkillsTable', () => {
  it('parses Name/Category/Source columns, skipping header and box lines', () => {
    expect(parseHermesSkillsTable(SKILLS_TABLE)).toEqual([
      { name: 'hermes-desktop-plugins', category: '', source: 'local' },
      { name: 'obsidian-markdown', category: '', source: 'local' },
      {
        name: 'py-homework-solver',
        category: 'software-development',
        source: 'local',
      },
      { name: 'yuanbao', category: '', source: 'official' },
    ])
  })

  it('returns [] for empty, header-only, or non-table output', () => {
    expect(parseHermesSkillsTable('')).toEqual([])
    expect(
      parseHermesSkillsTable(
        '┃ Name ┃ Category ┃ Source ┃ Trust ┃ Status ┃\n',
      ),
    ).toEqual([])
    expect(parseHermesSkillsTable('hermes skills: unknown subcommand')).toEqual(
      [],
    )
  })

  it('parses rows regardless of the Status cell (we pass --enabled-only anyway)', () => {
    const out = [
      '┃ Name ┃ Category ┃ Source ┃ Trust ┃ Status ┃',
      '┡━━━━━━╇━━━━━━━━━━╇━━━━━━━━╇━━━━━━━╇━━━━━━━━┩',
      '│ ok    │ tools     │ local   │ local  │ enabled │',
      '│ off   │           │ builtin │ builtin│ disabled │',
    ].join('\n')
    expect(parseHermesSkillsTable(out)).toEqual([
      { name: 'ok', category: 'tools', source: 'local' },
      { name: 'off', category: '', source: 'builtin' },
    ])
  })
})

describe('listHermesSkills', () => {
  const base = { command: 'hermes', cwd: '/vault/梦幻岛' }

  it('runs `skills list --enabled-only` with COLUMNS=300 and parses skills', async () => {
    const { spawnSpy, calls } = scriptedSpawn(() => ({
      stdout: SKILLS_TABLE,
      exit: 0,
    }))
    const res = await listHermesSkills(base, spawnSpy as SpawnLike)
    expect(res.ok).toBe(true)
    expect(res.skills).toEqual([
      { name: 'hermes-desktop-plugins', category: '', source: 'local' },
      { name: 'obsidian-markdown', category: '', source: 'local' },
      {
        name: 'py-homework-solver',
        category: 'software-development',
        source: 'local',
      },
      { name: 'yuanbao', category: '', source: 'official' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['skills', 'list', '--enabled-only'])
    // COLUMNS 加宽防 Rich 表格截断长技能名；cwd 透传 vault 根。
    expect(calls[0].options?.env).toEqual(
      expect.objectContaining({ COLUMNS: '300' }),
    )
    expect(calls[0].options?.cwd).toBe('/vault/梦幻岛')
  })

  it('fails gracefully on a non-zero exit (never rejects)', async () => {
    const { spawnSpy } = scriptedSpawn(() => ({
      stderr: 'skills: hub unreachable\n',
      exit: 1,
    }))
    const res = await listHermesSkills(base, spawnSpy as SpawnLike)
    expect(res.ok).toBe(false)
    expect(res.skills).toEqual([])
    expect(res.error).toContain('skills list 失败')
    expect(res.error).toContain('hub unreachable')
  })

  it('fails gracefully when spawn is unavailable (mobile / no spawn)', async () => {
    // child_process 已被 mock 成无 spawn → getDesktopSpawn() 返回 null。
    const res = await listHermesSkills(base)
    expect(res.ok).toBe(false)
    expect(res.skills).toEqual([])
  })
})
