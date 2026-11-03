import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  hashTypedData,
  parseAbi,
  zeroAddress,
} from 'viem'
import { coSignerPolicyAbi, safenetPolicyAbi, timelockPolicyAbi } from './abi'
import type { OwnerCall } from './changes'
import type { V2Deployment } from './policies'
import { type Operation, moduleCallHash } from './scopes'

/**
 * Transaction identity and proofs (SPEC.md §3.1, §5). Every proof is pushed on-chain before
 * execution, keyed by `ctx.txHash`:
 *
 * - owner path: the Safe transaction hash at the nonce the transaction executes at, with the real
 *   gas fields (V2 requires `safeTxGas == gasPrice == 0`): the hash the owners sign.
 * - module path: `moduleCallHash(safe, module, to, value, data, op)` (no nonce, no chain id);
 *   proofs are consumed on use.
 *
 * Digests: CoSigner `Approval(engine, safe, txHash, useCount, validUntil)` under
 * `("CoSignerPolicy", "1")`, TimelockPolicy `Cancel(engine, safe, txHash, scheduledAt)` under
 * `("TimelockPolicy", "1")`, Safenet `ModuleTransaction(engine, safe, callHash, deadline)` under
 * `("SafenetPolicy", "1")`.
 *
 * @example
 * const tx = safeTransaction(call, await readSafeNonce(client, safe))
 * const hash = safeTxHash(chainId, safe, tx)                         // owners sign this
 * timelockCalls.schedule(deployment, safe, tx, signatures)          // anyone relays
 * const digest = coSignerApprovalDigest(chainId, deployment.policies.coSigner, engine, safe, hash, useCount, until)
 */

export { moduleCallHash }

/** The fields `ISafe.getTransactionHash` hashes. */
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

/** Safe (≥ 1.3) EIP-712 transaction hash: what owners sign and the owner-path `ctx.txHash`. */
export const safeTxHash = (chainId: number, safe: Address, tx: SafeTransaction): Hex =>
  hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  })

/** The `ctx.txHash` of a call: the Safe tx hash at `ownerNonce` for OWNERS, else the module call hash. */
export const txHashOf = (
  chainId: number,
  safe: Address,
  actor: Address,
  c: Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>,
  ownerNonce: bigint,
): Hex =>
  BigInt(actor) === 1n
    ? safeTxHash(chainId, safe, safeTransaction(c, ownerNonce))
    : moduleCallHash(safe, actor, c.to, c.value, c.data, c.operation)

/**
 * What a co-signer signs for {@link coSignerCalls.approveWithSig}: EIP-712
 * `Approval(engine, safe, txHash, useCount, validUntil)` under `("CoSignerPolicy", "1", chainid,
 * policy)`, with the current `useCount(engine, safe, txHash)`. Equals the policy's `approvalDigest`.
 */
export const coSignerApprovalDigest = (
  chainId: number,
  policy: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
  useCount: bigint,
  validUntil: bigint,
): Hex =>
  hashTypedData({
    domain: { name: 'CoSignerPolicy', version: '1', chainId, verifyingContract: policy },
    types: {
      Approval: [
        { name: 'engine', type: 'address' },
        { name: 'safe', type: 'address' },
        { name: 'txHash', type: 'bytes32' },
        { name: 'useCount', type: 'uint256' },
        { name: 'validUntil', type: 'uint64' },
      ],
    },
    primaryType: 'Approval',
    message: { engine, safe, txHash, useCount, validUntil },
  })

/**
 * What the owners sign to cancel an owner-path schedule: EIP-712 `Cancel(engine, safe, txHash,
 * scheduledAt)` under `("TimelockPolicy", "1", chainid, timelock)`. Bound to the current schedule,
 * so a cancel signature cannot cancel a later re-schedule. Equals the policy's `cancelDigest`.
 */
