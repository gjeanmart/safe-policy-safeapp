import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import { pollWhileVisible } from '../lib/poll'
import type { AsyncState } from './useAsync'

type Snapshot = { data?: unknown; error?: unknown; loading: boolean }
type Entry = {
  snapshot: Snapshot
  listeners: Set<() => void>
  fn?: () => Promise<unknown>
  running?: Promise<void>
  stop?: () => void
}

const entries = new Map<string, Entry>()

const entryOf = (key: string): Entry => {
  let entry = entries.get(key)
  if (!entry) {
    entry = { snapshot: { loading: true }, listeners: new Set() }
    entries.set(key, entry)
  }
  return entry
}

/** One read in flight per key: callers during a run share it. */
function refresh(entry: Entry): void {
  if (entry.running || !entry.fn) return
  entry.running = entry
    .fn()
    .then(
      (data) => {
        entry.snapshot = { data, loading: false }
      },
      (error: unknown) => {
        entry.snapshot = { data: entry.snapshot.data, error, loading: false }
      },
    )
    .finally(() => {
      entry.running = undefined
      entry.listeners.forEach((listener) => listener())
    })
}

/**
 * Like {@link useAsync}, but one read and one timer per `key` however many components ask (the
 * Safe nonce in every queue row, the Timelock events for the queue and its badge). Polls while the
 * page is visible and someone listens; the last value stays cached for the next listener.
 */
export function useShared<T>(key: string, fn: () => Promise<T>, intervalMs: number): AsyncState<T> {
  // Layout effects run before the store subscribes, so the first read has its function.
  useLayoutEffect(() => {
    entryOf(key).fn = fn
  })
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryOf(key)
      entry.listeners.add(listener)
      if (entry.listeners.size === 1) {
        refresh(entry)
        entry.stop = pollWhileVisible(() => refresh(entry), intervalMs)
      }
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size > 0) return
        entry.stop?.()
        entry.stop = undefined
      }
    },
    [key, intervalMs],
  )
  const snapshot = useSyncExternalStore(subscribe, () => entryOf(key).snapshot)
  const reload = useCallback(() => refresh(entryOf(key)), [key])
  return { data: snapshot.data as T | undefined, error: snapshot.error, loading: snapshot.loading, reload }
}
