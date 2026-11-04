import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { pollWhileVisible } from '../lib/poll'

export type AsyncState<T> = {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
}

/** A fixed period, or one derived from the last data (undefined: stop polling, e.g. a closed item). */
export type PollInterval<T> = number | ((data: T | undefined) => number | undefined)

/**
 * Runs `fn` whenever `key` changes (and every `intervalMs` if set, while the page is visible).
 * While polling the last good value is kept; responses from superseded runs are discarded.
 *
 * @param key Identifies the inputs of `fn`; change it to re-run (e.g. `${safe}:${guard}`).
 */
export function useAsync<T>(fn: () => Promise<T>, key: string, intervalMs?: PollInterval<T>): AsyncState<T> {
  const [result, setResult] = useState<{ run: string; data?: T; error?: unknown }>()
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  useLayoutEffect(() => {
    fnRef.current = fn
  })

  const run = `${key}#${tick}`
  useEffect(() => {
    let current = true
    fnRef.current().then(
      (data) => current && setResult({ run, data }),
      (error: unknown) => current && setResult((previous) => ({ run, data: previous?.data, error })),
    )
    return () => {
      current = false
    }
  }, [run])

  // Never surface data that belongs to a different key.
  const sameKey = result?.run.startsWith(`${key}#`) ?? false
  const data = sameKey ? result?.data : undefined
  const period = typeof intervalMs === 'function' ? intervalMs(data) : intervalMs
  useEffect(() => {
    if (!period) return
    return pollWhileVisible(() => setTick((t) => t + 1), period)
  }, [period])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return {
    data,
    error: sameKey ? result?.error : undefined,
    loading: result?.run !== run,
    reload,
  }
}