export const timelockCancelDigest = (
  chainId: number,
  timelock: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
  scheduledAt: bigint,
): Hex =>
  hashTypedData({
    domain: { name: 'TimelockPolicy', version: '1', chainId, verifyingContract: timelock },
    types: {
      Cancel: [
        { name: 'engine', type: 'address' },
        { name: 'safe', type: 'address' },
        { name: 'txHash', type: 'bytes32' },
        { name: 'scheduledAt', type: 'uint64' },
      ],
    },
    primaryType: 'Cancel',
    message: { engine, safe, txHash, scheduledAt },
  })

/** Module-path Safenet attestation digest (the Safe tx hash stands in on the owner path). */
export const safenetAttestationDigest = (
  chainId: number,
  policy: Address,
  engine: Address,
  safe: Address,
  callHash: Hex,
  deadline: bigint,
): Hex =>
  hashTypedData({
    domain: { name: 'SafenetPolicy', version: '1', chainId, verifyingContract: policy },
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

// ---------------------------------------------------------------------------------------------
// Direct calls to the policies (not Safe transactions)
// ---------------------------------------------------------------------------------------------

export type DirectCall = { to: Address; data: Hex; description: string }

export const timelockCalls = {
  /** Owners schedule with the signatures they will execute with; anyone relays. */
  schedule: (deployment: V2Deployment, safe: Address, tx: SafeTransaction, signatures: Hex): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'schedule',
      args: [deployment.engine, safe, tx, signatures],
    }),
    description: `schedule owner transaction #${tx.nonce}`,
  }),

  /** Sent by the module itself (`msg.sender` is the actor). */
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

  /** By a canceller of a matched attachment, or the module that scheduled it. */
  cancel: (deployment: V2Deployment, safe: Address, txHash: Hex): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'cancel',
      args: [deployment.engine, safe, txHash],
    }),
    description: `cancel ${txHash.slice(0, 10)}…`,
  }),

  /** `threshold` owner signatures over {@link timelockCancelDigest}; owner-path schedules only. */
  cancelAsOwners: (deployment: V2Deployment, safe: Address, txHash: Hex, signatures: Hex): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'cancelAsOwners',
      args: [deployment.engine, safe, txHash, signatures],
    }),
    description: `cancel ${txHash.slice(0, 10)}… (owners)`,
  }),

  /** A guardian of every listed attachment freezes them for MAX_FREEZE. */
  freeze: (deployment: V2Deployment, safe: Address, ids: readonly Hex[]): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'freeze',
      args: [deployment.engine, safe, ids],
    }),
    description: `freeze ${ids.length} attachment${ids.length === 1 ? '' : 's'}`,
  }),

  /** A guardian or lifter ends a freeze early (the cooldown starts). */
  lift: (deployment: V2Deployment, safe: Address, id: Hex): DirectCall => ({
    to: deployment.policies.timelock,
    data: encodeFunctionData({
      abi: timelockPolicyAbi,
      functionName: 'lift',
      args: [deployment.engine, safe, id],
    }),
    description: `lift ${id.slice(0, 10)}…`,
  }),
}

export const coSignerCalls = {
  /** By the approver itself. */
  approve: (deployment: V2Deployment, safe: Address, txHash: Hex, validUntil: bigint): DirectCall => ({
    to: deployment.policies.coSigner,
    data: encodeFunctionData({
      abi: coSignerPolicyAbi,
      functionName: 'approve',
      args: [deployment.engine, safe, txHash, validUntil],
    }),
    description: `approve ${txHash.slice(0, 10)}…`,
  }),

  /** By anyone, with the approver's signature over {@link coSignerApprovalDigest}. */
  approveWithSig: (
    deployment: V2Deployment,
    safe: Address,
    txHash: Hex,
    approver: Address,
    validUntil: bigint,
    signature: Hex,
  ): DirectCall => ({
    to: deployment.policies.coSigner,
    data: encodeFunctionData({
      abi: coSignerPolicyAbi,
      functionName: 'approveWithSig',
      args: [deployment.engine, safe, txHash, approver, validUntil, signature],
    }),
    description: `approve ${txHash.slice(0, 10)}… (signed)`,
  }),

  revoke: (deployment: V2Deployment, safe: Address, txHash: Hex): DirectCall => ({
    to: deployment.policies.coSigner,
    data: encodeFunctionData({
      abi: coSignerPolicyAbi,
      functionName: 'revoke',
      args: [deployment.engine, safe, txHash],
    }),
    description: `revoke ${txHash.slice(0, 10)}…`,
  }),
}

