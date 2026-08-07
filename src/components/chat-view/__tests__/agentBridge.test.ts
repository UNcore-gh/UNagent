import { AgentBridge } from '../agentBridge'

describe('AgentBridge', () => {
  it('starts empty (no host published yet)', () => {
    const bridge = new AgentBridge()
    expect(bridge.getSnapshot()).toBeNull()
  })

  it('notifies subscribers on publish and serves the latest snapshot', () => {
    const bridge = new AgentBridge()
    const seen: unknown[] = []
    bridge.subscribe(() => seen.push(bridge.getSnapshot()))

    const api1 = { n: 1 } as never
    bridge.publish(api1)
    expect(seen).toHaveLength(1)
    expect(bridge.getSnapshot()).toBe(api1)

    const api2 = { n: 2 } as never
    bridge.publish(api2)
    expect(seen).toHaveLength(2)
    expect(bridge.getSnapshot()).toBe(api2)
  })

  it('unsubscribes stop future notifications', () => {
    const bridge = new AgentBridge()
    let calls = 0
    const unsub = bridge.subscribe(() => (calls += 1))

    bridge.publish({} as never)
    unsub()
    bridge.publish({} as never)
    expect(calls).toBe(1)
  })

  it('keeps the snapshot stable between publishes (useSyncExternalStore contract)', () => {
    const bridge = new AgentBridge()
    const api = { n: 1 } as never
    bridge.publish(api)
    expect(bridge.getSnapshot()).toBe(api)
    expect(bridge.getSnapshot()).toBe(api)
  })
})
