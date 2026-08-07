// UndoStack: conversation+turn-tagged entries power the rewind rollback
// choice (追加62). countFor answers "did this turn change anything?", and
// rollbackFrom reverts exactly the tagged entries, keeping others in place.

import { UndoStack } from '../UndoStack'
import type { UndoData } from '../../../utils/undoStore'

function mkData(over: Partial<UndoData> = {}): UndoData {
  return {
    id: 'd1',
    label: '编辑 Note',
    at: 1700000000000,
    kind: 'modify',
    path: 'Notes/Note.md',
    before: 'hello',
    ...over,
  }
}

/** Let pending fire-and-forget persist promises settle. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('UndoStack', () => {
  it('countFor matches entries of the same conversation at or after a turn', () => {
    const stack = new UndoStack()
    stack.push('a', async () => {}, { convId: 'c1', turnNo: 1 })
    stack.push('b', async () => {}, { convId: 'c1', turnNo: 2 })
    stack.push('c', async () => {}, { convId: 'c1', turnNo: 3 })
    stack.push('d', async () => {}, { convId: 'c2', turnNo: 1 })
    stack.push('e', async () => {}, {})

    expect(stack.countFor('c1', 1)).toBe(3)
    expect(stack.countFor('c1', 2)).toBe(2)
    expect(stack.countFor('c1', 3)).toBe(1)
    expect(stack.countFor('c1', 4)).toBe(0)
    // Other conversations / untagged entries never count.
    expect(stack.countFor('c2', 1)).toBe(1)
  })

  it('rollbackFrom reverts tagged entries newest-first and keeps others', async () => {
    const stack = new UndoStack()
    const reverted: string[] = []
    stack.push('a', async () => { reverted.push('a') }, { convId: 'c1', turnNo: 1 })
    stack.push('b', async () => { reverted.push('b') }, { convId: 'c1', turnNo: 2 })
    stack.push('c', async () => { reverted.push('c') }, { convId: 'c1', turnNo: 3 })
    stack.push('d', async () => { reverted.push('d') }, { convId: 'c2', turnNo: 1 })
    stack.push('e', async () => { reverted.push('e') }, { convId: 'c1', turnNo: 3 })

    const n = await stack.rollbackFrom('c1', 2)
    expect(n).toBe(3)
    // Newest first within the tagged set; untagged/other-conv untouched.
    expect(reverted).toEqual(['e', 'c', 'b'])

    // Entries outside the tagged range stay: a (c1 turn1) and d (c2).
    const rest = await stack.rollbackFrom('c1', 1)
    expect(rest).toBe(1) // only 'a' comes back now
    expect(stack.countFor('c1', 1)).toBe(0)
    expect(stack.countFor('c2', 1)).toBe(1) // d untouched
  })

  it('rollbackFrom skips failed reverts but still removes the entry', async () => {
    const stack = new UndoStack()
    let fail = true
    stack.push('bad', async () => {
      if (fail) throw new Error('boom')
      fail = false
    }, { convId: 'c1', turnNo: 1 })
    stack.push('ok', async () => {}, { convId: 'c1', turnNo: 1 })

    const n = await stack.rollbackFrom('c1', 1)
    expect(n).toBe(1) // 'ok' reverted; 'bad' failed but was dropped
    expect(stack.countFor('c1', 1)).toBe(0)
  })

  it('entry cap still applies to tagged pushes', () => {
    const stack = new UndoStack()
    for (let i = 1; i <= 25; i += 1) {
      stack.push(`e${i}`, async () => {}, { convId: 'c1', turnNo: i })
    }
    // 20 entries max: the first five (turn 1-5) fell off the stack,
    // so every surviving entry is turn 6+.
    expect(stack.countFor('c1', 1)).toBe(20)
    expect(stack.countFor('c1', 6)).toBe(20)
    expect(stack.countFor('c1', 21)).toBe(5)
  })
})

describe('UndoStack persistence (Task #6)', () => {
  it('push with data exposes it through currentData; pushes without data do not', () => {
    const stack = new UndoStack()
    const data = mkData()
    stack.push('a', async () => {}, {}, data)
    stack.push('b', async () => {}) // runtime-only, no snapshot
    expect(stack.currentData()).toEqual([data])
  })

  it('setPersist is called after push with the current entries', async () => {
    const stack = new UndoStack()
    const persisted: UndoData[][] = []
    stack.setPersist(async (entries) => {
      persisted.push(entries)
    })
    stack.push('a', async () => {}, {}, mkData({ id: 'd1' }))
    stack.push('b', async () => {}, {}, mkData({ id: 'd2' }))
    await flush()
    expect(persisted).toHaveLength(2)
    expect(persisted[0].map((e) => e.id)).toEqual(['d1'])
    expect(persisted[1].map((e) => e.id)).toEqual(['d1', 'd2'])
  })

  it('a rejecting persist never bubbles up (mobile unhandled-rejection lesson)', async () => {
    const stack = new UndoStack()
    stack.setPersist(async () => {
      throw new Error('adapter write failed')
    })
    // push/undoLast/rollbackFrom must not throw even though persist rejects.
    stack.push('a', async () => {}, { convId: 'c1', turnNo: 1 }, mkData())
    await expect(stack.undoLast()).resolves.toBeUndefined()
    stack.push('b', async () => {}, { convId: 'c1', turnNo: 2 }, mkData({ id: 'd2' }))
    await expect(stack.rollbackFrom('c1', 1)).resolves.toBe(1)
    await flush()
    // If an unhandled rejection escaped, jest would fail the suite.
  })

  it('setPersist(null) stops persistence', async () => {
    const stack = new UndoStack()
    const persist = jest.fn(async () => {})
    stack.setPersist(persist)
    stack.push('a', async () => {}, {}, mkData())
    await flush()
    expect(persist).toHaveBeenCalledTimes(1)
    stack.setPersist(null)
    stack.push('b', async () => {}, {}, mkData({ id: 'd2' }))
    await flush()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('undoLast drops the popped entry from currentData and re-persists', async () => {
    const stack = new UndoStack()
    const persisted: UndoData[][] = []
    stack.setPersist(async (entries) => {
      persisted.push([...entries])
    })
    stack.push('a', async () => {}, {}, mkData({ id: 'd1' }))
    stack.push('b', async () => {}, {}, mkData({ id: 'd2' }))
    await stack.undoLast()
    expect(stack.currentData().map((e) => e.id)).toEqual(['d1'])
    await flush()
    expect(persisted[persisted.length - 1].map((e) => e.id)).toEqual(['d1'])
  })

  it('rollbackFrom removes rolled-back data entries from currentData', async () => {
    const stack = new UndoStack()
    stack.push('a', async () => {}, { convId: 'c1', turnNo: 1 }, mkData({ id: 'd1', convId: 'c1', turnNo: 1 }))
    stack.push('b', async () => {}, { convId: 'c1', turnNo: 2 }, mkData({ id: 'd2', convId: 'c1', turnNo: 2 }))
    stack.push('c', async () => {}, {}, mkData({ id: 'd3' }))
    await stack.rollbackFrom('c1', 2)
    expect(stack.currentData().map((e) => e.id)).toEqual(['d1', 'd3'])
  })

  it('evicting a data-carrying entry via the 20-cap also evicts its data', () => {
    const stack = new UndoStack()
    stack.push('first', async () => {}, {}, mkData({ id: 'old' }))
    for (let i = 1; i <= 20; i += 1) stack.push(`e${i}`, async () => {})
    expect(stack.currentData()).toEqual([])
  })
})

describe('UndoStack hydration (Task #6)', () => {
  it('hydrate rebuilds entries that behave like runtime pushes', async () => {
    const stack = new UndoStack()
    const reverted: string[] = []
    const entries = [
      mkData({ id: 'd1', label: '编辑 A', convId: 'c1', turnNo: 1 }),
      mkData({ id: 'd2', label: '删除 B', convId: 'c1', turnNo: 2, kind: 'delete' }),
    ]
    stack.hydrate(entries, (data) => async () => {
      reverted.push(data.id)
    })

    expect(stack.countFor('c1', 1)).toBe(2)
    expect(stack.countFor('c1', 2)).toBe(1)
    expect(stack.lastLabel()).toBe('删除 B')
    expect(stack.currentData().map((e) => e.id)).toEqual(['d1', 'd2'])

    await stack.undoLast()
    expect(reverted).toEqual(['d2'])
    expect(stack.currentData().map((e) => e.id)).toEqual(['d1'])

    const n = await stack.rollbackFrom('c1', 1)
    expect(n).toBe(1)
    expect(reverted).toEqual(['d2', 'd1'])
  })

  it('rebuild returning null skips that entry', () => {
    const stack = new UndoStack()
    stack.hydrate(
      [mkData({ id: 'keep' }), mkData({ id: 'gone' })],
      (data) => (data.id === 'gone' ? null : async () => {}),
    )
    expect(stack.currentData().map((e) => e.id)).toEqual(['keep'])
  })

  it('hydrate replaces the previous stack contents and respects the 20-cap', () => {
    const stack = new UndoStack()
    stack.push('runtime', async () => {}, {}, mkData({ id: 'rt' }))
    const entries = Array.from({ length: 25 }, (_, i) => mkData({ id: `h${i}` }))
    stack.hydrate(entries, () => async () => {})
    expect(stack.currentData()).toHaveLength(20)
    expect(stack.currentData()[0].id).toBe('h5') // newest 20 kept
    expect(stack.currentData().some((e) => e.id === 'rt')).toBe(false)
  })
})
