import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type AsyncState<T> = {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
}

/**
 * Runs `fn` whenever `key` changes (and every `intervalMs` if set). While polling the last good
 * value is kept; responses from superseded runs are discarded.
 *
 * @param key Identifies the inputs of `fn`; change it to re-run (e.g. `${safe}:${guard}`).
 */
export function useAsync<T>(fn: () => Promise<T>, key: string, intervalMs?: number): AsyncState<T> {
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

  useEffect(() => {
    if (!intervalMs) return
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  // Never surface data that belongs to a different key.
  const sameKey = result?.run.startsWith(`${key}#`) ?? false
  return {
    data: sameKey ? result?.data : undefined,
    error: sameKey ? result?.error : undefined,
    loading: result?.run !== run,
    reload,
  }
}
