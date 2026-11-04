/**
 * Calls `tick` every `ms` while the page is visible. A hidden tab skips its ticks (public RPCs rate
 * limit per client) and catches up with one tick when it shows again. Returns the stop function.
 */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
  let missed = false
  const timer = setInterval(() => {
    if (document.hidden) missed = true
    else tick()
  }, ms)
  const onVisibility = () => {
    if (document.hidden || !missed) return
    missed = false
    tick()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
