import { useEffect } from 'react'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { readSafeNonce, readSchedule, timelockCalls } from '../../lib/v2'
import { describeCall } from '../../lib/describeTx'
import { pollWhileVisible } from '../../lib/poll'
import { relayStore, settleProposal, v2TrackedStore } from '../../store'
import { useDescribeContext } from '../useDescribe'
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
  const describeCtx = useDescribeContext()

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
          // Settled for good: no need to read them again on the next tick.
          if (hasGasFields(data.tx) || data.tx.nonce < nonce) {
            attempted.add(key)
            continue
          }
          const scheduled = await readSchedule(publicClient, deployment, safe, t.hash)
          attempted.add(key)
          if (scheduled) continue
          if ((await readRoute(deployment, safe, data.tx)).route !== 'schedule') continue
          const call = timelockCalls.schedule(deployment, safe, data.tx, data.signatures)
          const summary = describeCall(data.tx, describeCtx)
          const log = {
            mode: 'schedule' as const,
            label: `Auto-schedule: ${summary.title}`,
            safeTxHash: t.hash,
            nonce: data.tx.nonce,
            lines: summary.lines,
          }
          try {
            await relay(relayer, call, log)
            settleProposal(t.hash, 'scheduled')
          } catch {
            // relay logged the failure; the transaction is not tried again this session.
          }
        }
      } catch {
        // A failed read (RPC, Safe{Wallet}) is retried on the next tick.
      } finally {
        running = false
      }
    }
    void tick()
    return pollWhileVisible(() => void tick(), AUTO_SCHEDULE_MS)
  }, [autoSchedule, v2, v2Installed, relayer, threshold, tracked, safe, getQueuedTx, describeCtx])

  return null
}
