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
import { policyAbi, policyErrorsAbi, policyGuardAbi } from './abi'
import type { OwnerCall } from './changes'
import { readSafeNonce, txHashOf } from './identity'
import { POLICY_INFO, type PolicyName, type V2Deployment, policyNameOf, selectorName } from './policies'
import { Kind, OPERATION_LABELS, OWNERS, Selectors, levelLabel } from './scopes'
import { type LabelContext, addressLabel, amountLabel } from './settings'

/**
 * Off-chain preview (SPEC.md §3.5): `engine.matches(...)` returns the calls, every matched
 * attachment and the engine error the hook would raise before any policy; then each matched
 * policy's `check(ctx, calls, matches)` is `eth_call`ed from the engine address (same code, same
 * state, nothing persists). The result is one gate per Allow / Deny / policy run, readable reasons,
 * what a denied transaction still needs (a schedule, an approval, ...) and the deciding gate: the one
 * a real execution reverts with.
 *
 * @example
 * const r = await runPreview(client, deployment, safe, agent, { to: USDC, value: 0n, data, operation: 0 }, { chainId })
 * if (r.ok) r.outcome.deciding?.reasonText // 'Needs 1 approval of 1 (Co-signer)'
 */

/** What a context-dependent deny asks for before the transaction can pass. */
export type Need = 'schedule' | 'wait' | 'approval' | 'attestation'

export type GateKind = 'engine' | 'allow' | 'deny' | 'policy'
export type GateVerdict = 'grant' | 'not-counted' | 'pass' | 'deny'

export type Gate = {
  kind: GateKind
  verdict: GateVerdict
  /** Undefined for a transaction-wide engine error and for policy runs (they span calls). */
  callIndex?: number
  level?: number
  attachmentId?: Hex
  policy?: Address
  policyName?: PolicyName
  /** Policy runs: the `(call, level, attachment)` matches it was checked with. */
  matches?: { callIndex: number; level: number; attachmentId: Hex }[]
  reason?: Hex
  error?: { name: string; args: readonly unknown[] }
  reasonText: string
  needs?: Need
}

export type PreviewOutcome = {
  allowed: boolean
  /** Denied: the gate a real execution reverts with. Allowed: the first Allow that granted. */
  deciding?: Gate
  gates: Gate[]
  /** The calls the hook checks (decoded batch sub-calls, else the call itself). */
  calls: { to: Address; value: bigint; data: Hex; operation: number }[]
  denies: Gate[]
  /** Distinct needs of the denying gates. */
  needs: Need[]
  /** True when every deny is a satisfiable need (schedule, wait, approval, attestation). */
  onlyNeeds: boolean
  /** The `ctx.txHash` the policies were checked with. */
  txHash: Hex
}

export type PreviewCall = Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>

export type PreviewResult = { ok: true; outcome: PreviewOutcome } | { ok: false; reason: string }

// ---------------------------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------------------------

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

/**
 * TODO(rev 3 fix T2): errors the contracts add in this round, until `abi.ts` is regenerated; the
 * filter drops each one once the generated ABI has it, so this list can be deleted then.
 */
const PENDING_ERRORS = parseAbi(['error CancelledTransaction(bytes32 txHash)']).filter(
  (e) => !policyErrorsAbi.some((x) => x.type === 'error' && (x.name as string) === e.name),
)

const reasonErrorsAbi = [...policyErrorsAbi, ...PENDING_ERRORS, ...parseAbi(['error Error(string)'])]

const time = (seconds: unknown): string =>
  new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z')

const shortHash = (hash: unknown) => `${String(hash).slice(0, 10)}…`

