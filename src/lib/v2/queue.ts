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
import type { FreezeState } from './attachments'
import type { V2Deployment } from './policies'
import { OWNERS, type Operation } from './scopes'
import type { TimelockSettings } from './settings'

/**
 * One queue for everything TimelockPolicy delays (SPEC.md §5.1): owner and module schedules,
 * configuration changes included, rebuilt from the policy's events (`Scheduled` carries the full
 * call; `Executed` / `Cancelled` close it). Schedules have no on-chain enumeration, so the app scans
 * logs from the deployment block, then reads each open schedule for its live state.
 *
 * Owner schedules are bound to the Safe transaction hash, and so to the Safe **nonce**: any other
 * owner transaction executed first (a `configure` included) consumes that nonce and the schedule
 * can never execute. {@link ownerNonceState} says where one stands.
 *
 * @example
 * const entries = await readTimelockQueue(client, deployment, safe, { fromBlock })
 * const merged = mergeTimelocks(perId)          // the check's merge over the matched ids
 * scheduleStatus(schedule, merged, now)          // 'waiting' | 'ready' | 'expired' | 'void' | 'frozen'
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
  isConfiguration: boolean
  scheduledBlock: bigint
  state: QueueState
  /** `Cancelled.by`: a canceller, the scheduling module, or the Safe (owners' signatures). */
  cancelledBy?: Address
}

/** A freeze / lift event, for the history of an attachment. */
export type FreezeEvent = {
  kind: 'Frozen' | 'Lifted' | 'FreezeSkipped'
  attachmentId: Hex
  by: Address
  until: bigint
  block: bigint
}

type Log = {
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint | null
  logIndex: number | null
}

const chronological = (a: Log, b: Log) =>
  a.blockNumber === b.blockNumber
    ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
    : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n))

/**
 * Folds TimelockPolicy logs (any order) into one entry per schedule; the newest schedule wins for a
 * hash scheduled again (a module call can be scheduled once more after it executed). Pure.
 */
