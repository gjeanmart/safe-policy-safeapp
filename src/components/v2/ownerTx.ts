import { type Address, BaseError, type Hex, isAddressEqual, size } from 'viem'
import { chain, publicClient } from '../../config/client'
import type { V2Deployment } from '../../lib/v2'
import {
  Kind,
  type MergedTimelock,
  OWNERS,
  type Operation,
  type SafeTransaction,
  type SafeV2Model,
  type Schedule,
  mergeTimelocks,
  policyGuardAbi,
  readConfiguredAt,
  readSchedule,
  runPreview,
  sortOwnerSignatures,
} from '../../lib/v2'
import type { QueuedSafeTx } from '../../hooks/useSafeApp'
import { describeError } from '../../lib/errors'
import { v2OwnerTxStore } from '../../store'

/** A signed (or being signed) owner transaction and the signatures collected so far. */
export type OwnerTxData = {
  tx: SafeTransaction
  /** Sorted and concatenated, ready for `schedule` / `execTransaction`. */
  signatures: Hex
  count: number
  /** Executed, as Safe{Wallet} reports it. */
  executed: boolean
  /** A signature the guard cannot use (a contract owner): the reason. */
  unusable?: string
  /** From Safe{Wallet}: who proposed it and when (ms), and who signed when. */
  proposer?: Address
  proposedAt?: number
  signers?: { signer: Address; at?: number }[]
}

const fromQueued = (q: QueuedSafeTx): OwnerTxData => {
  let signatures: Hex = '0x'
  let unusable: string | undefined
  try {
    signatures = sortOwnerSignatures(q.signatures)
  } catch (error) {
    unusable = (error as Error).message
  }
  return {
    tx: {
      to: q.to,
      value: q.value,
      data: q.data,
      operation: q.operation as Operation,
      safeTxGas: q.safeTxGas,
      baseGas: q.baseGas,
      gasPrice: q.gasPrice,
      gasToken: q.gasToken,
      refundReceiver: q.refundReceiver,
      nonce: q.nonce,
    },
    signatures,
    count: q.signatures.length,
    executed: q.executed,
    unusable,
    proposer: q.proposer,
    proposedAt: q.submittedAt,
    signers: q.signatures.map((x) => ({ signer: x.signer, at: x.submittedAt })),
  }
}

/**
 * Reads the transaction and its signatures: from Safe{Wallet} when the app runs inside it, else
 * (or when it has fewer) from the signatures collected here. Undefined when neither knows it.
 */
export async function loadOwnerTx(
  hash: Hex,
  getQueuedTx?: (safeTxHash: string) => Promise<QueuedSafeTx>,
): Promise<OwnerTxData | undefined> {
  const stored = v2OwnerTxStore.get()[hash.toLowerCase()]
  const local = stored && {
    tx: stored.tx,
    signatures: stored.signatures,
    count: size(stored.signatures) / 65,
    executed: false,
  }
  const wallet = getQueuedTx ? await getQueuedTx(hash).then(fromQueued, () => undefined) : undefined
  if (!wallet) return local
  if (local && local.count > wallet.count)
    return { ...local, executed: wallet.executed, proposer: wallet.proposer, proposedAt: wallet.proposedAt }
  return wallet
}

/** V2 refuses an owner transaction with a non-zero safeTxGas or gasPrice before any policy runs. */
export const hasGasFields = (tx: SafeTransaction) => tx.safeTxGas !== 0n || tx.gasPrice !== 0n

type Call = { to: Address; value: bigint; data: Hex; operation: Operation }

