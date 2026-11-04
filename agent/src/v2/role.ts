import { type Address, type Hex, encodeFunctionData, getAddress, isAddressEqual, zeroAddress } from 'viem'
import { safeAbi } from '../../../src/abi'
import { describeError, describeRevertData } from '../../../src/lib/errors'
import type { ModuleTx } from '../../../src/lib/moduleTx'
import type { SafeState } from '../../../src/lib/safe'
import { type Config, nameAddress, tokenByAddress } from '../config'
import { CliError } from '../output'
import { coSignerPolicyAbi, timelockPolicyAbi } from './abi'
import {
  ANY,
  type Attachment,
  CallMatch,
  type CheckResult,
  type DecodedError,
  EXACT_LEVEL,
  Kind,
  NOT_DEPLOYED_HINT,
  OWNERS,
  type PolicyKind,
  type Rev3Deployment,
  type Schedule,
  type Scope,
  type TimelockState,
  blockTime,
  client,
  decodeV2Error,
  isRev3Engine,
  knownDeployments,
  moduleCallHash,
  policyKinds,
  readApprovalDigest,
  readApprovedUntil,
  readArgsSettings,
  readAttachments,
  readAttestationDigest,
  readCoSigner,
  readLimitSettings,
  readMatches,
  readRemaining,
  readSchedule,
  readTimelock,
  revertDataOf,
  simulateCheck,
} from './client'
import {
  type ErrorContext,
  type Names,
  amountLabel,
  constraintLabel,
  countdown,
  duration,
  errorText,
  isoTime,
  opsLabel,
  scopeLabel,
  selectorName,
} from './labels'

/**
 * Policy Engine V2 rev 3 for the role (SPEC: contracts/contracts/v2/SPEC.md). chain.ts keeps the V1
 * paths and branches here when the Safe's guard reports `IPolicyGuard`.
 *
 * The role's identity on the module path is the call hash (`moduleCallHash`): a schedule, an
 * approval or an attestation for its call is keyed by it and consumed when the call executes.
 */

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export type V2Context = {
  engine: Address
  /** The rev 3 deployment this engine belongs to; undefined when the CLI has no addresses for it. */
  deployment?: Rev3Deployment
  /** The engine is the Safe's module guard: the role's calls are checked. */
  modulePath: boolean
  ownerPath: boolean
  names: Names
}

/** The rev 3 engine guarding this Safe, if any: the module guard first (it scopes the role). */
export async function detectV2(
  state: SafeState,
): Promise<{ engine: Address; modulePath: boolean; ownerPath: boolean } | undefined> {
  const [moduleIs, guardIs] = await Promise.all([isRev3Engine(state.moduleGuard), isRev3Engine(state.guard)])
  const engine = moduleIs ? state.moduleGuard : guardIs ? state.guard : undefined
  if (!engine) return undefined
  return {
    engine: getAddress(engine),
    modulePath: moduleIs && isAddressEqual(state.moduleGuard, engine),
    ownerPath: guardIs && isAddressEqual(state.guard, engine),
  }
}

const DEPLOYMENT_NAMES: Record<string, string> = {
  timelock: 'TimelockPolicy',
  timelockQueue: 'TimelockPolicyQueue',
  timelockFreeze: 'TimelockPolicyFreeze',
  args: 'ArgsPolicy',
  limit: 'LimitPolicy',
  coSigner: 'CoSignerPolicy',
  safenet: 'SafenetPolicy',
}

export function namesFor(config: Config, engine: Address, deployment?: Rev3Deployment): Names {
  return (address) => {
    if (isAddressEqual(address, zeroAddress)) return 'nobody'
    const known = nameAddress(config, address).name
    if (known) return known
    if (isAddressEqual(address, engine)) return 'PolicyGuard'
    const entry = Object.entries(deployment?.policies ?? {}).find(([, a]) => a && isAddressEqual(a, address))
    return entry ? (DEPLOYMENT_NAMES[entry[0]] ?? entry[0]) : address
  }
}

export async function v2Context(config: Config, state: SafeState): Promise<V2Context | undefined> {
  const found = await detectV2(state)
  if (!found) return undefined
  const deployment = knownDeployments().find((d) => isAddressEqual(d.engine, found.engine))
  return { ...found, deployment, names: namesFor(config, found.engine, deployment) }
}

/** For the rev 3 commands (schedule, queue, cancel, approve, freeze, lift). */
export function requireV2(ctx: V2Context | undefined): V2Context {
  if (ctx) return ctx
  const deployed = knownDeployments().length > 0
  throw new CliError(
    deployed
      ? "This Safe's guard is not a Policy Engine V2 (rev 3): schedules, approvals and freezes only exist there."
      : 'Policy Engine V2 rev 3 is not deployed on this chain (no rev 3 entry in src/config/contracts.ts), ' +
          "and this Safe's guard is not one.",
    deployed ? 'Run safe-role status to see which guard the Safe uses.' : NOT_DEPLOYED_HINT,
  )
}

const tokenOf = (token: Address) => tokenByAddress(token)

// ---------------------------------------------------------------------------------------------
// The Safe's attachments, with the kind of each policy
// ---------------------------------------------------------------------------------------------

export type Model = {
  attachments: Attachment[]
  kindOf: (a: { policy: Address; kind: number }) => PolicyKind | 'allow' | 'deny'
  byId: Map<string, Attachment>
  label: (id: Hex) => string
}

const POLICY_LABELS: Record<PolicyKind | 'allow' | 'deny', string> = {
  allow: 'Allow',
  deny: 'Deny',
  timelock: 'Timelock',
  limit: 'Transfer budget',
  args: 'Conditions',
  coSigner: 'Co-signer',
  safenet: 'Safenet',
  unknown: 'Policy',
}

export async function loadModel(config: Config, ctx: V2Context): Promise<Model> {
  const attachments = await readAttachments(ctx.engine, config.safe)
  const kinds = await policyKinds(
    ctx.engine,
    config.safe,
    attachments.filter((a) => a.kind === Kind.POLICY).map((a) => a.policy),
    ctx.deployment,
  )
  const kindOf: Model['kindOf'] = (a) =>
    a.kind === Kind.ALLOW
      ? 'allow'
      : a.kind === Kind.DENY
        ? 'deny'
        : (kinds.get(a.policy.toLowerCase()) ?? 'unknown')
  const byId = new Map(attachments.map((a) => [a.attachmentId.toLowerCase(), a]))
  const label = (id: Hex) => {
    const a = byId.get(id.toLowerCase())
    return a
      ? `${POLICY_LABELS[kindOf(a)]} at ${scopeLabel(a.scope, config.role, ctx.names)}`
      : `attachment ${id}`
  }
  return { attachments, kindOf, byId, label }
}

const errorContext = (ctx: V2Context, model: Model): ErrorContext => ({
  names: ctx.names,
  tokenOf,
  attachment: model.label,
})