/** Human text for a revert reason (an engine rule or a policy error), with the need it expresses. */
export function describeReason(
  data: Hex,
  ctx: LabelContext = {},
): { text: string; error?: { name: string; args: readonly unknown[] }; needs?: Need } {
  if (size(data) === 0) return { text: 'reverted without a reason (out of gas, no code, a bare revert)' }
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
    // Engine verdicts and shape
    case 'NotGranted':
      return text(
        `No Allow covers ${who(1)}.${fn(2)} (${OPERATION_LABELS[Number(a(3))] ?? a(3)}): denied by default`,
      )
    case 'Denied':
      return text(`Denied by a Deny rule (call ${a(0)})`)
    case 'PolicyDenied': {
      const inner = describeReason(a(1) as Hex, ctx)
      return size(a(1) as Hex) === 0
        ? text(`${who(0)} did not return the pass value`)
        : { ...inner, text: inner.text }
    }
    case 'InvalidSelector':
      return text('Calldata of 1 to 3 bytes')
    case 'MalformedBatch':
      return text('The batch does not decode, is empty, or sends value')
    case 'BatchTooLarge':
      return text('More than 8 calls in the batch')
    case 'NestedBatch':
      return text('A batch inside a batch')
    case 'GuardTargetDenied':
      return text('Only a top-level configure call (no value, not in a batch) may target the engine')
    case 'Reentrancy':
      return text('Re-entered the engine during a check')
    case 'NonZeroGasPrice':
      return text('gasPrice must be 0 under V2')
    case 'NonZeroSafeTxGas':
      return text('safeTxGas must be 0 under V2')
    case 'ExecutionFailed':
    case 'ModuleExecutionFailed':
      return text('The guarded transaction itself failed')
    // Configuration
    case 'InvalidScope':
      return text('Invalid scope')
    case 'AllowNotPerActor':
      return text('An Allow must name an actor, never Everyone')
    case 'DelegateCallNotExact':
      return text('DELEGATECALL can only be allowed at (actor, contract.function)')
    case 'InvalidOpMask':
      return text(`Invalid op mask ${a(0)}`)
    case 'InvalidPolicy':
      return text(`${who(0)} is not a policy (ERC-165 IPolicy)`)
    case 'PolicyConfigurationFailed':
      return text(`${who(0)} refused its settings: ${describeReason(a(1) as Hex, ctx).text}`)
    case 'TooManyAttachments':
      return text('At most 8 attachments per scope')
    case 'NotAttached':
      return text('Not attached')
    // Timelock
    case 'AttachmentFrozen':
      return text(`Frozen by a guardian until ${time(a(1))}`)
    case 'NotScheduled':
      return text('Needs to be scheduled first (Timelock)', 'schedule')
    case 'NotReady':
      return text(`Scheduled, executable from ${time(a(1))}`, 'wait')
    case 'ScheduleExpired':
      return text(`The schedule expired at ${time(a(1))}: schedule again`, 'schedule')
    case 'VoidedByFreeze':
      return text('Scheduled before a freeze ended: void, schedule again', 'schedule')
    case 'NoTimelock':
      return text('No Timelock applies to this call: nothing to schedule')
    case 'AlreadyScheduled':
      return text(`Already scheduled (${shortHash(a(0))})`)
    case 'CancelledTransaction':
      return text(
        `The owners cancelled this signed transaction (${shortHash(a(0))}) for good: it can never be scheduled again`,
      )
    case 'GasFieldsNotZero':
      return text('safeTxGas and gasPrice must be 0')
    case 'StaleNonce':
      return text(`Nonce ${a(0)} already used (the Safe is at ${a(1)})`)
    case 'TimelockNotCoveringConfiguration':
      return text(
        "This Timelock needs one at least as long covering engine.configure (the owners' (Owners, *))",
      )
    case 'NotCanceller':
      return text(`${who(0)} may not cancel this schedule`)
    case 'NotOwnersQueue':
      return text('The owners can only cancel owner-path schedules')
    case 'NotGuardian':
      return text('Not a guardian of this attachment')
    case 'NotGuardianOrLifter':
      return text('Not a guardian or lifter of this attachment')
    case 'NotFrozen':
      return text('Not frozen')
    // Args
    case 'ConstraintFailed':
      return text(`Call ${a(0)}: condition ${a(2)} does not hold`)
    case 'ArgumentMissing':
      return text(`Call ${a(0)}: argument missing for condition ${a(2)}`)
    case 'NoConstraint':
      return text(`Call ${a(0)}: no condition applies (other calls denied)`)
    // Limit
    case 'LimitExceeded': {
      const token = a(2) as Address
      return text(
        `Over budget at call ${a(0)}: ${amountLabel(token, a(3) as bigint, ctx)} requested, ${amountLabel(token, a(4) as bigint, ctx)} left`,
      )
    }
    case 'Unpriced': {
      const token = a(2) as Address
      return text(
        BigInt(token) === 0n
          ? `The budget cannot price call ${a(0)} (${fn(3)}): denied (native value unlisted, or not a known spend)`
          : `No budget for token ${addressLabel(token, ctx)} (call ${a(0)}): list it`,
      )
    }
    // CoSigner
    case 'MissingApprovals':
      return text(
        `Needs ${a(1)} approval${Number(a(1)) === 1 ? '' : 's'}, has ${a(2)} (Co-signer)`,
        'approval',
      )
    case 'ApprovalExpired':
      return text(`Approval expired at ${time(a(0))}`)
    case 'InvalidSignature':
      return text(`Invalid approval signature of ${who(0)}`)
    case 'SignatureAlreadyUsed':
      return text('This approval signature was already pushed')
    // Safenet
    case 'MissingAttestation':
      return text('Needs a Safenet attestation', 'attestation')
    case 'AttestationExpired':
      return text(`The Safenet attestation expired at ${time(a(0))}: needs a new one`, 'attestation')
    case 'MalformedAttestation':
    case 'UntrustedAttestationKey':
    case 'AttestationAlreadySpent':
    case 'InvalidMulMulAddWitness':
    case 'UnsupportedMulMulAddInput':
    case 'InvalidScalar':
    case 'NotOnCurve':
      return text(`Safenet: ${name}`)
    case 'NoMatches':
      return text('Policy called without a match')
    case 'InvalidSettings':
      return text('Invalid settings')
    default:
      return text(args.length ? `${name}(${args.map(String).join(', ')})` : name)
  }
}

