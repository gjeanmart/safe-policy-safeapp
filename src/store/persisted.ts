import { useSyncExternalStore } from 'react'

const PREFIX = 'safe-policy-sandbox:'

// JSON cannot carry bigint; persist them as tagged strings.
const replacer = (_: string, value: unknown) => (typeof value === 'bigint' ? `bigint:${value}` : value)
const reviver = (_: string, value: unknown) =>
  typeof value === 'string' && value.startsWith('bigint:') ? BigInt(value.slice(7)) : value

export type PersistedStore<T> = {
  get: () => T
  set: (next: T | ((previous: T) => T)) => void
  use: () => T
  /** Non-React subscription; listeners run in registration order. */
  subscribe: (listener: () => void) => () => void
}

/** A tiny localStorage-backed store with a React hook, shared across components. */
export function persisted<T>(key: string, initial: T): PersistedStore<T> {
  const storageKey = PREFIX + key
  const listeners = new Set<() => void>()
  let value: T = initial
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw !== null) value = JSON.parse(raw, reviver) as T
  } catch {
    // Corrupt or inaccessible storage: start from the initial value.
  }

  const get = () => value
  const set: PersistedStore<T>['set'] = (next) => {
    value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next
    try {
      if (value === undefined) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, JSON.stringify(value, replacer))
    } catch {
      // Storage full or blocked; keep the in-memory value.
    }
    listeners.forEach((listener) => listener())
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { get, set, subscribe, use: () => useSyncExternalStore(subscribe, get) }
}