/** The attachments whose actor is this role or everyone: the ones its calls can match. */
const appliesTo = (a: Attachment, role: Address) =>
  isAddressEqual(a.scope.actor, ANY) || isAddressEqual(a.scope.actor, role)

/** Two scopes can match the same call. */
function overlaps(a: Scope, b: Scope): boolean {
  if (a.callMatch === CallMatch.ANY || b.callMatch === CallMatch.ANY) return true
  if (!isAddressEqual(a.to, b.to)) return false
  return a.callMatch === CallMatch.CONTRACT || b.callMatch === CallMatch.CONTRACT || a.selector === b.selector
}

// ---------------------------------------------------------------------------------------------
// Freeze state
// ---------------------------------------------------------------------------------------------

export type FreezeReport = { state: 'active' | 'frozen' | 'cooldown'; until: string | null; text: string }

export function freezeReport(
  t: Pick<TimelockState, 'frozenUntil' | 'cooldownUntil'>,
  now: bigint,
): FreezeReport {
  if (now < t.frozenUntil)
    return {
      state: 'frozen',
      until: isoTime(t.frozenUntil),
      text: `frozen until ${isoTime(t.frozenUntil)} (in ${countdown(t.frozenUntil - now)})`,
    }
  if (now < t.cooldownUntil)
    return {
      state: 'cooldown',
      until: isoTime(t.cooldownUntil),
      text: `active, cooling down until ${isoTime(t.cooldownUntil)} (cannot be frozen again before)`,
    }
  return { state: 'active', until: null, text: 'active (not frozen)' }
}

export type FreezeRow = {
  attachmentId: Hex
  scope: string
  timelock: Address
  appliesToMe: boolean
  guardians: string[]
  lifters: string[]
} & FreezeReport

async function readTimelocks(
  config: Config,
  ctx: V2Context,
  model: Model,
  filter: (a: Attachment) => boolean,
) {
  const timelocks = model.attachments.filter((a) => model.kindOf(a) === 'timelock' && filter(a))
  return Promise.all(
    timelocks.map(async (a) => ({
      a,
      t: await readTimelock(a.policy, ctx.engine, config.safe, a.attachmentId),
    })),
  )
}

/** The freeze state of every Timelock attachment of the Safe. */
export async function freezeRows(
  config: Config,
  ctx: V2Context,
  model: Model,
  now: bigint,
): Promise<FreezeRow[]> {
  return (await readTimelocks(config, ctx, model, () => true)).map(({ a, t }) => ({
    attachmentId: a.attachmentId,
    scope: scopeLabel(a.scope, config.role, ctx.names),
    timelock: a.policy,
    appliesToMe: appliesTo(a, config.role),
    guardians: t.guardians.map(ctx.names),
    lifters: t.lifters.map(ctx.names),
    ...freezeReport(t, now),
  }))
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export async function v2Status(config: Config, ctx: V2Context) {
  const [model, now, batches] = await Promise.all([
    loadModel(config, ctx),
    blockTime(),
    client()
      .readContract({ address: ctx.engine, abi: policyGuardViews, functionName: 'trustedBatches' })
      .catch(() => [] as readonly Address[]),
  ])
  const freeze = await freezeRows(config, ctx, model, now)
  return {
    engine: {
      version: 'v2 rev 3' as const,
      address: ctx.engine,
      modulePath: ctx.modulePath,
      ownerPath: ctx.ownerPath,
      trustedBatches: [...batches],
      addressesKnown: !!ctx.deployment,
      attachments: model.attachments.length,
    },
    freeze,
  }
}

const policyGuardViews = [
  {
    type: 'function',
    name: 'trustedBatches',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
] as const

// ---------------------------------------------------------------------------------------------
// Simulate: matches + each policy's check from the engine + a dry run
// ---------------------------------------------------------------------------------------------

export type Verdict = 'allow' | 'pass' | 'deny' | 'not counted' | 'not reached'

export type GateRow = {
  call: number
  scope: string
  gate: string
  verdict: Verdict
  reason?: string
}

export type Need = 'schedule' | 'wait' | 'approval' | 'attestation'

export type V2Simulation = {
  engine: Address
  callHash: Hex
  allowed: boolean
  /** Denied: what a real execution reverts with. Allowed: the Allow that grants it. */
  deciding?: { gate: string; scope?: string; reason?: string }
  gates: GateRow[]
  /** Denies the role can satisfy (with the user's go-ahead). */
  needs: Need[]
  /** A deny nothing but the owners (or time) can lift. */
  blocked: boolean
  next: string[]
  /** `execTransactionFromModule` as an eth_call from the role (catches GS errors and inner failures). */
  execution: { ok: boolean; reason?: string }
  /** Each denying policy and its error name (engine errors excluded). */
  denials: { kind: PolicyKind; error?: string }[]
  /** For `schedule`: the Timelock that asked for one. */
  timelock?: { address: Address; ids: Hex[]; error?: string }
}

/** Errors whose arguments name the attachment (and the call) they deny. */
const NAMED_ID: Record<string, { id: number; call?: number }> = {
  LimitExceeded: { id: 1, call: 0 },
  Unpriced: { id: 1, call: 0 },
  ConstraintFailed: { id: 1, call: 0 },
  ArgumentMissing: { id: 1, call: 0 },
  NoConstraint: { id: 1, call: 0 },
  MissingApprovals: { id: 0 },
  AttachmentFrozen: { id: 0 },
  VoidedByFreeze: { id: 1 },
}

const NEEDS: Record<string, Need> = {
  NotScheduled: 'schedule',
  ScheduleExpired: 'schedule',
  VoidedByFreeze: 'schedule',
  NotReady: 'wait',
  MissingApprovals: 'approval',
  MissingAttestation: 'attestation',
  AttestationExpired: 'attestation',
}

type PolicyRun = { policy: Address; kind: PolicyKind; ids: Hex[]; result: CheckResult; error?: DecodedError }

async function dryRun(config: Config, tx: ModuleTx, model: Model, ctx: V2Context) {
  try {
    await client().call({
      account: config.role,
      to: config.safe,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: 'execTransactionFromModule',
        args: [tx.to, tx.value, tx.data, tx.operation],
      }),
    })
    return { ok: true }
  } catch (error) {
    const data = revertDataOf(error)
    const decoded = decodeV2Error(data)
    if (decoded?.name === 'PolicyDenied') {
      const inner = decodeV2Error(decoded.args[1] as Hex)
      return {
        ok: false,
        reason: `${ctx.names(decoded.args[0] as Address)}: ${inner ? errorText(inner, errorContext(ctx, model)) : 'denied'}`,
      }
    }
    if (decoded && decoded.name !== 'Error')
      return { ok: false, reason: errorText(decoded, errorContext(ctx, model)) }
    return { ok: false, reason: data ? describeRevertData(data) : describeError(error) }
  }
}

