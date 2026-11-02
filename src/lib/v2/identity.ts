import {
  type Address,
  type Hex,
  type PublicClient,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  isAddressEqual,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  size,
  zeroAddress,
} from 'viem'
import { coSignerPolicyV2Abi, safenetPolicyV2Abi, timelockPolicyAbi } from './abi'
import type { OwnerCall } from './changes'
import type { V2Deployment } from './policies'
import { CONTEXT_TYPE_HASH, type Operation, moduleCallHash } from './scopes'

/**
 * Transaction identity and proofs (SPEC §7). A policy sees `ctx.txHash`:
 *
 * - owner path: the Safe transaction hash with the real gas fields and the nonce the transaction
 *   consumes (the guard reads `nonce() - 1` after the Safe incremented it), i.e. the hash the owners
 *   sign. A Timelock owner schedule, a co-signature or a Safenet attestation names that hash.
 * - module path: `moduleCallHash(safe, module, to, value, data, op)` (no nonce, no chain id).
 *   Signature proofs over it use an EIP-712 `ModuleTransaction` digest under the policy's domain,
 *   with a `deadline` (Co-signer adds a per-callHash nonce), never the raw hash.
 * - preview: the owner hash at the current nonce with zero gas fields; module as above.
 *
 * @example
 * // Owner path: schedule the next transaction, then execute it after the delay.
 * const tx = safeTransaction(call, await readSafeNonce(client, safe))
 * const hash = safeTxHash(chainId, safe, tx)              // owners sign this
 * timelockCalls.scheduleOwnerTx(deployment, safe, tx, signatures)   // direct call, anyone relays
 * // Module path: the module schedules its own call; the same hash is consumed at execution.
 * const callHash = moduleCallHash(safe, agent, call.to, call.value, call.data, call.operation)
 * const nonce = await readCoSignerModuleTxNonce(client, deployment, safe, callHash)
 * coSignerModuleTxDigest(chainId, deployment.policies.coSigner, engine, safe, callHash, nonce, deadline) // co-signer signs
 */

export { moduleCallHash }

/** The fields `ISafe.getTransactionHash` hashes. V2 requires `gasPrice == 0` and `safeTxGas == 0`. */
export type SafeTransaction = {
  to: Address
  value: bigint
  data: Hex
  operation: Operation
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: Address
  refundReceiver: Address
  nonce: bigint
}

/** A call as a Safe transaction at `nonce`, with the zero gas fields V2 requires. */
export const safeTransaction = (
  c: Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>,
  nonce: bigint,
): SafeTransaction => ({
  to: c.to,
  value: c.value,
  data: c.data,
  operation: c.operation,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: zeroAddress,
  refundReceiver: zeroAddress,
  nonce,
})

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/**
 * Safe (≥ 1.3) EIP-712 transaction hash: what owners sign, what `getTransactionHash` returns, and
 * the owner-path `ctx.txHash` when `tx.nonce` is the nonce the transaction executes at.
 */
export const safeTxHash = (chainId: number, safe: Address, tx: SafeTransaction): Hex =>
  hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  })

/** The owner-path `ctx.txHash` a `preview` uses: current nonce, zero gas fields. */
export const previewOwnerTxHash = (
  chainId: number,
  safe: Address,
  c: Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>,
  currentNonce: bigint,
): Hex => safeTxHash(chainId, safe, safeTransaction(c, currentNonce))

/** Default lifetime of a module-path proof (co-signature, attestation) the app or agent asks for. */
export const MODULE_PROOF_LIFETIME = 3600n

/**
 * What a co-signer signs for a module transaction: EIP-712
 * `ModuleTransaction(engine, safe, callHash, nonce, deadline)` under
 * `("CoSignerPolicyV2", "1", chainid, policy)`, with `nonce = moduleTxNonce(engine, safe, callHash)`
 * (the same call executed twice needs a second co-signature) and `deadline` the last second the
 * co-signature may be consumed. Equals the policy's `moduleTxDigest(engine, safe, callHash, deadline)`.
 */