/** The Timelocks a call matches as `actor` and their latest `configuredAt`, merged as the check does. */
export async function readMergedTimelock(
  deployment: V2Deployment,
  safe: Address,
  actor: Address,
  call: Call,
  model: SafeV2Model,
): Promise<MergedTimelock> {
  const [, found] = await publicClient.readContract({
    address: deployment.engine,
    abi: policyGuardAbi,
    functionName: 'matches',
    args: [safe, actor, call.to, call.value, call.data, call.operation],
  })
  const ids = [
    ...new Set(
      found
        .filter((m) => m.kind === Kind.POLICY && isAddressEqual(m.policy, deployment.policies.timelock))
        .map((m) => m.attachmentId),
    ),
  ]
  const configuredAt = await Promise.all(
    ids.map((id) => readConfiguredAt(publicClient, deployment, safe, id)),
  )
  return mergeTimelocks(
    ids.flatMap((id, i) => {
      const a = model.attachments.find((x) => x.attachmentId === id)
      return a?.settings?.policy === 'timelock'
        ? [
            {
              attachmentId: id,
              settings: a.settings.settings,
              configuredAt: configuredAt[i],
              freeze: a.freeze,
            },
          ]
        : []
    }),
  )
}

/** Before a schedule exists: does the signed transaction need one, can it run now, or is it refused? */
export type Route = { route: 'schedule' } | { route: 'now' } | { route: 'denied'; reason: string }

export async function readRoute(
  deployment: V2Deployment,
  safe: Address,
  tx: SafeTransaction,
): Promise<Route> {
  const r = await runPreview(publicClient, deployment, safe, OWNERS, tx, {
    chainId: chain.id,
    ownerNonce: tx.nonce,
  })
  if (!r.ok) return { route: 'denied', reason: `Preview failed: ${r.reason}` }
  if (r.outcome.allowed) return { route: 'now' }
  if (r.outcome.needs.includes('schedule')) return { route: 'schedule' }
  return { route: 'denied', reason: r.outcome.deciding?.reasonText ?? 'denied' }
}

/** Everything one Queue row needs, read in one go. */
export type OwnerRowData = {
  data?: OwnerTxData
  schedule?: Schedule
  merged?: MergedTimelock
  route?: Route
}

export async function readOwnerRow(
  deployment: V2Deployment,
  safe: Address,
  hash: Hex,
  model: SafeV2Model,
  threshold: number,
  fallback: Call | undefined,
  getQueuedTx?: (safeTxHash: string) => Promise<QueuedSafeTx>,
): Promise<OwnerRowData> {
  const [data, schedule] = await Promise.all([
    loadOwnerTx(hash, getQueuedTx),
    readSchedule(publicClient, deployment, safe, hash),
  ])
  const call = data?.tx ?? fallback
  const merged =
    schedule && call ? await readMergedTimelock(deployment, safe, OWNERS, call, model) : undefined
  const signed = !!data && data.count >= threshold && !hasGasFields(data.tx) && !data.executed
  const route = !schedule && signed ? await readRoute(deployment, safe, data.tx) : undefined
  return { data, schedule, merged, route }
}

/** The outcome of an `eth_call` run as if the block were at a later time. */
export type TimedSimulation =
  | { ok: true }
  | { ok: false; reason: string }
  /** The RPC refused block overrides: nothing could be learned about that time. */
  | { unsupported: true }

const OVERRIDES_REFUSED =
  /-32602|invalid (argument|param)|too many arguments|override|not supported|unknown field/i

/**
 * Dry-runs `call` from `from` with the block time overridden to `time` (eth_call block overrides),
 * to see whether it would pass once a Timelock is ready. Reverts come back as a reason; an RPC that
 * does not take overrides is reported apart, so the caller can say so instead of showing a false
 * "denied".
 */
export async function simulateAtTime(
  from: Address,
  call: { to: Address; data: Hex; value?: bigint },
  time: bigint,
): Promise<TimedSimulation> {
  try {
    await publicClient.call({
      account: from,
      to: call.to,
      data: call.data,
      value: call.value,
      blockOverrides: { time },
    })
    return { ok: true }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const reverted =
      error instanceof BaseError &&
      (/revert/i.test(raw) || !!error.walk((e) => typeof (e as { data?: unknown }).data === 'string'))
    if (!reverted && OVERRIDES_REFUSED.test(raw)) return { unsupported: true }
    return { ok: false, reason: describeError(error) }
  }
}