/** Every gate for the role's call, the deciding one, and what to do next. */
export async function v2Simulate(
  config: Config,
  ctx: V2Context,
  tx: ModuleTx,
  planId: string,
): Promise<V2Simulation> {
  const callHash = moduleCallHash(config.safe, config.role, tx)
  const [model, preview, now] = await Promise.all([
    loadModel(config, ctx),
    readMatches(ctx.engine, config.safe, config.role, tx),
    blockTime(),
  ])
  const execution = await dryRun(config, tx, model, ctx)
  const ec = errorContext(ctx, model)
  const engineError = decodeV2Error(preview.engineError)

  // Each distinct policy once, in first-match order, with all its matches (SPEC §3.4 step 4).
  const runs: PolicyRun[] = []
  for (const f of preview.found) {
    if (f.kind !== Kind.POLICY || runs.some((r) => isAddressEqual(r.policy, f.policy))) continue
    const matches = preview.found
      .filter((m) => m.kind === Kind.POLICY && isAddressEqual(m.policy, f.policy))
      .map(({ callIndex, level, attachmentId }) => ({ callIndex, level, attachmentId }))
    const result = await simulateCheck(
      ctx.engine,
      f.policy,
      { safe: config.safe, actor: config.role, txHash: callHash },
      preview.calls,
      matches,
    )
    runs.push({
      policy: f.policy,
      kind: model.kindOf(f) as PolicyKind,
      ids: [...new Set(matches.map((m) => m.attachmentId))],
      result,
      error: result.ok ? undefined : decodeV2Error(result.data),
    })
  }

  const reasonOf = (run: PolicyRun) =>
    run.result.ok ? undefined : run.error ? errorText(run.error, ec) : `denied (${run.result.message})`

  const gates: GateRow[] = preview.found.map((f) => {
    const a = model.byId.get(f.attachmentId.toLowerCase())
    const scope = a ? scopeLabel(a.scope, config.role, ctx.names) : `level ${f.level}`
    const kind = model.kindOf(f)
    const base = { call: f.callIndex, scope, gate: POLICY_LABELS[kind] }
    if (f.kind === Kind.ALLOW)
      return f.counts
        ? { ...base, verdict: 'allow' }
        : {
            ...base,
            verdict: 'not counted',
            reason:
              'a module calling the Safe or the engine, or a DELEGATECALL, needs an Allow on exactly this function',
          }
    if (f.kind === Kind.DENY) return { ...base, verdict: 'deny', reason: 'denied by the owners' }
    const run = runs.find((r) => isAddressEqual(r.policy, f.policy))!
    if (run.result.ok) return { ...base, verdict: 'pass' }
    const named = run.error && NAMED_ID[run.error.name]
    if (named) {
      const id = run.error!.args[named.id] as Hex
      const sameCall = named.call === undefined || Number(run.error!.args[named.call]) === f.callIndex
      if (id.toLowerCase() !== f.attachmentId.toLowerCase() || !sameCall)
        return { ...base, verdict: 'not reached', reason: 'the policy stopped at its first failure' }
    }
    return { ...base, verdict: 'deny', reason: reasonOf(run) }
  })

  const denied = runs.filter((r) => !r.result.ok)
  const allowRow = gates.find((g) => g.verdict === 'allow')
  let deciding: V2Simulation['deciding']
  if (engineError) deciding = { gate: `Engine: ${engineError.name}`, reason: errorText(engineError, ec) }
  else if (denied[0]) {
    const row = gates.find((g) => g.verdict === 'deny' && g.gate === POLICY_LABELS[denied[0]!.kind])
    deciding = { gate: POLICY_LABELS[denied[0].kind], scope: row?.scope, reason: reasonOf(denied[0]) }
  } else if (allowRow) deciding = { gate: 'Allow', scope: allowRow.scope }

  const needs: Need[] = []
  const next: string[] = []
  let blocked = !!engineError
  const add = (s: string) => !next.includes(s) && next.push(s)
  if (engineError) add(engineNext(engineError, config, tx, ctx))
  const timelockRun = runs.find((r) => r.kind === 'timelock')
  for (const run of denied) {
    const need = run.error && NEEDS[run.error.name]
    if (need && !needs.includes(need)) needs.push(need)
    const step = await policyNext(config, ctx, model, run, { planId, callHash, now, timelock: timelockRun })
    if (step.blocking) blocked = true
    add(step.text)
  }
  const policiesPass = !engineError && denied.length === 0
  if (policiesPass && !execution.ok) {
    blocked = true
    add(`The policies allow it, but the call itself fails (${execution.reason}): check safe-role balances.`)
  }
  if (policiesPass && execution.ok)
    add(`Show the user the action and the deciding Allow, then exec ${planId}.`)
  if (blocked && needs.length)
    add('Something else also denies it: satisfying the needs alone will not be enough.')

  return {
    engine: ctx.engine,
    callHash,
    allowed: policiesPass && execution.ok,
    ...(deciding ? { deciding } : {}),
    gates,
    needs,
    blocked,
    next,
    execution,
    denials: denied.map((r) => ({ kind: r.kind, ...(r.error ? { error: r.error.name } : {}) })),
    ...(timelockRun
      ? {
          timelock: {
            address: timelockRun.policy,
            ids: timelockRun.ids,
            ...(timelockRun.error ? { error: timelockRun.error.name } : {}),
          },
        }
      : {}),
  }
}

function engineNext(e: DecodedError, config: Config, tx: ModuleTx, ctx: V2Context): string {
  switch (e.name) {
    case 'NotGranted': {
      const to = e.args[1] as Address
      return (
        'Stop: no Allow covers this call for the role. The owners would add an Allow at ' +
        `(This role, ${ctx.names(to)}.${selectorName(e.args[2] as Hex)}) in the Safe App.`
      )
    }
    case 'Denied':
      return 'Stop: the owners deny this call explicitly.'
    case 'GuardTargetDenied':
      return 'Stop: the engine is configured by the owners, in the Safe App.'
    default:
      return `Stop: the engine refuses the call shape (${e.name}). Plan it differently only if the user asks.${
        isAddressEqual(tx.to, config.safe) ? ' A module calling the Safe needs an exact Allow.' : ''
      }`
  }
}

/**
 * The merged Timelock settings for the ids of a call (SPEC §5.1): max delay, min non-zero window of
 * the delayed attachments (a kill switch's window is ignored, rev 3 fix T5).
 */
async function mergedTimelock(config: Config, ctx: V2Context, timelock: Address, ids: Hex[]) {
  const states = await Promise.all(ids.map((id) => readTimelock(timelock, ctx.engine, config.safe, id)))
  const windows = states
    .filter((s) => s.delay > 0)
    .map((s) => s.window)
    .filter((w) => w > 0)
  return {
    states,
    delay: BigInt(Math.max(0, ...states.map((s) => s.delay))),
    window: BigInt(windows.length ? Math.min(...windows) : 0),
    configuredAt: states.reduce((m, s) => (s.configuredAt > m ? s.configuredAt : m), 0n),
    frozenUntil: states.reduce((m, s) => (s.frozenUntil > m ? s.frozenUntil : m), 0n),
    cancellers: [...new Set(states.flatMap((s) => s.cancellers))],
  }
}

