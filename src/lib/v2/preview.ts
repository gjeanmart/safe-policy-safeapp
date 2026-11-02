import {
  type Address,
  BaseError,
  type Hex,
  type PublicClient,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  size,
} from 'viem'
import { policyEngineV2Abi, policyV2ErrorsAbi } from './abi'
import type { OwnerCall } from './changes'
import { type PolicyName, type V2Deployment, policyNameOf, selectorName } from './policies'
import { GateKind, LEVEL_LABELS, NO_LEVEL, Operation, TX_INDEX, Verdict, opMaskLabel, opBit } from './scopes'
import { type LabelContext, addressLabel, amountLabel } from './settings'

/**
 * `preview(safe, actor, to, value, data, op)` always reverts with `Preview(GateResult[])` (SPEC
 * §6.7): every engine rule, matched attachment and policy run, without stopping at the first deny.
 * This module builds the call, decodes the revert into per-gate verdicts with readable reasons,
 * says what a denied transaction still needs (a schedule, a co-signature, ...), and picks the
 * deciding gate: the one a real execution would revert with.
 *
 * @example
 * const result = await runPreview(publicClient, deployment, safe, agent, { to: USDC, value: 0n, data, operation: 0 })
 * if (result.ok) {
 *   result.outcome.allowed                  // false
 *   result.outcome.deciding?.reasonText     // 'Needs a co-signature from 0x12…ab'
 *   result.outcome.needs                    // ['cosignature']
 * }
 */

/** What a context-dependent deny asks for before the transaction can pass. */
export type Need = 'schedule' | 'wait' | 'cosignature' | 'attestation' | 'signatures'

export type Gate = {
  callIndex: number
  /** Transaction-level run (`callIndex == TX_INDEX`). */
  txLevel: boolean
  /** 0..7, or `NO_LEVEL` for engine rules. */
  scopeLevel: number
  kind: GateKind
  attachmentId: Hex
  policy: Address
  policyName?: PolicyName
  verdict: Verdict
  reason: Hex
  /** Decoded reason, when it is a known error. */
  error?: { name: string; args: readonly unknown[] }
  reasonText: string
  needs?: Need
}

export type CallGates = { callIndex: number; gates: Gate[]; allowed: boolean; granting: Gate[] }

export type PreviewOutcome = {
  /** Allowed iff no gate has verdict DENY. */
  allowed: boolean
  /** Denied: the gate a real execution reverts with. Allowed: the first ALLOW that granted. */
  deciding?: Gate
  denies: Gate[]
  /** Distinct needs of the denying gates, if every deny is one the actor can satisfy. */
  needs: Need[]
  /** True when every deny is a satisfiable need (e.g. schedule first, then execute). */
  onlyNeeds: boolean
  calls: CallGates[]
  transaction: Gate[]
}

// ---------------------------------------------------------------------------------------------
// Calling preview
// ---------------------------------------------------------------------------------------------

export type PreviewCall = Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>

/** Calldata of `engine.preview(...)`; send it with `eth_call` (it always reverts). */
export const encodePreview = (safe: Address, actor: Address, c: PreviewCall): Hex =>
  encodeFunctionData({
    abi: policyEngineV2Abi,
    functionName: 'preview',
    args: [safe, actor, c.to, c.value, c.data, c.operation],
  })

/** Raw revert data of a viem error, wherever the RPC put it. */
export function revertDataOf(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined
  const found = error.walk((e) => {
    const data = (e as { data?: unknown }).data
    return (
      (typeof data === 'string' && data.startsWith('0x')) ||
      typeof (data as { data?: unknown } | undefined)?.data === 'string'
    )
  }) as { data?: Hex | { data?: Hex } } | null
  const data = found?.data
  return typeof data === 'string' ? data : data?.data
}

export type PreviewResult =
  | { ok: true; gates: Gate[]; outcome: PreviewOutcome }
  /** The preview reverted with something else (e.g. `InvalidActor`, `Reentrancy`) or the RPC failed. */
  | { ok: false; reason: string }