export const coSignerModuleTxDigest = (
  chainId: number,
  policy: Address,
  engine: Address,
  safe: Address,
  callHash: Hex,
  nonce: bigint,
  deadline: bigint,
): Hex =>
  hashTypedData({
    domain: { name: 'CoSignerPolicyV2', version: '1', chainId, verifyingContract: policy },
    types: {
      ModuleTransaction: [
        { name: 'engine', type: 'address' },
        { name: 'safe', type: 'address' },
        { name: 'callHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'ModuleTransaction',
    message: { engine, safe, callHash, nonce, deadline },
  })

/**
 * What Safenet attests for a module transaction, in place of the Safe transaction hash: EIP-712
 * `ModuleTransaction(engine, safe, callHash, deadline)` under `("SafenetPolicyV2", "1", chainid, policy)`.
 */
export const safenetModuleTxDigest = (
  chainId: number,
  policy: Address,
  engine: Address,
  safe: Address,
  callHash: Hex,
  deadline: bigint,
): Hex =>
  hashTypedData({
    domain: { name: 'SafenetPolicyV2', version: '1', chainId, verifyingContract: policy },
    types: {
      ModuleTransaction: [
        { name: 'engine', type: 'address' },
        { name: 'safe', type: 'address' },
        { name: 'callHash', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'ModuleTransaction',
    message: { engine, safe, callHash, deadline },
  })

/**
 * What owners sign to cancel an owners'-queue schedule: `Cancel(engine, safe, txHash, cancelCount)`
 * under `("TimelockPolicy", "1", chainid, timelock)`. `cancelCount` is the current count (the
 * policy's `cancelCount(engine, safe)`); it needs `min(cancelCount + 1, threshold)` signatures.
 */
export const timelockCancelDigest = (
  chainId: number,
  timelock: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
  cancelCount: bigint,
): Hex =>
  hashTypedData({
    domain: { name: 'TimelockPolicy', version: '1', chainId, verifyingContract: timelock },
    types: {
      Cancel: [
        { name: 'engine', type: 'address' },
        { name: 'safe', type: 'address' },
        { name: 'txHash', type: 'bytes32' },
        { name: 'cancelCount', type: 'uint256' },
      ],
    },
    primaryType: 'Cancel',
    message: { engine, safe, txHash, cancelCount },
  })

// ---------------------------------------------------------------------------------------------
// Owner-path policy context (SPEC §6.6)
// ---------------------------------------------------------------------------------------------

export type PolicyContextEntry = { policy: Address; data: Hex }

const policyContextParams = parseAbiParameters('(address policy, bytes data)[]')
const coSignaturesParams = parseAbiParameters('(address cosigner, bytes signature)[]')

/**
 * Appends the policy context to the owners' signatures:
 * `signatures ‖ abi.encode(PolicyContext[]) ‖ uint256 length ‖ CONTEXT_TYPE_HASH`
 * (the `SignatureExtension` envelope). Each policy may appear once (`MalformedContext` otherwise).
 */
export function withPolicyContext(signatures: Hex, entries: readonly PolicyContextEntry[]): Hex {
  if (entries.length === 0) return signatures
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.policy.toLowerCase()
    if (seen.has(key)) throw new Error(`Policy ${entry.policy} listed twice in the context`)
    seen.add(key)
  }
  const payload = encodeAbiParameters(policyContextParams, [entries])
  return concat([signatures, payload, numberToHex(size(payload), { size: 32 }), CONTEXT_TYPE_HASH])
}

/** CoSignerPolicyV2 owner-path context data: `abi.encode(CoSignature[])` over the Safe tx hash. */
export const encodeCoSignatures = (cosignatures: readonly { cosigner: Address; signature: Hex }[]): Hex =>
  encodeAbiParameters(coSignaturesParams, [cosignatures])

// ---------------------------------------------------------------------------------------------
// Proof calldata (direct calls to the policies, not Safe transactions)
// ---------------------------------------------------------------------------------------------

export type DirectCall = { to: Address; data: Hex; description: string }

export const timelockCalls = {
  /** Owners schedule with the same signatures they will execute with; anyone relays. */
  scheduleOwnerTx: (
    deployment: V2Deployment,
    safe: Address,
    tx: SafeTransaction,
    signatures: Hex,
  ): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'scheduleOwnerTx',
      args: [deployment.engine, safe, tx, signatures],
    }),
    description: `schedule owner transaction #${tx.nonce}`,
  }),

  /** Must be sent by the module itself (`msg.sender` is the actor). */
  scheduleModuleTx: (
    deployment: V2Deployment,
    safe: Address,
    c: Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>,
  ): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'scheduleModuleTx',
      args: [deployment.engine, safe, c.to, c.value, c.data, c.operation],
    }),
    description: 'schedule module call',
  }),

  cancelAsOwners: (deployment: V2Deployment, safe: Address, txHash: Hex, signatures: Hex): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'cancelAsOwners',
      args: [deployment.engine, safe, txHash, signatures],
    }),
    description: `cancel ${txHash} (owners)`,
  }),

  /** By a canceller listed by a matched attachment (e.g. another Safe, from its own transaction). */
  cancel: (deployment: V2Deployment, safe: Address, txHash: Hex): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'cancel',
      args: [deployment.engine, safe, txHash],
    }),
    description: `cancel ${txHash}`,
  }),
}