/** Safenet attestation (V1's 256-byte encoding); deadline 0 on the owner path. Anyone relays. */
export const submitAttestationCall = (
  deployment: V2Deployment,
  safe: Address,
  txHash: Hex,
  deadline: bigint,
  attestation: Hex,
): DirectCall => ({
  to: deployment.policies.safenet,
  data: encodeFunctionData({
    abi: safenetPolicyAbi,
    functionName: 'submitAttestation',
    args: [deployment.engine, safe, txHash, deadline, attestation],
  }),
  description: `attest ${txHash.slice(0, 10)}…`,
})

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

const safeIdentityAbi = parseAbi([
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
])

export const readSafeNonce = (client: PublicClient, safe: Address): Promise<bigint> =>
  client.readContract({ address: safe, abi: safeIdentityAbi, functionName: 'nonce' })

export type Schedule = {
  txHash: Hex
  /** OWNERS or the module that scheduled it. */
  actor: Address
  scheduledAt: bigint
  isConfiguration: boolean
  /** Timelock attachments the transaction matched at schedule time (their cancellers may cancel). */
  attachmentIds: readonly Hex[]
}

/** TimelockPolicy `getSchedule`; undefined when nothing is scheduled. */
export async function readSchedule(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  txHash: Hex,
): Promise<Schedule | undefined> {
  const s = await client.readContract({
    address: deployment.policies.timelock,
    abi: timelockPolicyAbi,
    functionName: 'getSchedule',
    args: [deployment.engine, safe, txHash],
  })
  if (s.scheduledAt === 0n) return undefined
  return { txHash, ...s, scheduledAt: BigInt(s.scheduledAt) }
}

/** TimelockPolicy `cancelDigest` (what the owners sign to cancel), read from the policy. */
export const readCancelDigest = (
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  txHash: Hex,
): Promise<Hex> =>
  client.readContract({
    address: deployment.policies.timelock,
    abi: timelockPolicyAbi,
    functionName: 'cancelDigest',
    args: [deployment.engine, safe, txHash],
  })

/** TimelockPolicy `configuredAt` per id: the delay runs from the latest of these and the schedule. */
export const readConfiguredAt = (
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  id: Hex,
): Promise<bigint> =>
  client.readContract({
    address: deployment.policies.timelock,
    abi: timelockPolicyAbi,
    functionName: 'configuredAt',
    args: [deployment.engine, safe, id],
  })

/** CoSignerPolicy `useCount` and each approver's `approvedUntil` (0 = none) for one transaction. */
export async function readApprovals(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  txHash: Hex,
  approvers: readonly Address[],
): Promise<{ useCount: bigint; approvedUntil: Map<Address, bigint> }> {
  const address = deployment.policies.coSigner
  const [useCount, ...until] = await Promise.all([
    client.readContract({
      address,
      abi: coSignerPolicyAbi,
      functionName: 'useCount',
      args: [deployment.engine, safe, txHash],
    }),
    ...approvers.map((a) =>
      client.readContract({
        address,
        abi: coSignerPolicyAbi,
        functionName: 'approvedUntil',
        args: [deployment.engine, safe, txHash, a],
      }),
    ),
  ])
  return {
    useCount: useCount as bigint,
    approvedUntil: new Map(approvers.map((a, i) => [a, BigInt(until[i] as bigint | number)])),
  }
}