/** Runs the preview with `eth_call` and decodes it. `actor` is `OWNERS` or a module. */
export async function runPreview(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  actor: Address,
  c: PreviewCall,
  ctx: LabelContext = {},
): Promise<PreviewResult> {
  try {
    await client.call({ to: deployment.engine, data: encodePreview(safe, actor, c) })
    return { ok: false, reason: 'preview returned without reverting (not a V2 engine?)' }
  } catch (error) {
    const data = revertDataOf(error)
    if (!data) return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    const decoded = decodePreviewRevert(data, deployment, ctx)
    if (!decoded) return { ok: false, reason: describeReason(data, ctx).text }
    return { ok: true, gates: decoded, outcome: previewOutcome(decoded) }
  }
}

/** Decodes `Preview(gates)` revert data; undefined if the data is another error. */
export function decodePreviewRevert(
  data: Hex,
  deployment?: V2Deployment,
  ctx: LabelContext = {},
): Gate[] | undefined {
  let decoded
  try {
    decoded = decodeErrorResult({ abi: policyEngineV2Abi, data })
  } catch {
    return undefined
  }
  if (decoded.errorName !== 'Preview') return undefined
  const [results] = decoded.args
  return results.map((r): Gate => {
    const kind = r.kind as GateKind
    const verdict = r.verdict as Verdict
    const { text, error, needs } =
      size(r.reason) === 0
        ? {
            text: verdict === Verdict.DENY ? 'Denied: the policy returned a wrong value' : '',
            error: undefined,
            needs: undefined,
          }
        : describeReason(r.reason, ctx)
    return {
      callIndex: r.callIndex,
      txLevel: r.callIndex === TX_INDEX,
      scopeLevel: r.scopeLevel,
      kind,
      attachmentId: r.attachmentId,
      policy: r.policy,
      policyName: deployment && kind === GateKind.POLICY ? policyNameOf(deployment, r.policy) : undefined,
      verdict,
      reason: r.reason,
      error,
      reasonText: verdict === Verdict.DENY ? text : text && `Does not count: ${text}`,
      needs: verdict === Verdict.DENY ? needs : undefined,
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------------------------

/**
 * Errors the policy contracts declare beyond their frozen interfaces (so not in `policyV2ErrorsAbi`):
 * Recipients / Limit `MalformedCall`, PolicySignLib's, and the FROST verifier's (Safenet).
 */
export const extraPolicyErrorsAbi = parseAbi([
  'error MalformedCall(bytes4 selector)',
  'error ZeroAddress()',
  'error OnlyDelegateCall()',
  'error DomainSeparatorUnavailable(address token)',
  'error SignatureExpired(uint256 deadline)',
  'error InvalidMulMulAddWitness()',
  'error UnsupportedMulMulAddInput()',
  'error InvalidScalar()',
  'error NotOnCurve()',
  'error InvalidAddress()',
])

const reasonErrorsAbi = [...policyV2ErrorsAbi, ...extraPolicyErrorsAbi]

const time = (seconds: unknown): string =>
  new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z')

const OPERATIONS = ['CALL', 'DELEGATECALL'] as const

/**
 * Human text for a revert reason (an engine rule or a policy error), with the need it expresses.
 * Unknown data is shown truncated.
 */
export function describeReason(
  data: Hex,
  ctx: LabelContext = {},
): { text: string; error?: { name: string; args: readonly unknown[] }; needs?: Need } {
  let name: string
  let args: readonly unknown[]
  try {
    const decoded = decodeErrorResult({ abi: reasonErrorsAbi, data })
    name = decoded.errorName
    args = decoded.args ?? []
  } catch {
    return { text: `unknown revert ${data.slice(0, 74)}` }
  }
  const error = { name, args }
  const a = (i: number) => args[i]
  const who = (i: number) => addressLabel(a(i) as Address, ctx)
  const fn = (i: number) => selectorName(a(i) as Hex) ?? String(a(i))
  const text = (t: string, needs?: Need) => ({ text: t, error, needs })
  switch (name) {
    case 'Error':
      return text(String(a(0)))
    // Engine rules
    case 'NotGranted':
      return text(
        `No Allow covers ${who(1)}.${fn(2)} (${OPERATIONS[Number(a(3))] ?? a(3)}): denied by default`,
      )
    case 'Denied':
      return text('Denied by a Deny rule')
    case 'AllowNotExact':
      return text('a module needs an Allow on exactly this function to call the Safe or the engine')
    case 'PolicyDenied':
      return describeReason(a(2) as Hex, ctx)
    case 'InvalidSelector':
      return text('Calldata of 1 to 3 bytes')
    case 'MalformedBatch':
      return text('The batch does not decode, is empty, or sends value')
    case 'BatchTooLarge':
      return text('More than 8 calls in the batch')
    case 'NestedBatch':
      return text('A batch inside a batch')
    case 'GuardTargetDenied':
      return text('This call to the policy engine is not allowed')
    case 'ModuleConfigurationDenied':
      return text('Modules can never change the configuration')
    case 'ConfigFrozen':
      return text(`Configuration is frozen until ${time(a(0))}`)
    case 'MalformedContext':
      return text('The policy context after the signatures is malformed')
    // Freeze
    case 'Frozen':
      return text(`Frozen until ${time(a(2))}`)
    // Timelock
    case 'NotScheduled':
      return text('Needs to be scheduled first (Timelock)', 'schedule')
    case 'NotReady':
      return text(`Scheduled, executable from ${time(a(1))}`, 'wait')
    case 'ScheduleExpired':
      return text(`The schedule expired at ${time(a(1))}: schedule again`, 'schedule')
    case 'ClearedByFreeze':
      return text('The schedule was cleared by a freeze: schedule again', 'schedule')
    // Co-signer, Safenet, Quorum
    case 'MissingCoSignature':
      return text(`Needs a co-signature from ${who(0)}`, 'cosignature')
    case 'InvalidCoSignature':
      return text(`Invalid co-signature from ${who(0)}`)
    case 'MissingAttestation':
      return text('Needs a Safenet attestation', 'attestation')
    case 'MalformedAttestation':
    case 'UntrustedAttestationKey':
    case 'AttestationAlreadySpent':
      return text(`Safenet: ${name}`)
    case 'QuorumNotMet':
      return text(`Needs ${a(0)} owner signatures`, 'signatures')
    case 'ModulePathUnsupported':
      return text('Quorum only applies to owner transactions: a module call is always denied')
    // Recipients
    case 'RecipientNotAllowed':
      return text(`Recipient ${who(0)} is not on the list`)
    case 'SpenderNotAllowed':
      return text(`Spender ${who(0)} is not on the list`)
    case 'ApprovalTooLarge':
      return text(`Approval ${a(0)} above the maximum ${a(1)}`)
    case 'UnclassifiedCall':
      return text(`${fn(0)} is not a payment the Recipients policy understands (strict)`)
    // Limit
    case 'LimitExceeded': {
      const token = a(1) as Address
      return text(
        `Over budget: ${amountLabel(token, a(2) as bigint, ctx)} requested, ${amountLabel(token, a(3) as bigint, ctx)} left`,
      )
    }
    case 'Unpriced': {
      const token = a(1) as Address
      return text(
        BigInt(token) === 0n
          ? `The budget cannot price ${fn(2)}: denied`
          : `No budget for token ${addressLabel(token, ctx)}`,
      )
    }
    // Args
    case 'ArgViolation':
      return text(`${fn(0)}: argument ${a(1)} not allowed`)
    case 'ArgMissing':
      return text(`${fn(0)}: argument ${a(1)} missing`)
    case 'NoConstraint':
      return text(`${fn(0)} has no argument rule (strict)`)
    case 'MalformedCall':
      return text(`Malformed calldata for ${fn(0)}`)
    case 'SignatureExpired':
      return text(`Signature deadline passed (${time(a(0))})`)
    case 'DomainSeparatorUnavailable':
      return text(`Token ${who(0)} has no DOMAIN_SEPARATOR: cannot sign a permit for it`)
    case 'InvalidMulMulAddWitness':
    case 'UnsupportedMulMulAddInput':
    case 'InvalidScalar':
    case 'NotOnCurve':
      return text(`Safenet: invalid attestation signature (${name})`)
    default:
      return text(args.length ? `${name}(${args.map(String).join(', ')})` : name)
  }
}

// ---------------------------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------------------------

const isNotGranted = (g: Gate) => g.kind === GateKind.RULE && g.error?.name === 'NotGranted'

/**
 * The gate a real check reverts with, per SPEC §6.2–6.3 order: for each call, an engine rule, then
 * a built-in DENY, then `NotGranted`, then call-level policies; then transaction-level policies.
 */
function decidingDeny(calls: readonly CallGates[], transaction: readonly Gate[]): Gate | undefined {
  for (const { gates } of calls) {
    const denies = gates.filter((g) => g.verdict === Verdict.DENY)
    const pick =
      denies.find((g) => g.kind === GateKind.RULE && !isNotGranted(g)) ??
      denies.find((g) => g.kind === GateKind.DENY) ??
      denies.find(isNotGranted) ??
      denies.find((g) => g.kind === GateKind.POLICY)
    if (pick) return pick
  }
  return transaction.find((g) => g.verdict === Verdict.DENY)
}

/** Groups gates per call (transaction-level last) and decides (pure). */
export function previewOutcome(gates: readonly Gate[]): PreviewOutcome {
  const indexes = [...new Set(gates.filter((g) => !g.txLevel).map((g) => g.callIndex))].sort((a, b) => a - b)
  const calls = indexes.map((callIndex): CallGates => {
    const own = gates.filter((g) => g.callIndex === callIndex)
    return {
      callIndex,
      gates: own,
      allowed: !own.some((g) => g.verdict === Verdict.DENY),
      granting: own.filter((g) => g.verdict === Verdict.ALLOW),
    }
  })
  const transaction = gates.filter((g) => g.txLevel)
  const denies = gates.filter((g) => g.verdict === Verdict.DENY)
  const allowed = denies.length === 0
  const onlyNeeds = !allowed && denies.every((g) => g.needs !== undefined)
  return {
    allowed,
    deciding: allowed ? calls.flatMap((c) => c.granting)[0] : decidingDeny(calls, transaction),
    denies,
    needs: [...new Set(denies.flatMap((g) => (g.needs ? [g.needs] : [])))],
    onlyNeeds,
    calls,
    transaction,
  }
}

/**
 * One row per policy run: a call-level policy matched at several scopes yields one gate per
 * attachment with the same verdict (SPEC §6.7); the UI shows them as one chip.
 */
export function collapseGates(gates: readonly Gate[]): (Gate & { attachmentIds: Hex[] })[] {
  const rows: (Gate & { attachmentIds: Hex[] })[] = []
  for (const g of gates) {
    const last = rows[rows.length - 1]
    if (
      last &&
      g.kind === GateKind.POLICY &&
      last.kind === GateKind.POLICY &&
      last.callIndex === g.callIndex &&
      isAddressEqual(last.policy, g.policy) &&
      last.verdict === g.verdict &&
      last.reason === g.reason
    ) {
      last.attachmentIds.push(g.attachmentId)
      continue
    }
    rows.push({ ...g, attachmentIds: [g.attachmentId] })
  }
  return rows
}

/** `Actor · one function on a contract`, `engine rule`, `transaction`. */
export const gateLevelLabel = (g: Gate): string =>
  g.scopeLevel === NO_LEVEL ? 'engine rule' : (LEVEL_LABELS[g.scopeLevel] ?? `level ${g.scopeLevel}`)

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

const ownerManagementAbi = parseAbi([
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
])

const SENTINEL_OWNERS: Address = '0x0000000000000000000000000000000000000001'

/**
 * The call a Recovery actor makes (`swapOwner` with the right `prevOwner` from the Safe's owner
 * list): preview it as the recovery module, during a freeze too, for the "recovery still passes"
 * check. It should be denied only for needs (`schedule` / `wait`), never by a Freeze.
 */
export function swapOwnerCall(
  safe: Address,
  owners: readonly Address[],
  oldOwner: Address,
  newOwner: Address,
): PreviewCall {
  const index = owners.findIndex((o) => isAddressEqual(o, oldOwner))
  if (index < 0) throw new Error(`${oldOwner} is not an owner`)
  const prevOwner = index === 0 ? SENTINEL_OWNERS : getAddress(owners[index - 1]!)
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({
      abi: ownerManagementAbi,
      functionName: 'swapOwner',
      args: [prevOwner, oldOwner, newOwner],
    }),
    operation: Operation.CALL,
  }
}

/** Recovery passes iff the preview only asks for a schedule / the delay (never a Freeze deny). */
export const recoveryStillPasses = (outcome: PreviewOutcome): boolean =>
  outcome.allowed || (outcome.onlyNeeds && outcome.needs.every((n) => n === 'schedule' || n === 'wait'))

/** `CALL`, `DELEGATECALL` of a preview call, for the gate header. */
export const operationLabel = (operation: Operation): string => opMaskLabel(opBit(operation))