/** Default life of a suggested approval / attestation beyond any Timelock wait (`proofLifetime`). */
const DEFAULT_PROOF_LIFETIME = 3600

/**
 * How long a suggested co-signer approval or Safenet attestation should stay valid: the margin alone,
 * or, when a Timelock delays the call, its delay plus the longer of its window and the margin, so the
 * proof still counts when the schedule is ready (an approval pushed at schedule time would otherwise
 * expire first).
 */
async function proofLifetime(config: Config, ctx: V2Context, timelock?: PolicyRun): Promise<bigint> {
  const margin = BigInt(config.proofLifetime ?? DEFAULT_PROOF_LIFETIME)
  if (!timelock) return margin
  const t = await mergedTimelock(config, ctx, timelock.policy, timelock.ids)
  if (t.delay === 0n) return margin
  return t.delay + (t.window > margin ? t.window : margin)
}

async function policyNext(
  config: Config,
  ctx: V2Context,
  model: Model,
  run: PolicyRun,
  at: { planId: string; callHash: Hex; now: bigint; timelock?: PolicyRun },
): Promise<{ text: string; blocking: boolean }> {
  const e = run.error
  const { planId, callHash, now } = at
  const stop = (text: string) => ({ text, blocking: true })
  const need = (text: string) => ({ text, blocking: false })
  if (!e) return stop(`Stop: ${ctx.names(run.policy)} denied (${run.result.ok ? '' : run.result.message}).`)
  const a = e.args
  switch (e.name) {
    case 'NotScheduled':
    case 'ScheduleExpired':
    case 'VoidedByFreeze': {
      const t = await mergedTimelock(config, ctx, run.policy, run.ids)
      if (now < t.frozenUntil)
        return stop(
          `Timelock: frozen until ${isoTime(t.frozenUntil)}; a schedule made now would be void. Wait.`,
        )
      const why =
        e.name === 'NotScheduled'
          ? 'it needs a schedule'
          : e.name === 'ScheduleExpired'
            ? 'the schedule expired (a new one replaces it)'
            : 'a freeze voided the schedule (a new one replaces it)'
      return need(
        `Timelock: ${why}. With the user's go-ahead: safe-role schedule ${planId} (safe_role_schedule), ` +
          `wait ${duration(t.delay)}, then simulate and exec ${planId}` +
          (t.window ? ` within ${duration(t.window)}.` : '.'),
      )
    }
    case 'NotReady': {
      const readyAt = a[1] as bigint
      return need(
        `Timelock: wait until ${isoTime(readyAt)} (in ${countdown(readyAt - now)}), then simulate and exec ${planId}. ` +
          'safe-role queue shows the countdown.',
      )
    }
    case 'AttachmentFrozen': {
      const t = await readTimelock(run.policy, ctx.engine, config.safe, a[0] as Hex)
      const who = [...t.guardians, ...t.lifters].map(ctx.names)
      return stop(
        `Frozen until ${isoTime(a[1] as bigint)} (in ${countdown((a[1] as bigint) - now)}): nothing to retry. ` +
          (who.length ? `${who.join(', ')} can lift it early.` : 'Wait for it to end.'),
      )
    }
    case 'LimitExceeded': {
      const r = await readRemaining(run.policy, ctx.engine, config.safe, a[1] as Hex, a[2] as Address)
      return stop(
        r.period === 0n
          ? 'Transfer budget: one-time budget, it does not reset. Stop; only the owners can raise it.'
          : `Transfer budget: resets at ${isoTime(r.windowStart + r.period)} (in ${countdown(r.windowStart + r.period - now)}). ` +
              'Wait for the reset or ask the owners. Never split the amount to fit.',
      )
    }
    case 'Unpriced':
      return stop(
        'Transfer budget: it cannot price this call or has no budget for the token. Stop; the owners decide.',
      )
    case 'ConstraintFailed':
    case 'ArgumentMissing':
    case 'NoConstraint': {
      let rule = ''
      if (e.name !== 'NoConstraint') {
        const s = await readArgsSettings(run.policy, ctx.engine, config.safe, a[1] as Hex)
        const c = s.constraints[Number(a[2])]
        if (c) rule = ` The condition: ${constraintLabel(c, ctx.names)}.`
      }
      return stop(
        `Conditions: ${errorText(e, errorContext(ctx, model))}.${rule} Stop; never change the arguments to fit.`,
      )
    }
    case 'MissingApprovals': {
      const id = a[0] as Hex
      const s = await readCoSigner(run.policy, ctx.engine, config.safe, id)
      const until = await Promise.all(
        s.approvers.map((ap) => readApprovedUntil(run.policy, ctx.engine, config.safe, callHash, ap)),
      )
      const pending = s.approvers.filter((_, i) => until[i]! < now)
      const validUntil = now + (await proofLifetime(config, ctx, at.timelock))
      // The digest is per approver: it carries the approver's revision (bumped by each of its revokes).
      const digests = await Promise.all(
        pending.map(
          async (ap) =>
            `${ctx.names(ap)}: ${await readApprovalDigest(run.policy, ctx.engine, config.safe, callHash, ap, validUntil)}`,
        ),
      )
      return need(
        `Co-signer: needs ${Number(a[1]) - Number(a[2])} more approval(s) of callHash ${callHash} from ` +
          `${pending.map(ctx.names).join(', ')}. Tell the user; an approver approves with ` +
          `\`safe-role approve ${callHash} --valid-until ${validUntil}\` (if it runs safe-role) or CoSignerPolicy(${run.policy}).approve(engine ${ctx.engine}, ` +
          `safe ${config.safe}, ${callHash}, validUntil), or signs its EIP-712 digest (${digests.join('; ')}; validUntil ${validUntil} = ` +
          `${isoTime(validUntil)}) for anyone to relay with approveWithSig. Then simulate again.`,
      )
    }
    case 'MissingAttestation':
    case 'AttestationExpired': {
      const deadline = now + (await proofLifetime(config, ctx, at.timelock))
      const digest = await readAttestationDigest(run.policy, ctx.engine, config.safe, callHash, deadline)
      return need(
        `Safenet: needs an attestation of digest ${digest} (deadline ${deadline} = ${isoTime(deadline)}), submitted with ` +
          `submitAttestation(engine, safe, ${callHash}, ${deadline}, attestation) to ${run.policy}. Then simulate again.`,
      )
    }
    default:
      return stop(`${errorText(e, errorContext(ctx, model))}: explain it to the user and stop.`)
  }
}

// ---------------------------------------------------------------------------------------------
// Policies: the role's view
// ---------------------------------------------------------------------------------------------

export type Budget = {
  scope: string
  token: string
  available: string
  amount: string
  period: string
  /** Next reset, or null for a one-time budget. */
  resetsAt: string | null
  resetsIn: string | null
  passUnpriced: boolean
}

