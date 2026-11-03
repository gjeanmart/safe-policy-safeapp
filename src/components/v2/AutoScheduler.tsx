import { useEffect } from 'react'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { describeError } from '../../lib/errors'
import { readSafeNonce, readSchedule, timelockCalls } from '../../lib/v2'
import { logActivity, relayStore, v2TrackedStore } from '../../store'
import { hasGasFields, loadOwnerTx, readRoute } from './ownerTx'
import { relay, useRelayer } from './relayer'

const AUTO_SCHEDULE_MS = 20_000

/** Each transaction is tried once per page load, so a failing one does not prompt or spend again. */
const attempted = new Set<string>()
let running = false

/**
 * When auto-schedule is on, schedules every tracked owner transaction as soon as it has all its
 * signatures and needs a schedule, with the chosen relayer. Runs while the app is open, whatever the tab.
 */
export function AutoScheduler() {
  const { safe, state, v2, v2Installed, getQueuedTx } = useSandbox()
  const { autoSchedule } = relayStore.use()
  const relayer = useRelayer()
  const tracked = v2TrackedStore.use()[safe.toLowerCase()]
  const threshold = state?.threshold

  useEffect(() => {
    if (!autoSchedule || !v2 || !v2Installed || !relayer || threshold === undefined || !tracked?.length)
      return
    const { deployment } = v2
    const tick = async () => {
      if (running) return
      running = true
      try {
        const nonce = await readSafeNonce(publicClient, safe)
        for (const t of tracked) {
          const key = `${safe}:${t.hash}`.toLowerCase()
          if (attempted.has(key) || t.executed) continue
          const data = await loadOwnerTx(t.hash, getQueuedTx)
          if (!data || data.executed || data.unusable || data.count < threshold) continue
          if (hasGasFields(data.tx) || data.tx.nonce < nonce) continue
          if (await readSchedule(publicClient, deployment, safe, t.hash)) continue
          attempted.add(key)
          if ((await readRoute(deployment, safe, data.tx)).route !== 'schedule') continue
          const call = timelockCalls.schedule(deployment, safe, data.tx, data.signatures)
          const description = `auto-schedule owner transaction #${data.tx.nonce}`
          try {
            await relay(relayer, { ...call, description })
          } catch (error) {
            logActivity({
              role: relayer.address,
              mode: 'execute',
              label: description,
              status: 'failed',
              detail: describeError(error),
            })
          }
        }
      } catch {
        // A failed read (RPC, Safe{Wallet}) is retried on the next tick.
      } finally {
        running = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), AUTO_SCHEDULE_MS)
    return () => clearInterval(timer)
  }, [autoSchedule, v2, v2Installed, relayer, threshold, tracked, safe, getQueuedTx])

  return null
}
