import { useState } from 'react'
import { describeError } from '../lib/errors'

/**
 * Square ↻ button for card headers. Spins while `onClick` runs (or while `busy` is set by the
 * caller, e.g. during background polling) and shows a failure in its tooltip.
 */
export function RefreshButton({
  onClick,
  title,
  busy = false,
}: {
  onClick: () => Promise<unknown> | void
  title: string
  busy?: boolean
}) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const spinning = busy || running

  const run = async () => {
    setRunning(true)
    setError(undefined)
    try {
      await onClick()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <button
      type="button"
      className={error ? 'icon-btn icon-btn-error' : 'icon-btn'}
      title={error ? `${title} — failed: ${error}` : title}
      aria-label={title}
      disabled={spinning}
      onClick={run}
    >
      <span className={spinning ? 'spin' : undefined}>↻</span>
    </button>
  )
}