// ---------------------------------------------------------------------------------------------
// Running the preview
// ---------------------------------------------------------------------------------------------

type RawCall = { to: Address; value: bigint; data: Hex; operation: number }

/** `eth_call` of `policy.check` from the engine; the raw revert data or the returned word. */
async function simulateCheck(
  client: PublicClient,
  engine: Address,
  policy: Address,
  data: Hex,
): Promise<{ passed: boolean; reason?: Hex }> {
  const run = async (override: boolean) => {
    const result = await client.call({
      account: engine,
      to: policy,
      data,
      // Some nodes refuse `from` = a contract (EIP-3607): drop its code for the call. Policies only
      // read their own storage in `check`, so the engine's code is not needed.
      stateOverride: override ? [{ address: engine, code: '0x' }] : undefined,
    })
    const word = result.data ?? '0x'
    return {
      passed: size(word) === 32 && word.slice(0, 10).toLowerCase() === Selectors.check,
      reason: undefined,
    }
  }
  try {
    return await run(false)
  } catch (error) {
    const reason = revertDataOf(error)
    if (reason !== undefined) return { passed: false, reason }
    if (/sender|eoa|code/i.test(error instanceof Error ? error.message : '')) {
      try {
        return await run(true)
      } catch (retry) {
        const data = revertDataOf(retry)
        if (data !== undefined) return { passed: false, reason: data }
        throw retry
      }
    }
    throw error
  }
}

/**
 * Runs `matches` and each matched policy's `check` (see the module doc). `actor` is `OWNERS` or a
 * module. Owner path: the policies see the Safe tx hash at `ownerNonce` (default: the current
 * nonce), so a schedule or approval made for that nonce counts. It judges `(to, value, data,
 * operation)` only: the guard also refuses an owner transaction with `safeTxGas` or `gasPrice` other
 * than 0 before any policy runs, so callers importing a signed Safe{Wallet} proposal check those.
 */