export type Protection = { scope: string; policy: string; rule: string; freeze?: FreezeReport }

export type Duty = { attachmentId: Hex; scope: string; policy: string; as: string; command: string }

export async function v2Policies(config: Config, ctx: V2Context) {
  const [model, now] = await Promise.all([loadModel(config, ctx), blockTime()])
  const { names } = ctx
  const role = config.role
  const scopeOf = (a: Attachment) => scopeLabel(a.scope, role, names)
  const mine = model.attachments.filter((a) => appliesTo(a, role))
  const ofKind = (list: Attachment[], kind: PolicyKind) => list.filter((a) => model.kindOf(a) === kind)

  const argsRules = await Promise.all(
    ofKind(mine, 'args').map(async (a) => ({
      a,
      s: await readArgsSettings(a.policy, ctx.engine, config.safe, a.attachmentId),
    })),
  )
  const canDo = mine
    .filter((a) => a.kind === Kind.ALLOW)
    .map((a) => {
      const selfTarget =
        a.scope.callMatch !== CallMatch.ANY &&
        (isAddressEqual(a.scope.to, config.safe) || isAddressEqual(a.scope.to, ctx.engine))
      const conditions = argsRules
        .filter((r) => overlaps(r.a.scope, a.scope))
        .flatMap(({ a: r, s }) => [
          ...s.constraints.map((c) => `${constraintLabel(c, names)} (at ${scopeOf(r)})`),
          ...(s.strict ? [`strict: calls no condition covers are denied (at ${scopeOf(r)})`] : []),
        ])
      return {
        scope: scopeOf(a),
        operations: opsLabel(a.opMask),
        conditions,
        ...(a.level !== EXACT_LEVEL && (selfTarget || a.scope.callMatch === CallMatch.ANY)
          ? {
              note: 'does not count for calls to the Safe or the engine (those need an Allow on exactly the function)',
            }
          : {}),
      }
    })

  const budgets: Budget[] = (
    await Promise.all(
      ofKind(mine, 'limit').map(async (a) => {
        const s = await readLimitSettings(a.policy, ctx.engine, config.safe, a.attachmentId)
        return Promise.all(
          s.limits.map(async (l): Promise<Budget> => {
            const r = await readRemaining(a.policy, ctx.engine, config.safe, a.attachmentId, l.token)
            const reset = r.period === 0n ? null : r.windowStart + r.period
            const amount = (v: bigint) => amountLabel(l.token, v, tokenOf)
            return {
              scope: scopeOf(a),
              token: BigInt(l.token) === 0n ? 'ETH' : (tokenOf(l.token)?.symbol ?? names(l.token)),
              available: amount(r.available),
              amount: amount(r.amount),
              period: r.period === 0n ? 'one-time' : duration(r.period),
              resetsAt: reset === null ? null : isoTime(reset),
              resetsIn: reset === null ? null : countdown(reset - now),
              passUnpriced: s.passUnpriced,
            }
          }),
        )
      }),
    )
  ).flat()

  const timelocks = await readTimelocks(config, ctx, model, () => true)
  const protections: Protection[] = []
  for (const { a, t } of timelocks.filter(({ a }) => appliesTo(a, role))) {
    const roles = [
      t.guardians.length && `guardians ${t.guardians.map(names).join(', ')}`,
      t.lifters.length && `lifters ${t.lifters.map(names).join(', ')}`,
      t.cancellers.length && `cancellers ${t.cancellers.map(names).join(', ')}`,
    ].filter(Boolean)
    protections.push({
      scope: scopeOf(a),
      policy: 'Timelock',
      rule:
        (t.delay ? `delay ${duration(t.delay)}` : 'no delay (kill switch only)') +
        (t.window ? `, window ${duration(t.window)}` : '') +
        (roles.length ? `; ${roles.join('; ')}` : ''),
      freeze: freezeReport(t, now),
    })
  }
  for (const a of ofKind(mine, 'coSigner')) {
    const s = await readCoSigner(a.policy, ctx.engine, config.safe, a.attachmentId)
    protections.push({
      scope: scopeOf(a),
      policy: 'Co-signer',
      rule: `${s.required} of ${s.approvers.length} approvals: ${s.approvers.map(names).join(', ')}`,
    })
  }
  for (const a of ofKind(mine, 'safenet'))
    protections.push({ scope: scopeOf(a), policy: 'Safenet', rule: 'a Safenet attestation per transaction' })
  for (const a of mine.filter((x) => x.kind === Kind.DENY))
    protections.push({ scope: scopeOf(a), policy: 'Deny', rule: `always denied (${opsLabel(a.opMask)})` })
  for (const a of ofKind(mine, 'unknown'))
    protections.push({ scope: scopeOf(a), policy: names(a.policy), rule: 'a policy the CLI does not know' })

  // What this key may do for the Safe as a guardian, lifter, canceller or approver.
  const duties: Duty[] = []
  for (const { a, t } of timelocks) {
    const as = [
      t.guardians.some((g) => isAddressEqual(g, role)) && 'guardian',
      t.lifters.some((g) => isAddressEqual(g, role)) && 'lifter',
      t.cancellers.some((g) => isAddressEqual(g, role)) && 'canceller',
    ].filter((x): x is string => !!x)
    if (as.length)
      duties.push({
        attachmentId: a.attachmentId,
        scope: scopeOf(a),
        policy: 'Timelock',
        as: as.join(', '),
        command: as.includes('guardian')
          ? `safe-role freeze ${a.attachmentId} / safe-role lift ${a.attachmentId}`
          : as.includes('lifter')
            ? `safe-role lift ${a.attachmentId}`
            : 'safe-role cancel <callHash>',
      })
  }
  for (const a of model.attachments.filter((x) => model.kindOf(x) === 'coSigner')) {
    const s = await readCoSigner(a.policy, ctx.engine, config.safe, a.attachmentId)
    if (s.approvers.some((ap) => isAddressEqual(ap, role)))
      duties.push({
        attachmentId: a.attachmentId,
        scope: scopeOf(a),
        policy: 'Co-signer',
        as: 'approver',
        command: 'safe-role approve <txHash>',
      })
  }

  const freeze = timelocks.map(({ a, t }) => ({
    attachmentId: a.attachmentId,
    scope: scopeOf(a),
    appliesToMe: appliesTo(a, role),
    ...freezeReport(t, now),
  }))
  return { canDo, budgets, protections, duties, freeze }
}

// ---------------------------------------------------------------------------------------------
// Timelock: schedule checks and the queue
// ---------------------------------------------------------------------------------------------

export type ScheduleCheck =
  | {
      ok: true
      timelock: Address
      callHash: Hex
      delay: bigint
      /** Estimated: the policy recomputes it from the settings at execution. */
      readyAt: bigint
      window: bigint
      cancellers: string[]
      warnings: string[]
    }
  | { ok: false; reason: string; hint: string }

