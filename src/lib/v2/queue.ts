import {
  type Address,
  type Hex,
  type PublicClient,
  concat,
  getAddress,
  isAddressEqual,
  parseEventLogs,
  size,
} from 'viem'
import { timelockPolicyAbi } from './abi'
import type { Attachment } from './attachments'
import type { V2Deployment } from './policies'
import { OWNERS, type Operation } from './scopes'
import type { TimelockSettings } from './settings'

/**
 * The Timelock queue (SPEC §8.2), rebuilt from TimelockPolicy events: `Scheduled` carries the full
 * call, `Executed` / `Cancelled` close it. Schedules have no on-chain enumeration, so the app scans
 * logs (bounded block ranges, as the V1 policy history) and then reads each open schedule with
 * `readSchedule` (identity.ts) for its live state.
 *
 * Owner-path schedules are bound to the Safe transaction hash, and so to the Safe **nonce** (WP7a):
 * any other owner transaction executed first, configuration requests and applies included, consumes
 * that nonce and the schedule can never execute. {@link ownerNonceState} says where one stands.
 *
 * @example
 * const entries = await readTimelockQueue(client, deployment, safe, { fromBlock })
 * entries.filter((e) => e.state === 'scheduled')        // open schedules, owners' and modules'
 * ownerNonceState(entry.nonce, currentNonce)           // 'next' | 'later' | 'stale'
 */

export type QueueState = 'scheduled' | 'executed' | 'cancelled'

export type QueueEntry = {
  txHash: Hex
  actor: Address
  to: Address
  value: bigint
  data: Hex
  operation: Operation
  /** Safe nonce of an owner schedule; 0 on the module path. */
  nonce: bigint
  /** Informational ready time from the event (the check recomputes it from current settings). */
  readyAt: bigint
  scheduledBlock: bigint
  state: QueueState
  /** `Cancelled.by` when cancelled. */
  cancelledBy?: Address
}

type TimelockLog = {
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint | null
  logIndex: number | null
}

/**
 * Folds TimelockPolicy logs (any order) into one entry per schedule, newest schedule wins for a
 * txHash that was scheduled again (a module call can be scheduled once more after it executed).
 * Pure.
 */
export function foldTimelockEvents(logs: readonly TimelockLog[]): QueueEntry[] {
  const ordered = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
      : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
  )
  const entries = new Map<string, QueueEntry>()
  for (const log of ordered) {
    const txHash = String(log.args.txHash).toLowerCase()
    if (log.eventName === 'Scheduled') {
      const a = log.args
      entries.set(txHash, {
        txHash: a.txHash as Hex,
        actor: getAddress(a.actor as Address),
        to: getAddress(a.to as Address),
        value: a.value as bigint,
        data: a.data as Hex,
        operation: Number(a.operation) as Operation,
        nonce: a.nonce as bigint,
        readyAt: a.readyAt as bigint,
        scheduledBlock: log.blockNumber ?? 0n,
        state: 'scheduled',
      })
      continue
    }
    const entry = entries.get(txHash)
    if (!entry || entry.state !== 'scheduled') continue
    if (log.eventName === 'Executed') entry.state = 'executed'
    if (log.eventName === 'Cancelled') {
      entry.state = 'cancelled'
      entry.cancelledBy = getAddress(log.args.by as Address)
    }
  }
  return [...entries.values()].sort((a, b) => Number(b.scheduledBlock - a.scheduledBlock))
}

/**
 * Scans `Scheduled` / `Executed` / `Cancelled` of `deployment.policies.timelock` for this engine
 * and Safe (both indexed), in `chunk`-block ranges (public RPCs cap `eth_getLogs` at ~50k).
 */
export async function readTimelockQueue(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  options: { fromBlock: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<QueueEntry[]> {
  const toBlock = options.toBlock ?? (await client.getBlockNumber())
  const chunk = options.chunk ?? 49_999n
  const logs: TimelockLog[] = []
  for (let from = options.fromBlock; from <= toBlock; from += chunk + 1n) {
    const to = from + chunk > toBlock ? toBlock : from + chunk
    const raw = await client.getLogs({
      address: deployment.policies.timelock,
      fromBlock: from,
      toBlock: to,
    })
    const parsed = parseEventLogs({
      abi: timelockPolicyAbi,
      logs: raw,
      eventName: ['Scheduled', 'Executed', 'Cancelled'],
      args: { engine: deployment.engine, safe },
    })
    logs.push(...(parsed as unknown as TimelockLog[]))
  }
  return foldTimelockEvents(logs)
}

export type OwnerNonceState =
  /** The Safe's next transaction: executable once ready. */
  | 'next'
  /** A later nonce: every nonce before it must be used first (configuration calls included). */
  | 'later'
  /** The nonce was consumed by another transaction: this schedule can never execute. */
  | 'stale'

export const ownerNonceState = (scheduleNonce: bigint, currentNonce: bigint): OwnerNonceState =>
  scheduleNonce < currentNonce ? 'stale' : scheduleNonce === currentNonce ? 'next' : 'later'

export const isOwnerEntry = (entry: Pick<QueueEntry, 'actor'>): boolean => isAddressEqual(entry.actor, OWNERS)

/**
 * TimelockPolicy's merge rule over the attachments a call matches (SPEC §8 table): longest delay,
 * shortest non-zero window, clear on freeze if any, union of cancellers. Pure.
 */
export function mergeTimelocks(settings: readonly TimelockSettings[]): {
  delay: bigint
  window: bigint
  clearOnFreeze: boolean
  cancellers: Address[]
} {
  let delay = 0n
  let window = 0n
  let clearOnFreeze = false
  const cancellers: Address[] = []
  for (const s of settings) {
    if (BigInt(s.delay) > delay) delay = BigInt(s.delay)
    if (s.window !== 0 && (window === 0n || BigInt(s.window) < window)) window = BigInt(s.window)
    clearOnFreeze ||= s.clearOnFreeze
    for (const c of s.cancellers) if (!cancellers.some((x) => isAddressEqual(x, c))) cancellers.push(c)
  }
  return { delay, window, clearOnFreeze, cancellers }
}

/** Timelock settings of the given attachments (as matched by `readMatchingAttachments`). */
export const timelockSettingsOf = (attachments: readonly Attachment[]): TimelockSettings[] =>
  attachments.flatMap((a) => (a.settings?.policy === 'timelock' ? [a.settings.settings] : []))

/**
 * Owner signatures in the order `checkNSignatures` requires: sorted by signer address, ascending,
 * concatenated. Only 65-byte ECDSA signatures (EIP-712 `v` 27/28, `eth_sign` `v` 31/32) are
 * supported; contract signatures carry a dynamic part this helper does not build.
 */
export function sortOwnerSignatures(signatures: readonly { signer: Address; signature: Hex }[]): Hex {
  const unique = signatures.filter(
    (s, i) => signatures.findIndex((t) => isAddressEqual(t.signer, s.signer)) === i,
  )
  for (const s of unique)
    if (size(s.signature) !== 65)
      throw new Error(
        `Signature of ${s.signer} is not a 65-byte ECDSA signature (contract owners unsupported)`,
      )
  const sorted = [...unique].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
  return sorted.length ? concat(sorted.map((s) => s.signature)) : '0x'
}
