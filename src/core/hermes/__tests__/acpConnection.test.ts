// ACP 连接层（补刀·五十六）：行分帧、请求/响应配对、通知与反向请求路由、
// 启动回退链、进程退出收敛。全部经 fake 子进程完成，绝不真起 hermes。

import { EventEmitter } from 'events'
import { AcpConnection, resetAcpCommandCache } from '../acpConnection'
import type { SpawnLike, LocalAgentChild } from '../../desktop/localAgent'

interface FakeChild {
  proc: EventEmitter & {
    kill: jest.Mock
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (d: string) => boolean }
  }
  stdinWrites: string[]
  emitStdoutLine(obj: unknown): void
  emitStdoutRaw(text: string): void
  emitStderr(text: string): void
}

function makeFakeChild(): FakeChild {
  const proc = new EventEmitter() as FakeChild['proc']
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdinWrites: string[] = []
  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = {
    write: (d: string) => {
      stdinWrites.push(d)
      return true
    },
  }
  proc.kill = jest.fn(() => true)
  return {
    proc,
    stdinWrites,
    emitStdoutLine: (obj) =>
      stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')),
    emitStdoutRaw: (text) => stdout.emit('data', Buffer.from(text, 'utf8')),
    emitStderr: (text) => stderr.emit('data', Buffer.from(text, 'utf8')),
  }
}

/** spawn 桩：自动应答 initialize，其余请求由用例手动回帧。 */
function makeSpawnImpl(opts?: {
  failFirst?: boolean
}): { spawn: SpawnLike; fakes: FakeChild[]; commands: string[] } {
  const fakes: FakeChild[] = []
  const commands: string[] = []
  const spawn = ((cmd: string) => {
    commands.push(cmd)
    const fake = makeFakeChild()
    fakes.push(fake)
    if (opts?.failFirst && fakes.length === 1) {
      setTimeout(
        () => fake.proc.emit('error', new Error(`spawn ${cmd} ENOENT`)),
        1,
      )
      return fake.proc as unknown as LocalAgentChild
    }
    const stdin = fake.proc.stdin
    stdin.write = (d: string): boolean => {
      fake.stdinWrites.push(d)
      try {
        const frame = JSON.parse(d.trim()) as { id?: number; method?: string }
        if (frame.method === 'initialize' && typeof frame.id === 'number') {
          setTimeout(
            () =>
              fake.emitStdoutLine({
                jsonrpc: '2.0',
                id: frame.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: 'hermes-agent', version: '0.20.0' },
                },
              }),
            1,
          )
        }
      } catch {
        /* not a frame */
      }
      return true
    }
    return fake.proc as unknown as LocalAgentChild
  }) as SpawnLike
  return { spawn, fakes, commands }
}

const baseHandlers = () => ({
  onNotification: jest.fn(),
  onServerRequest: jest.fn(),
  onExit: jest.fn(),
})

