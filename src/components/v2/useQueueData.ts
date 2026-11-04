import type { Address, Hex } from 'viem'
import { publicClient } from '../../config/client'
import { useShared } from '../../hooks/useShared'
import {
  type QueueEntry,
  type TimelockLog,
  type V2Deployment,
  foldTimelockLogs,
  isOwnerEntry,
  readSafeNonce,
  readTimelockEvents,
} from '../../lib/v2'
import { withRetry } from '../../lib/send'
import type { TrackedOwnerTx } from '../../store'

const NONCE_REFRESH_MS = 10_000
const QUEUE_REFRESH_MS = 30_000
/** Without a known deployment block, scan roughly the last three weeks of Sepolia. */
const DEFAULT_LOOKBACK = 150_000n
/** Rescanned on each refresh, in case the last blocks were reorganised. */
const REORG_OVERLAP = 12n

/** The Safe nonce, one read for every row and panel that shows it. */
export const useSafeNonce = (safe: Address) =>
  useShared(
    `nonce:${safe.toLowerCase()}`,
    () => withRetry(() => readSafeNonce(publicClient, safe)),
    NONCE_REFRESH_MS,
  )

/** Events scanned so far per Timelock and Safe: a refresh only reads the new blocks. */
const scanned = new Map<string, { to: bigint; logs: TimelockLog[] }>()

async function scanTimelock(deployment: V2Deployment, safe: Address) {
  const key = `${deployment.policies.timelock}:${safe}`.toLowerCase()
  const latest = await withRetry(() => publicClient.getBlockNumber())
  const start = deployment.fromBlock ?? (latest > DEFAULT_LOOKBACK ? latest - DEFAULT_LOOKBACK : 0n)
  const previous = scanned.get(key)
  const from = previous && previous.to - REORG_OVERLAP > start ? previous.to - REORG_OVERLAP : start
  const fresh = await withRetry(() =>
    readTimelockEvents(publicClient, deployment, safe, { fromBlock: from, toBlock: latest }),
  )
  const kept = (previous?.logs ?? []).filter((l) => (l.blockNumber ?? 0n) < from)
  const logs = [...kept, ...fresh]
  scanned.set(key, { to: latest, logs })
  return foldTimelockLogs(logs)
}

/** The Timelock queue and freeze history of this Safe, shared by the Queue tab and its badge. */
export const useTimelockLogs = (deployment: V2Deployment, safe: Address) =>
  useShared(
    `timelock:${deployment.policies.timelock}:${safe}`.toLowerCase(),
    () => scanTimelock(deployment, safe),
    QUEUE_REFRESH_MS,
  )

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()

/**
 * Items that wait on someone, from the events alone (no per-row reads): a tracked owner transaction
 * not scheduled yet (to sign or schedule), and any open schedule past its ready time (to execute).
 */
export function countNeedingAction(
  queue: readonly QueueEntry[],
  tracked: readonly TrackedOwnerTx[],
  now: bigint,
  nonce?: bigint,
): number {
  const live = (e: QueueEntry) => !isOwnerEntry(e) || nonce === undefined || e.nonce >= nonce
  const ready = queue.filter((e) => e.state === 'scheduled' && e.readyAt <= now && live(e)).length
  const unscheduled = tracked.filter((t) => !t.executed && !queue.some((e) => same(e.txHash, t.hash))).length
  return ready + unscheduled
}