export function foldTimelockEvents(logs: readonly Log[]): QueueEntry[] {
  const entries = new Map<string, QueueEntry>()
  for (const log of [...logs].sort(chronological)) {
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
        isConfiguration: Boolean(a.isConfiguration),
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

/** Freeze / lift history, newest first. Pure. */
export const foldFreezeEvents = (logs: readonly Log[]): FreezeEvent[] =>
  [...logs]
    .sort(chronological)
    .filter((l) => l.eventName === 'Frozen' || l.eventName === 'Lifted' || l.eventName === 'FreezeSkipped')
    .map((l) => ({
      kind: l.eventName as FreezeEvent['kind'],
      attachmentId: l.args.attachmentId as Hex,
      by: getAddress((l.args.guardian ?? l.args.by) as Address),
      until: BigInt((l.args.until ?? l.args.cooldownUntil) as bigint),
      block: l.blockNumber ?? 0n,
    }))
    .reverse()

/**
 * Scans the TimelockPolicy events of this engine and Safe (both indexed), in `chunk`-block ranges
 * (public RPCs cap `eth_getLogs` at ~50k blocks).
 */
export async function readTimelockLogs(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  options: { fromBlock: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<{ queue: QueueEntry[]; freezes: FreezeEvent[] }> {
  const toBlock = options.toBlock ?? (await client.getBlockNumber())
  const chunk = options.chunk ?? 49_999n
  const logs: Log[] = []
  for (let from = options.fromBlock; from <= toBlock; from += chunk + 1n) {
    const to = from + chunk > toBlock ? toBlock : from + chunk
    const raw = await client.getLogs({ address: deployment.policies.timelock, fromBlock: from, toBlock: to })
    const parsed = parseEventLogs({
      abi: timelockPolicyAbi,
      logs: raw,
      args: { engine: deployment.engine, safe },
    })
    logs.push(...(parsed as unknown as Log[]))
  }
  return { queue: foldTimelockEvents(logs), freezes: foldFreezeEvents(logs) }
}

/** Just the queue (see {@link readTimelockLogs}). */
export const readTimelockQueue = async (
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  options: { fromBlock: bigint; toBlock?: bigint; chunk?: bigint },
): Promise<QueueEntry[]> => (await readTimelockLogs(client, deployment, safe, options)).queue

export type OwnerNonceState =
  /** The Safe's next transaction: executable once ready. */
  | 'next'
  /** A later nonce: every nonce before it must be used first. */
  | 'later'
  /** The nonce was consumed by another transaction: this schedule can never execute. */
  | 'stale'

export const ownerNonceState = (scheduleNonce: bigint, currentNonce: bigint): OwnerNonceState =>
  scheduleNonce < currentNonce ? 'stale' : scheduleNonce === currentNonce ? 'next' : 'later'

export const isOwnerEntry = (entry: Pick<QueueEntry, 'actor'>): boolean => isAddressEqual(entry.actor, OWNERS)

/**
 * What a cancel means (rev 3 fix T2). An owner-path schedule is bound to the signed Safe transaction
 * (its nonce): once cancelled the policy refuses that hash for good (`CancelledTransaction`), so the
 * public signatures can never be scheduled again. A module schedule has no nonce and stays
 * re-schedulable by the module itself. `undefined` for an entry that was not cancelled.
 */
export const cancelOutcome = (
  entry: Pick<QueueEntry, 'actor' | 'state'>,
): 'final' | 'reschedulable' | undefined =>
  entry.state !== 'cancelled' ? undefined : isOwnerEntry(entry) ? 'final' : 'reschedulable'

/** Who may cancel: listed cancellers never cancel a configuration change (rev 3 fix T4). */
export const cancellersOf = (
  entry: Pick<QueueEntry, 'isConfiguration'>,
  cancellers: readonly Address[],
): readonly Address[] => (entry.isConfiguration ? [] : cancellers)

/**
 * TimelockPolicy's merge over the attachments a transaction matches (SPEC.md §5.1; the window of a
 * delay-0 kill switch no longer shortens a delayed one, rev 3 fix T5).
 */
export type MergedTimelock = {
  /** Longest delay; 0 = no schedule needed (kill switch only). */
  delay: bigint
  /** Shortest non-zero window of the delayed attachments (a kill switch's is ignored); 0 = never expires. */
  window: bigint
  /** Latest `configuredAt`: the delay restarts from a re-configuration. */
  configuredAt: bigint
  /** Latest `frozenUntil` and its attachment. */
  frozenUntil: bigint
  frozenId?: Hex
  cancellers: Address[]
}

export function mergeTimelocks(
  parts: readonly {
    attachmentId: Hex
    settings: TimelockSettings
    configuredAt?: bigint
    freeze?: FreezeState
  }[],
): MergedTimelock {
  const m: MergedTimelock = { delay: 0n, window: 0n, configuredAt: 0n, frozenUntil: 0n, cancellers: [] }
  for (const p of parts) {
    const { delay, window, cancellers } = p.settings
    if (BigInt(delay) > m.delay) m.delay = BigInt(delay)
    if (delay !== 0 && window !== 0 && (m.window === 0n || BigInt(window) < m.window))
      m.window = BigInt(window)
    if ((p.configuredAt ?? 0n) > m.configuredAt) m.configuredAt = p.configuredAt ?? 0n
    const frozenUntil = p.freeze?.frozenUntil ?? 0n
    if (frozenUntil > m.frozenUntil) {
      m.frozenUntil = frozenUntil
      m.frozenId = p.attachmentId
    }
    for (const c of cancellers) if (!m.cancellers.some((x) => isAddressEqual(x, c))) m.cancellers.push(c)
  }
  return m
}

export type ScheduleStatus =
  /** A matched attachment is frozen: the check reverts `AttachmentFrozen` until `frozenUntil`. */
  | 'frozen'
  /** Scheduled before a freeze ended (not a configuration change): `VoidedByFreeze`, schedule again. */
  | 'void'
  | 'waiting'
  | 'ready'
  /** Past `readyAt + window`: `ScheduleExpired`, schedule again (it replaces this one). */
  | 'expired'

/**
 * Where a schedule stands, as TimelockPolicy's check would judge it now (frozen first, then ready,
 * expiry and voiding). Pure.
 */
export function scheduleStatus(
  s: { scheduledAt: bigint; isConfiguration: boolean },
  m: MergedTimelock,
  now: bigint,
): { status: ScheduleStatus; readyAt: bigint; expiresAt?: bigint } {
  const start = s.scheduledAt > m.configuredAt ? s.scheduledAt : m.configuredAt
  const readyAt = start + m.delay
  const expiresAt = m.window === 0n ? undefined : readyAt + m.window
  if (now < m.frozenUntil) return { status: 'frozen', readyAt, expiresAt }
  if (now < readyAt) return { status: 'waiting', readyAt, expiresAt }
  if (expiresAt !== undefined && now > expiresAt) return { status: 'expired', readyAt, expiresAt }
  if (!s.isConfiguration && s.scheduledAt < m.frozenUntil) return { status: 'void', readyAt, expiresAt }
  return { status: 'ready', readyAt, expiresAt }
}

/**
 * Owner signatures in the order `checkNSignatures` requires: sorted by signer, ascending,
 * concatenated. Only 65-byte ECDSA signatures (`v` 27/28, or 31/32 for `eth_sign`).
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