describe('AcpConnection', () => {
  beforeEach(() => {
    resetAcpCommandCache()
  })
  it('handshakes initialize and records the agent version', async () => {
    const { spawn, fakes } = makeSpawnImpl()
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: spawn,
    })
    expect(conn.alive).toBe(true)
    expect(conn.agentVersion).toBe('0.20.0')
    // initialize 帧确实发出去了（含 protocolVersion 1）。
    const initFrame = JSON.parse(fakes[0].stdinWrites[0])
    expect(initFrame.method).toBe('initialize')
    expect(initFrame.params.protocolVersion).toBe(1)
    conn.dispose()
  })

  it('falls back to the next candidate on launch ENOENT', async () => {
    const { spawn, fakes } = makeSpawnImpl({ failFirst: true })
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: spawn,
    })
    expect(fakes.length).toBe(2) // 第一个 ENOENT，第二个成功
    expect(conn.alive).toBe(true)
    conn.dispose()
  })

  it('caches the last good command — the next connect hits it directly', async () => {
    const first = makeSpawnImpl({ failFirst: true })
    const conn1 = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: first.spawn,
    })
    expect(first.fakes.length).toBe(2) // 裸命令 ENOENT → fallback 成功
    const cached = first.commands[1]
    expect(cached).toContain('hermes')
    conn1.dispose()

    // 二次连接：直接 spawn 缓存的 fallback，不再尝试裸命令。
    const second = makeSpawnImpl()
    const conn2 = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: second.spawn,
    })
    expect(second.fakes.length).toBe(1)
    expect(second.commands[0]).toBe(cached)
    conn2.dispose()
  })

  it('clears the cached command when it fails — falls back to the full chain', async () => {
    const first = makeSpawnImpl({ failFirst: true })
    const conn1 = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: first.spawn,
    })
    const cached = first.commands[1]
    conn1.dispose()

    // 缓存的 fallback 也 ENOENT → 清缓存并继续回退链（第二个候选成功）。
    const second = makeSpawnImpl({ failFirst: true })
    const conn2 = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: second.spawn,
    })
    expect(second.fakes.length).toBe(2)
    expect(second.commands[0]).toBe(cached) // 先试缓存
    expect(second.commands[1]).toBe('hermes') // 清空后回退链继续
    conn2.dispose()
  })

  it('matches request/response by id and rejects on JSON-RPC error', async () => {
    const { spawn, fakes } = makeSpawnImpl()
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: spawn,
    })
    const fake = fakes[0]

    const p1 = conn.request('session/new', { cwd: '/vault', mcpServers: [] })
    const sent = JSON.parse(fake.stdinWrites[fake.stdinWrites.length - 1])
    fake.emitStdoutLine({ jsonrpc: '2.0', id: sent.id, result: { sessionId: 's-1' } })
    await expect(p1).resolves.toEqual({ sessionId: 's-1' })

    const p2 = conn.request('session/load', { sessionId: 'missing' })
    const sent2 = JSON.parse(fake.stdinWrites[fake.stdinWrites.length - 1])
    fake.emitStdoutLine({
      jsonrpc: '2.0',
      id: sent2.id,
      error: { code: -32000, message: 'boom' },
    })
    await expect(p2).rejects.toThrow('boom')
    conn.dispose()
  })

  it('buffers partial lines until a full frame arrives', async () => {
    const { spawn, fakes } = makeSpawnImpl()
    const handlers = baseHandlers()
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers,
      spawnImpl: spawn,
    })
    const fake = fakes[0]
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'usage_update', used: 42 } },
    })
    // Split mid-frame across two chunks.
    fake.emitStdoutRaw(frame.slice(0, 20))
    expect(handlers.onNotification).not.toHaveBeenCalled()
    fake.emitStdoutRaw(`${frame.slice(20)}\n`)
    expect(handlers.onNotification).toHaveBeenCalledTimes(1)
    expect(handlers.onNotification).toHaveBeenCalledWith(
      'session/update',
      expect.objectContaining({ sessionId: 's' }),
    )
    conn.dispose()
  })

  it('routes reverse requests and answers with selected/cancelled outcomes', async () => {
    const { spawn, fakes } = makeSpawnImpl()
    const handlers = baseHandlers()
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers,
      spawnImpl: spawn,
    })
    const fake = fakes[0]
    fake.emitStdoutLine({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 'perm-1' }, options: [] },
    })
    expect(handlers.onServerRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 77, method: 'session/request_permission' }),
    )

    conn.respondToServerRequest(77, { optionId: 'allow_once' })
    let last = JSON.parse(fake.stdinWrites[fake.stdinWrites.length - 1])
    expect(last).toEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })

    conn.respondToServerRequest(78, { optionId: null })
    last = JSON.parse(fake.stdinWrites[fake.stdinWrites.length - 1])
    expect(last.result).toEqual({ outcome: { outcome: 'cancelled' } })
    conn.dispose()
  })

  it('fails pending requests and fires onExit when the process dies', async () => {
    const { spawn, fakes } = makeSpawnImpl()
    const handlers = baseHandlers()
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers,
      spawnImpl: spawn,
    })
    const fake = fakes[0]
    const pending = conn.request('session/prompt', {}, 0) // no timeout
    fake.proc.emit('close', 1)
    await expect(pending).rejects.toThrow()
    expect(handlers.onExit).toHaveBeenCalledWith(1)
    expect(conn.alive).toBe(false)
    conn.dispose()
  })

  it('notify() sends fire-and-forget frames (session/cancel)', async () => {
    const { spawn, fakes } = makeSpawnImpl()
    const conn = await AcpConnection.connect({
      command: 'hermes',
      cwd: '/vault',
      handlers: baseHandlers(),
      spawnImpl: spawn,
    })
    conn.notify('session/cancel', { sessionId: 's-1' })
    const last = JSON.parse(fakes[0].stdinWrites[fakes[0].stdinWrites.length - 1])
    expect(last.method).toBe('session/cancel')
    expect(last.id).toBeUndefined()
    conn.dispose()
  })
})