/** Policies whose deny a schedule does not fix but time or another step might. */
const NOT_BLOCKING_A_SCHEDULE = new Set([
  'NotScheduled',
  'ScheduleExpired',
  'VoidedByFreeze',
  'LimitExceeded',
  'MissingApprovals',
  'MissingAttestation',
  'AttestationExpired',
])

/**
 * Whether scheduling the role's call makes sense now: a Timelock asks for a schedule, nothing that
 * a schedule cannot fix denies, and it is not frozen. Run by the CLI before asking the signer, and
 * again by the signer before it signs.
 */
export async function scheduleCheck(
  config: Config,
  ctx: V2Context,
  tx: ModuleTx,
  planId: string,
): Promise<ScheduleCheck> {
  const fail = (reason: string, hint: string): ScheduleCheck => ({ ok: false, reason, hint })
  if (!ctx.modulePath)
    return fail(
      'The engine is not the module guard: the role is not checked, so there is nothing to schedule.',
      'Run safe-role status.',
    )
  const sim = await v2Simulate(config, ctx, tx, planId)
  if (sim.allowed) return fail('No schedule needed: the call is allowed now.', `Exec ${planId}.`)
  if (!sim.timelock)
    return fail('No Timelock applies to this call: there is nothing to schedule.', `Simulate ${planId}.`)
  const tlError = sim.timelock.error
  if (tlError === 'NotReady')
    return fail('Already scheduled and waiting for its delay.', 'Run safe-role queue.')
  if (tlError === 'AttachmentFrozen')
    return fail(
      'Frozen: a schedule made now would be void.',
      'Wait until the freeze ends (safe-role status).',
    )
  if (!tlError || !['NotScheduled', 'ScheduleExpired', 'VoidedByFreeze'].includes(tlError))
    return fail(
      `The Timelock does not ask for a schedule${tlError ? ` (${tlError})` : ' (it passes)'}.`,
      `Simulate ${planId} and follow its next steps.`,
    )
  const hard = sim.denials.filter((d) => d.kind !== 'timelock' && !NOT_BLOCKING_A_SCHEDULE.has(d.error ?? ''))
  if (sim.deciding?.gate.startsWith('Engine') || hard.length)
    return fail(
      `Scheduling would not help: ${
        sim.deciding?.gate.startsWith('Engine')
          ? sim.deciding.reason
          : sim.gates
              .filter((g) => g.verdict === 'deny' && g.gate !== 'Timelock')
              .map((g) => `${g.gate}: ${g.reason}`)
              .join('; ')
      }.`,
      'Explain the denial to the user; do not work around it.',
    )
  const otherDenies = sim.gates.filter((g) => g.verdict === 'deny' && g.gate !== 'Timelock')
  const t = await mergedTimelock(config, ctx, sim.timelock.address, sim.timelock.ids)
  const now = await blockTime()
  const start = now > t.configuredAt ? now : t.configuredAt
  return {
    ok: true,
    timelock: sim.timelock.address,
    callHash: sim.callHash,
    delay: t.delay,
    readyAt: start + t.delay,
    window: t.window,
    cancellers: t.cancellers.map(ctx.names),
    warnings: otherDenies.map((g) => `${g.gate} denies it now: ${g.reason}. Check it again before exec.`),
  }
}

export type QueueStatus = 'waiting' | 'ready' | 'expired' | 'void'

export type QueueEntry = {
  callHash: Hex
  timelock: Address
  planId?: string
  intent?: string
  to: Address
  value: bigint
  data: Hex
  operation: number
  scheduledAt: string
  status: QueueStatus
  readyAt: string
  countdown?: string
  expiresAt?: string
  frozenUntil?: string
  next: string
}

export async function scheduleState(
  config: Config,
  ctx: V2Context,
  timelock: Address,
  schedule: Schedule,
  now: bigint,
  planId?: string,
): Promise<Pick<QueueEntry, 'status' | 'readyAt' | 'countdown' | 'expiresAt' | 'frozenUntil' | 'next'>> {
  const t = await mergedTimelock(config, ctx, timelock, schedule.attachmentIds)
  const start = schedule.scheduledAt > t.configuredAt ? schedule.scheduledAt : t.configuredAt
  const readyAt = start + t.delay
  const expiresAt = t.window ? readyAt + t.window : undefined
  const frozen = now < t.frozenUntil
  const id = planId ?? '<plan id>'
  const base = {
    readyAt: isoTime(readyAt),
    ...(expiresAt !== undefined ? { expiresAt: isoTime(expiresAt) } : {}),
    ...(frozen ? { frozenUntil: isoTime(t.frozenUntil) } : {}),
  }
  if (!schedule.isConfiguration && schedule.scheduledAt < t.frozenUntil)
    return {
      ...base,
      status: 'void',
      next: frozen
        ? `voided by a freeze (frozen until ${isoTime(t.frozenUntil)}): schedule ${id} again after it ends`
        : `voided by a freeze: schedule ${id} again (it replaces this one)`,
    }
  if (expiresAt !== undefined && now > expiresAt)
    return { ...base, status: 'expired', next: `expired: schedule ${id} again (it replaces this one)` }
  if (now < readyAt)
    return {
      ...base,
      status: 'waiting',
      countdown: countdown(readyAt - now),
      next: `wait ${countdown(readyAt - now)}, then simulate ${id} and exec ${id}`,
    }
  return {
    ...base,
    status: 'ready',
    next: `ready: simulate ${id}, then exec ${id}${expiresAt !== undefined ? ` before ${isoTime(expiresAt)}` : ''}`,
  }
}

/** Most public RPCs cap eth_getLogs at 50k blocks. */
const LOG_CHUNK = 49_999n

type ScheduledCall = { timelock: Address; txHash: Hex; actor: Address; call: ModuleTx; blockNumber: bigint }

/** The Timelock policies of this Safe (its attachments), plus the deployment's. */
function timelocksOf(ctx: V2Context, model: Model): Address[] {
  const all = model.attachments.filter((a) => model.kindOf(a) === 'timelock').map((a) => a.policy)
  if (ctx.deployment) all.push(ctx.deployment.policies.timelock)
  return [...new Map(all.map((a) => [a.toLowerCase(), getAddress(a)])).values()]
}

