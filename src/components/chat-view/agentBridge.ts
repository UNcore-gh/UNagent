import { useSyncExternalStore } from 'react'

import type { AgentApi } from './useAgent'

/**
 * Cross-root agent sharing (追加⑰). The chat panel and the editor's inline
 * box are SEPARATE React roots, yet both must drive the ONE conversation —
 * "invoke the most recent conversation, not start a new one". A hidden host
 * root runs useAgent() exactly once and publishes the API object here after
 * every render; every other tree subscribes through useSyncExternalStore and
 * re-renders whenever the host publishes a fresh snapshot.
 */
export class AgentBridge {
  private api: AgentApi | null = null
  private listeners = new Set<() => void>()

  /** Host side: push the latest agent API (a fresh object every render). */
  publish = (api: AgentApi): void => {
    this.api = api
    this.listeners.forEach((listener) => listener())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stable between publishes — the useSyncExternalStore contract. */
  getSnapshot = (): AgentApi | null => this.api
}

/** Bind a React tree to the shared agent; null until the host first mounts. */
export const useAgentBridge = (bridge: AgentBridge): AgentApi | null =>
  useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