/** Module-path co-signature, over {@link coSignerModuleTxDigest}; anyone relays. */
export const cosignCall = (
  deployment: V2Deployment,
  safe: Address,
  callHash: Hex,
  cosigner: Address,
  deadline: bigint,
  signature: Hex,
): DirectCall => ({
  to: deployment.policies.coSigner,
  data: encodeFunctionData({
    abi: coSignerPolicyV2Abi,
    functionName: 'cosign',
    args: [deployment.engine, safe, callHash, cosigner, deadline, signature],
  }),
  description: `co-sign ${callHash}`,
})

/** Module-path Safenet attestation (V1's 256-byte encoding) over {@link safenetModuleTxDigest}; anyone relays. */
export const submitAttestationCall = (
  deployment: V2Deployment,
  safe: Address,
  callHash: Hex,
  deadline: bigint,
  attestation: Hex,
): DirectCall => ({
  to: deployment.policies.safenet,
  data: encodeFunctionData({
    abi: safenetPolicyV2Abi,
    functionName: 'submitAttestation',
    args: [deployment.engine, safe, callHash, deadline, attestation],
  }),
  description: `attest ${callHash}`,
})

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

// Not in the frozen ICoSignerPolicyV2 (added by WP5).
const coSignerNonceAbi = parseAbi([
  'function moduleTxNonce(address engine, address safe, bytes32 callHash) view returns (uint256)',
])

/** The nonce the next co-signature of `callHash` must carry. */
export const readCoSignerModuleTxNonce = (
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  callHash: Hex,
): Promise<bigint> =>
  client.readContract({
    address: deployment.policies.coSigner,
    abi: coSignerNonceAbi,
    functionName: 'moduleTxNonce',
    args: [deployment.engine, safe, callHash],
  })

const safeIdentityAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
])

export const readSafeNonce = (client: PublicClient, safe: Address): Promise<bigint> =>
  client.readContract({ address: safe, abi: safeIdentityAbi, functionName: 'nonce' })

/** The Safe's own hash, to cross-check {@link safeTxHash}. */
export const readSafeTxHash = (client: PublicClient, safe: Address, tx: SafeTransaction): Promise<Hex> =>
  client.readContract({
    address: safe,
    abi: safeIdentityAbi,
    functionName: 'getTransactionHash',
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      tx.nonce,
    ],
  })

export type Schedule = {
  txHash: Hex
  actor: Address
  scheduledAt: bigint
  /** Informational (longest delay at schedule time); the check recomputes it. */
  readyAt: bigint
  epoch: bigint
  frozenAtSchedule: boolean
  cancellers: readonly Address[]
}

/** TimelockPolicy `getSchedule` + `getCancellers`; undefined when nothing is scheduled. */
export async function readSchedule(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  txHash: Hex,
): Promise<Schedule | undefined> {
  const args = [deployment.engine, safe, txHash] as const
  const [s, cancellers] = await Promise.all([
    client.readContract({
      address: deployment.policies.timelock,
      abi: timelockPolicyAbi,
      functionName: 'getSchedule',
      args,
    }),
    client.readContract({
      address: deployment.policies.timelock,
      abi: timelockPolicyAbi,
      functionName: 'getCancellers',
      args,
    }),
  ])
  if (isAddressEqual(s.actor, zeroAddress)) return undefined
  return { txHash, ...s, cancellers }
}

export type ScheduleStatus = 'waiting' | 'ready' | 'expired' | 'cleared'

/**
 * Where a schedule stands for the queue view. `delay` / `window` are the current merged settings
 * (max delay, min non-zero window) of the attachments the call matches; `freezeEpoch` the actor's
 * current `freezeStatus` epoch when a matched attachment has `clearOnFreeze`.
 */
export function scheduleStatus(
  s: Pick<Schedule, 'scheduledAt' | 'epoch' | 'frozenAtSchedule'>,
  current: { now: bigint; delay: bigint; window: bigint; clearOnFreeze: boolean; freezeEpoch: bigint },
): { status: ScheduleStatus; readyAt: bigint; expiresAt?: bigint } {
  const readyAt = s.scheduledAt + current.delay
  const expiresAt = current.window === 0n ? undefined : readyAt + current.window
  if (current.clearOnFreeze && (s.frozenAtSchedule || s.epoch !== current.freezeEpoch))
    return { status: 'cleared', readyAt, expiresAt }
  if (current.now < readyAt) return { status: 'waiting', readyAt, expiresAt }
  if (expiresAt !== undefined && current.now > expiresAt) return { status: 'expired', readyAt, expiresAt }
  return { status: 'ready', readyAt, expiresAt }
}