/** `Scheduled` events of this engine and Safe, optionally for one hash. */
export async function scanScheduled(
  config: Config,
  ctx: V2Context,
  model: Model,
  opts: { fromBlock?: bigint; txHash?: Hex } = {},
): Promise<{ from: bigint; to: bigint; found: ScheduledCall[] }> {
  const head = await client().getBlockNumber({ cacheTime: 0 })
  const lookback = BigInt(config.lookbackBlocks)
  const from = opts.fromBlock ?? ctx.deployment?.fromBlock ?? (head > lookback ? head - lookback : 0n)
  const event = timelockPolicyAbi.find((e) => e.type === 'event' && e.name === 'Scheduled')!
  const found: ScheduledCall[] = []
  for (const timelock of timelocksOf(ctx, model)) {
    for (let start = from; start <= head; start += LOG_CHUNK + 1n) {
      const end = start + LOG_CHUNK > head ? head : start + LOG_CHUNK
      const logs = await client().getLogs({
        address: timelock,
        event,
        args: { engine: ctx.engine, safe: config.safe },
        fromBlock: start,
        toBlock: end,
      })
      for (const log of logs) {
        const a = log.args
        if (opts.txHash && a.txHash?.toLowerCase() !== opts.txHash.toLowerCase()) continue
        found.push({
          timelock,
          txHash: a.txHash!,
          actor: getAddress(a.actor!),
          call: {
            to: getAddress(a.to!),
            value: a.value!,
            data: a.data!,
            operation: Number(a.operation) as ModuleTx['operation'],
          },
          blockNumber: log.blockNumber ?? 0n,
        })
      }
    }
  }
  return { from, to: head, found }
}

/** The role's schedules still stored in a Timelock. */
export async function readQueue(config: Config, ctx: V2Context, fromBlock?: bigint) {
  const model = await loadModel(config, ctx)
  const { from, to, found } = await scanScheduled(config, ctx, model, { fromBlock })
  const latest = new Map<string, ScheduledCall>()
  for (const s of found.filter((f) => isAddressEqual(f.actor, config.role)))
    latest.set(`${s.timelock}:${s.txHash}`, s)
  const live = (
    await Promise.all(
      [...latest.values()].map(async (s) => {
        const schedule = await readSchedule(s.timelock, ctx.engine, config.safe, s.txHash)
        return schedule && isAddressEqual(schedule.actor, config.role) ? { ...s, schedule } : undefined
      }),
    )
  ).filter((x) => x !== undefined)
  return { from, to, live }
}

// ---------------------------------------------------------------------------------------------
// Signed actions other than exec: schedule, cancel, approve, freeze, lift
// ---------------------------------------------------------------------------------------------

export type V2Action =
  | { type: 'schedule'; planId: string; tx: ModuleTx }
  | { type: 'cancel'; txHash: Hex }
  | { type: 'approve'; txHash: Hex; validUntil: string }
  | { type: 'freeze'; ids: Hex[] }
  | { type: 'lift'; id?: Hex }

export type PreparedAction =
  | {
      ok: true
      title: string
      intent: string
      lines: string[]
      call: {
        address: Address
        abi: typeof timelockPolicyAbi | typeof coSignerPolicyAbi
        functionName: string
        args: readonly unknown[]
      }
    }
  | { ok: false; reason: string; hint?: string }

/** What a scheduled call is, from its `Scheduled` event, for the y/N prompt. */
async function describeScheduled(config: Config, ctx: V2Context, model: Model, txHash: Hex) {
  try {
    const { found } = await scanScheduled(config, ctx, model, { txHash })
    const s = found.at(-1)
    if (!s) return undefined
    return `${s.actor === '0x0000000000000000000000000000000000000001' ? 'owners' : ctx.names(s.actor)} → ${ctx.names(s.call.to)}.${
      s.call.data.length >= 10 ? selectorName(s.call.data.slice(0, 10) as Hex) : '(plain call)'
    } value ${s.call.value} data ${s.call.data.length > 74 ? `${s.call.data.slice(0, 74)}…` : s.call.data}`
  } catch {
    return undefined
  }
}

/**
 * Validates an action for this role against the chain and builds the contract call. The signer
 * runs it before signing (the CLI's earlier answer is only a preview); nothing here trusts the
 * caller's addresses: the policy contracts come from the Safe's own attachments.
 */