export async function runPreview(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  actor: Address,
  c: PreviewCall,
  options: { chainId: number; ownerNonce?: bigint; ctx?: LabelContext },
): Promise<PreviewResult> {
  const ctx = options.ctx ?? {}
  try {
    const isOwners = isAddressEqual(actor, OWNERS)
    const [[calls, found, engineError], nonce] = await Promise.all([
      client.readContract({
        address: deployment.engine,
        abi: policyGuardAbi,
        functionName: 'matches',
        args: [safe, actor, c.to, c.value, c.data, c.operation],
      }),
      isOwners && options.ownerNonce === undefined ? readSafeNonce(client, safe) : options.ownerNonce,
    ])
    const txHash = txHashOf(options.chainId, safe, actor, c, nonce ?? 0n)
    const gates: Gate[] = []

    if (size(engineError) > 0) {
      const d = describeReason(engineError, ctx)
      const callIndex =
        d.error && typeof d.error.args[0] === 'number' ? (d.error.args[0] as number) : undefined
      gates.push({
        kind: 'engine',
        verdict: 'deny',
        callIndex,
        reason: engineError,
        ...d,
        reasonText: d.text,
      })
    }
    for (const m of found) {
      if (m.kind === Kind.ALLOW)
        gates.push({
          kind: 'allow',
          verdict: m.counts ? 'grant' : 'not-counted',
          callIndex: m.callIndex,
          level: m.level,
          attachmentId: m.attachmentId,
          reasonText: m.counts
            ? `Granted at ${levelLabel(m.level)}`
            : 'Does not count: a DELEGATECALL, or a module call to the Safe or the engine, needs an Allow on exactly this function',
        })
      if (m.kind === Kind.DENY)
        gates.push({
          kind: 'deny',
          verdict: 'deny',
          callIndex: m.callIndex,
          level: m.level,
          attachmentId: m.attachmentId,
          reasonText: `Denied by a Deny rule at ${levelLabel(m.level)}`,
        })
    }

    const policies = [
      ...new Set(found.filter((m) => m.kind === Kind.POLICY).map((m) => getAddress(m.policy))),
    ]
    const runs = await Promise.all(
      policies.map(async (policy): Promise<Gate> => {
        const matches = found
          .filter((m) => m.kind === Kind.POLICY && isAddressEqual(m.policy, policy))
          .map((m) => ({ callIndex: m.callIndex, level: m.level, attachmentId: m.attachmentId }))
        const data = encodeFunctionData({
          abi: policyAbi,
          functionName: 'check',
          args: [{ safe, actor, txHash }, calls as readonly RawCall[], matches],
        })
        const result = await simulateCheck(client, deployment.engine, policy, data)
        const base = {
          kind: 'policy' as const,
          policy,
          policyName: policyNameOf(deployment, policy),
          matches,
        }
        if (result.passed) return { ...base, verdict: 'pass', reasonText: 'Passes' }
        const d = result.reason
          ? describeReason(result.reason, ctx)
          : { text: 'did not return the pass value', error: undefined, needs: undefined }
        return {
          ...base,
          verdict: 'deny',
          reason: result.reason,
          error: d.error,
          needs: d.needs,
          reasonText: d.text,
        }
      }),
    )
    gates.push(...runs)
    return { ok: true, outcome: previewOutcome(gates, calls as readonly RawCall[], txHash) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.split('\n')[0]! : String(error) }
  }
}

/** Decides (pure): the engine error first, else the first denying policy in first-match order. */
export function previewOutcome(
  gates: readonly Gate[],
  calls: readonly RawCall[],
  txHash: Hex,
): PreviewOutcome {
  const denies = gates.filter((g) => g.verdict === 'deny')
  const allowed = denies.length === 0
  const deciding = allowed
    ? gates.find((g) => g.verdict === 'grant')
    : (gates.find((g) => g.kind === 'engine') ??
      gates.find((g) => g.kind === 'policy' && g.verdict === 'deny'))
  return {
    allowed,
    deciding,
    gates: [...gates],
    calls: [...calls],
    denies,
    needs: [...new Set(denies.flatMap((g) => (g.needs ? [g.needs] : [])))],
    onlyNeeds: !allowed && denies.every((g) => g.needs !== undefined),
    txHash,
  }
}

/** `Allow`, `Deny`, `Timelock`, `NotGranted`. */
export const gateName = (g: Gate): string => {
  if (g.kind === 'allow') return 'Allow'
  if (g.kind === 'deny') return 'Deny'
  if (g.kind === 'engine') return g.error?.name ?? 'Engine rule'
  return g.policyName ? POLICY_INFO[g.policyName].label : 'Policy'
}

/** The attachment a policy deny names (Limit, Args, CoSigner, Timelock errors carry it). */
export const deniedAttachmentId = (g: Gate): Hex | undefined => {
  if (!g.error) return undefined
  const args = g.error.args
  const id = args.find((x) => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x)) as Hex | undefined
  return g.error.name === 'NotScheduled' || g.error.name === 'NotReady' || g.error.name === 'ScheduleExpired'
    ? undefined
    : id
}