export async function prepareAction(
  config: Config,
  ctx: V2Context,
  action: V2Action,
): Promise<PreparedAction> {
  const fail = (reason: string, hint?: string): PreparedAction => ({
    ok: false,
    reason,
    ...(hint ? { hint } : {}),
  })
  const model = await loadModel(config, ctx)
  const now = await blockTime()
  const role = config.role
  switch (action.type) {
    case 'schedule': {
      const check = await scheduleCheck(config, ctx, action.tx, action.planId)
      if (!check.ok) return fail(check.reason, check.hint)
      return {
        ok: true,
        title: 'Schedule request (Timelock)',
        intent: `schedule plan ${action.planId}`,
        lines: [
          `Schedule  delay ${duration(check.delay)}, executable from ~${isoTime(check.readyAt)}` +
            (check.window ? `, for ${duration(check.window)}` : ''),
          `CallHash  ${check.callHash}`,
          `Cancellers ${check.cancellers.join(', ') || '(none besides this role)'}`,
          'Nothing moves now: this only starts the delay. The owners see it (Scheduled event).',
          ...check.warnings.map((w) => `⚠️  ${w}`),
        ],
        call: {
          address: check.timelock,
          abi: timelockPolicyAbi,
          functionName: 'scheduleModuleTx',
          args: [ctx.engine, config.safe, action.tx.to, action.tx.value, action.tx.data, action.tx.operation],
        },
      }
    }
    case 'cancel': {
      for (const timelock of timelocksOf(ctx, model)) {
        const s = await readSchedule(timelock, ctx.engine, config.safe, action.txHash)
        if (!s) continue
        const states = await Promise.all(
          s.attachmentIds.map((id) => readTimelock(timelock, ctx.engine, config.safe, id)),
        )
        const own = isAddressEqual(s.actor, role)
        const canceller = states.some((t) => t.cancellers.some((c) => isAddressEqual(c, role)))
        if (!own && !canceller)
          return fail(
            'This role neither made this schedule nor is a canceller of the attachments it matched.',
            'Only the scheduling module or a listed canceller can cancel it.',
          )
        if (!own && s.isConfiguration)
          return fail(
            "This schedule is an owners' configuration change: listed cancellers cannot cancel it.",
            'Only the owners cancel their own engine.configure (cancelAsOwners).',
          )
        const ownersPath = isAddressEqual(s.actor, OWNERS)
        const what = await describeScheduled(config, ctx, model, action.txHash)
        return {
          ok: true,
          title: 'Cancel request (Timelock)',
          intent: `cancel schedule ${action.txHash}`,
          lines: [
            `Schedule  ${action.txHash}, made ${isoTime(s.scheduledAt)} by ${isAddressEqual(s.actor, ANY) ? 'everyone' : ctx.names(s.actor)}`,
            `Call      ${what ?? '(event not found in the scanned blocks)'}`,
            `As        ${own ? 'the module that scheduled it' : 'a canceller'}`,
            `Effect    ${ownersPath ? "final: the owners' signed transaction can never be scheduled again" : 'the module can schedule it again later'}`,
          ],
          call: {
            address: timelock,
            abi: timelockPolicyAbi,
            functionName: 'cancel',
            args: [ctx.engine, config.safe, action.txHash],
          },
        }
      }
      return fail(`No schedule ${action.txHash} for this Safe.`, 'Run safe-role queue.')
    }
    case 'approve': {
      const validUntil = BigInt(action.validUntil)
      if (validUntil <= now) return fail(`validUntil ${isoTime(validUntil)} is not in the future.`)
      const mine: Attachment[] = []
      for (const a of model.attachments.filter((x) => model.kindOf(x) === 'coSigner')) {
        const s = await readCoSigner(a.policy, ctx.engine, config.safe, a.attachmentId)
        if (s.approvers.some((ap) => isAddressEqual(ap, role))) mine.push(a)
      }
      const policy = mine[0]?.policy
      if (!policy)
        return fail(
          'This role is not an approver of any Co-signer attachment of this Safe.',
          'Run safe-role policies (duties).',
        )
      const what = await describeScheduled(config, ctx, model, action.txHash)
      return {
        ok: true,
        title: 'Approval request (Co-signer)',
        intent: `approve ${action.txHash} until ${isoTime(validUntil)}`,
        lines: [
          `TxHash    ${action.txHash}`,
          `What      ${what ?? 'unknown: the hash alone does not say what it approves. Approve only a transaction you reviewed.'}`,
          `For       ${mine
            .filter((a) => isAddressEqual(a.policy, policy))
            .map((a) => scopeLabel(a.scope, role, ctx.names))
            .join(', ')}`,
          `Until     ${isoTime(validUntil)} (consumed by the next execution of this hash)`,
        ],
        call: {
          address: policy,
          abi: coSignerPolicyAbi,
          functionName: 'approve',
          args: [ctx.engine, config.safe, action.txHash, validUntil],
        },
      }
    }
    case 'freeze':
    case 'lift': {
      const timelocks = await readTimelocks(config, ctx, model, () => true)
      const isIn = (list: Address[]) => list.some((x) => isAddressEqual(x, role))
      const label = (a: Attachment) => scopeLabel(a.scope, role, ctx.names)
      if (action.type === 'freeze') {
        const guarded = timelocks.filter(({ t }) => isIn(t.guardians))
        const wanted = action.ids.length
          ? action.ids.map(
              (id) => guarded.find(({ a }) => a.attachmentId.toLowerCase() === id.toLowerCase()) ?? id,
            )
          : guarded
        const missing = wanted.filter((w): w is Hex => typeof w === 'string')
        if (missing.length)
          return fail(
            `This role is not a guardian of ${missing.join(', ')}.`,
            'Run safe-role policies (duties).',
          )
        const targets = wanted.filter((w): w is (typeof guarded)[number] => typeof w !== 'string')
        if (!targets.length)
          return fail('This role is not a guardian of any Timelock attachment of this Safe.')
        // Freezes are bounded per actor: the first freeze of an actor's attachments opens its
        // window (F); later ones join it (same end); after it, none for C.
        const windows = await Promise.all(
          targets.map(async ({ a }) => {
            const [end, cooldownUntil] = await client().readContract({
              address: a.policy,
              abi: timelockPolicyAbi,
              functionName: 'actorWindow',
              args: [ctx.engine, config.safe, a.scope.actor],
            })
            return { end: BigInt(end), cooldownUntil: BigInt(cooldownUntil) }
          }),
        )
        const actorCooling = (i: number) => now >= windows[i]!.end && now < windows[i]!.cooldownUntil
        const fresh = targets.filter(({ t }, i) => now >= t.cooldownUntil && !actorCooling(i))
        if (!fresh.length)
          return fail(
            'Every target is already frozen or cooling down (the attachment, or its actor): a freeze would be skipped.',
            'Run safe-role status for the freeze state.',
          )
        const timelock = fresh[0]!.a.policy
        const ids = fresh.filter(({ a }) => isAddressEqual(a.policy, timelock))
        const F = await client().readContract({
          address: timelock,
          abi: timelockPolicyAbi,
          functionName: 'MAX_FREEZE',
        })
        const untilOf = (x: (typeof targets)[number]) => {
          const w = windows[targets.indexOf(x)]!
          return now < w.end ? { until: w.end, joins: true } : { until: now + F, joins: false }
        }
        return {
          ok: true,
          title: 'FREEZE request (Timelock guardian)',
          intent: `freeze ${ids.map(({ a }) => label(a)).join(', ')}`,
          lines: [
            ...ids.map((x) => {
              const { until, joins } = untilOf(x)
              return (
                `Freeze    ${label(x.a)} (${x.a.attachmentId}) until ${isoTime(until)}` +
                (joins ? " (joins the actor's open freeze window)" : ` (${duration(F)})`)
              )
            }),
            'Unless lifted earlier. Stops new transactions of this actor: every call these attachments match is',
            'denied while frozen, and their schedules made before are void. Allowances, operator rights and',
            'pre-signed orders stay usable: revoke them separately.',
            ...targets
              .filter((x) => !fresh.includes(x))
              .map(({ a }) => `Skipped   ${label(a)}: frozen or cooling down`),
          ],
          call: {
            address: timelock,
            abi: timelockPolicyAbi,
            functionName: 'freeze',
            args: [ctx.engine, config.safe, ids.map(({ a }) => a.attachmentId)],
          },
        }
      }
      const liftable = timelocks.filter(
        ({ t }) => (isIn(t.guardians) || isIn(t.lifters)) && now < t.frozenUntil,
      )
      const target = action.id
        ? liftable.find(({ a }) => a.attachmentId.toLowerCase() === action.id!.toLowerCase())
        : liftable.length === 1
          ? liftable[0]
          : undefined
      if (!target)
        return fail(
          action.id
            ? `${action.id} is not frozen, or this role is neither its guardian nor a lifter.`
            : liftable.length
              ? `Several frozen attachments: ${liftable.map(({ a }) => `${label(a)} ${a.attachmentId}`).join('; ')}.`
              : 'Nothing frozen that this role can lift.',
          liftable.length > 1 ? 'Pass the attachment id to lift.' : 'Run safe-role status.',
        )
      const C = await client().readContract({
        address: target.a.policy,
        abi: timelockPolicyAbi,
        functionName: 'COOLDOWN',
      })
      return {
        ok: true,
        title: 'LIFT request (Timelock)',
        intent: `lift ${label(target.a)}`,
        lines: [
          `Lift      ${label(target.a)} (${target.a.attachmentId}), frozen until ${isoTime(target.t.frozenUntil)}`,
          `Then      cooldown until ${isoTime(now + C)}: it cannot be frozen again before`,
        ],
        call: {
          address: target.a.policy,
          abi: timelockPolicyAbi,
          functionName: 'lift',
          args: [ctx.engine, config.safe, target.a.attachmentId],
        },
      }
    }
  }
}

/** Decodes a revert of a prepared action (the signer's pre-send simulation). */
export function describeActionError(error: unknown, ctx: V2Context, model?: Model): string {
  const decoded = decodeV2Error(revertDataOf(error))
  if (!decoded) return describeError(error)
  return errorText(decoded, {
    names: ctx.names,
    tokenOf,
    attachment: model?.label ?? ((id) => `attachment ${id}`),
  })
}

export { loadModel as loadV2Model }
