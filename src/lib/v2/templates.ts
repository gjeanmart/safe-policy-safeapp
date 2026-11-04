import { type Address, type Hex, isAddressEqual } from 'viem'
import type { Attachment } from './attachments'
import { type Change, allowChange, changeAttachmentId, policyChange } from './changes'
import { SELECTORS, SPEND_SELECTORS, type V2Deployment, policyNameOf } from './policies'
import { weakerOps } from './rev3/opmask'
import { ANY, OP_DELEGATECALL, OWNERS, type Scope, anyCall, onContract, onFunction } from './scopes'
import {
  DAY,
  HOUR,
  type LabelContext,
  MONTH,
  type PolicySettings,
  type TimelockSettings,
  type TokenLimit,
  WEEK,
  addressLabel,
  amountLabel,
  decodeSettings,
  durationLabel,
  periodLabel,
  recipientsConstraints,
  settingsLabel,
  spendersConstraints,
} from './settings'

/**
 * Ready-made set-ups (DESIGN §9.6, SPEC.md §5): each template is a function of its parameters
 * returning `Change[]`; the builder merges them into the draft and the lint panel checks the
 * result. Timeline parameters follow SPEC.md §5.1: T (owners) < R (recovery) < F (max freeze).
 *
 * @example
 * templates.owners.build(deployment, { delay: DAY, guardians: [G] }, context)
 * // → Allow (Owners, *) · Timelock 24h, guardians G at (Owners, *)
 * templates.opsPayments.build(deployment, { ops, token: USDC, recipients: [A, B], amount: 5_000_000_000n }, context)
 * // → Allow (Ops, USDC.transfer) · Conditions to A, B there · Budget 5,000 USDC / month at (Ops, *)
 */

export type TemplateContext = {
  safe: Address
  /** The configuration the template lands on (current + draft), e.g. to add a lifter to the owners' Timelock. */
  attachments: readonly Attachment[]
}

export type Template<P> = {
  id: string
  title: string
  summary: string
  build: (deployment: V2Deployment, params: P, context: TemplateContext) => Change[]
}

export const TIMELOCK_PRESETS = [
  { label: 'none (kill switch)', seconds: 0 },
  { label: '5 min', seconds: 5 * 60 },
  { label: '1h', seconds: HOUR },
  { label: '24h', seconds: DAY },
  { label: '72h', seconds: 3 * DAY },
] as const

export const PERIOD_PRESETS = [
  { label: 'per day', seconds: BigInt(DAY) },
  { label: 'per week', seconds: BigInt(WEEK) },
  { label: 'per month (30 days)', seconds: BigInt(MONTH) },
  { label: 'one-time', seconds: 0n },
] as const

const timelockAt = (
  deployment: V2Deployment,
  scope: Scope,
  settings: Partial<TimelockSettings> & { delay: number },
  opMask?: number,
): Change =>
  policyChange(
    deployment,
    scope,
    { policy: 'timelock', settings: { window: 0, guardians: [], lifters: [], cancellers: [], ...settings } },
    opMask,
  )

const timelock = (
  deployment: V2Deployment,
  actor: Address,
  settings: Partial<TimelockSettings> & { delay: number },
): Change => timelockAt(deployment, anyCall(actor), settings)

/** A guardian's kill switch on an actor: Timelock delay 0 at (actor, *), no schedule needed. */
export const killSwitch = (
  deployment: V2Deployment,
  actor: Address,
  guardians: readonly Address[],
): Change[] => (guardians.length ? [timelock(deployment, actor, { delay: 0, guardians })] : [])

// ---------------------------------------------------------------------------------------------

export type OwnersParams = {
  /** Who gets the delayed Allow; default the owners. */
  actor?: Address
  /** T, seconds. Default 24h. */
  delay?: number
  guardians: readonly Address[]
  /** May lift only (e.g. the recovery module). */
  lifters?: readonly Address[]
  /** May cancel an owners' schedule (e.g. another Safe), besides the owners' own signatures. */
  cancellers?: readonly Address[]
}

const owners: Template<OwnersParams> = {
  id: 'owners',
  title: 'Delay + freeze: any call, after a delay, guardians can freeze',
  summary:
    'The actor may call anything, but every call waits the delay T after it is scheduled. Guardians can freeze the actor at once (for at most F). On the Owners, configuration changes (engine.configure) wait too.',
  build: (deployment, { actor = OWNERS, delay = DAY, guardians, lifters = [], cancellers = [] }) => [
    allowChange(anyCall(actor)),
    timelock(deployment, actor, { delay, guardians, lifters, cancellers }),
  ],
}

export type EveryoneDelayParams = {
  /** T, seconds. */
  delay: number
  cancellers?: readonly Address[]
}

const everyone: Template<EveryoneDelayParams> = {
  id: 'everyone',
  title: 'Delay for everyone: every transaction waits',
  summary:
    'A Timelock at (Everyone, any call): every transaction, from the owners or from any module, must be scheduled and waits T. It grants nothing (each actor still needs its Allow) and has no guardians (a freeze targets one actor: add a Delay + freeze on that actor).',
  build: (deployment, { delay, cancellers = [] }) => [timelock(deployment, ANY, { delay, cancellers })],
}

export type OpsPaymentsParams = {
  ops: Address
  token: Address
  recipients: readonly Address[]
  /** Budget in base units. */
  amount: bigint
  /** Seconds; default 30 days. */
  period?: bigint
  /** Kill switch on the ops actor. */
  guardians?: readonly Address[]
}

const opsPayments: Template<OpsPaymentsParams> = {
  id: 'ops-payments',
  title: 'Payments: one token, listed recipients, a budget per period',
  summary:
    'The actor (a key, an agent, another Safe…) transfers one token to listed recipients only, within a budget per period. Optional guardians can stop it at once.',
  build: (deployment, { ops, token, recipients, amount, period = BigInt(MONTH), guardians = [] }) => {
    const scope = onFunction(ops, token, SELECTORS.transfer)
    return [
      allowChange(scope),
      policyChange(deployment, scope, {
        policy: 'args',
        settings: { constraints: recipientsConstraints(recipients), strict: false },
      }),
      policyChange(deployment, anyCall(ops), {
        policy: 'limit',
        settings: { limits: [{ token, amount, period }], passUnpriced: false },
      }),
      ...killSwitch(deployment, ops, guardians),
    ]
  },
}

export type AgentCowParams = {
  agent: Address
  /** Budget per sell token: the approval to the vault relayer is the spend. */
  budgets: readonly TokenLimit[]
  vaultRelayer: Address
  settlement: Address
  /** Empty: no co-signer. */
  approvers: readonly Address[]
  /** Empty: no kill switch. */
  guardians: readonly Address[]
}

const agentCow: Template<AgentCowParams> = {
  id: 'agent-cow',
  title: 'CoW swaps: capped approval, pre-sign, budget, optional co-signer and kill switch',
  summary:
    'The actor approves the CoW vault relayer (capped) and pre-signs orders. The approvals count against a budget; the order itself is opaque (passUnpriced). With co-signers, every transaction needs one of them; with guardians, any of them can stop the agent at once.',
  build: (deployment, { agent, budgets, vaultRelayer, settlement, approvers, guardians }) => [
    ...budgets.flatMap((b) => {
      const scope = onFunction(agent, b.token, SELECTORS.approve)
      return [
        allowChange(scope),
        policyChange(deployment, scope, {
          policy: 'args',
          settings: { constraints: spendersConstraints([vaultRelayer], b.amount), strict: true },
        }),
      ]
    }),
    allowChange(onFunction(agent, settlement, SELECTORS.setPreSignature)),
    policyChange(deployment, anyCall(agent), {
      policy: 'limit',
      settings: { limits: budgets, passUnpriced: true },
    }),
    ...(approvers.length
      ? [
          policyChange(deployment, anyCall(agent), {
            policy: 'coSigner',
            settings: { approvers, required: 1 },
          }),
        ]
      : []),
    ...killSwitch(deployment, agent, guardians),
  ],
}

export type RecoveryParams = {
  recovery: Address
  /** R, seconds: T < R < F. Default 72h. */
  delay?: number
  /** Also grant `engine.configure` (the way back from a dead co-signer or a rogue guardian). */
  configure?: boolean
  /** Make the recovery a lifter of the owners' Timelock (re-configures it). Default true. */
  lifter?: boolean
}

const recovery: Template<RecoveryParams> = {
  id: 'recovery',
  title: 'Recovery: replace an owner after a long delay R',
  summary:
    "The actor (a recovery module) may replace an owner, after R. No guardian: a freeze of the owners never stops it. It may lift the owners' freeze. The owners stop a rogue recovery by detaching it (T < R).",
  build: (deployment, { recovery, delay = 3 * DAY, configure = false, lifter = true }, context) => {
    const changes: Change[] = [
      // Calls to the Safe (and the engine) need an exact Allow on the module path (F5).
      allowChange(onFunction(recovery, context.safe, SELECTORS.swapOwner)),
      ...(configure ? [allowChange(onFunction(recovery, deployment.engine, SELECTORS.configure))] : []),
      // A module schedule has no nonce: the window keeps a forgotten one from living forever.
      timelock(deployment, recovery, { delay, window: WEEK }),
    ]
    if (lifter) {
      const ownersTimelock = context.attachments.find(
        (a) =>
          isAddressEqual(a.scope.actor, OWNERS) &&
          a.scope.callMatch === 0 &&
          a.settings?.policy === 'timelock',
      )
      if (ownersTimelock?.settings?.policy === 'timelock') {
        const s = ownersTimelock.settings.settings
        if (!s.lifters.some((l) => isAddressEqual(l, recovery)))
          changes.push(timelock(deployment, OWNERS, { ...s, lifters: [...s.lifters, recovery] }))
      }
    }
    return changes
  },
}

export type CommitteeParams = {
  /** A sub-Safe (e.g. 2-of-7 of the same owners) enabled as a module. */
  committee: Address
  token: Address
  recipients: readonly Address[]
  amount: bigint
  period?: bigint
  guardians?: readonly Address[]
}

const committee: Template<CommitteeParams> = {
  id: 'committee',
  title: 'Committee: a sub-Safe as actor with a higher budget',
  summary:
    'Approval tiers without Quorum: a committee Safe (its own owners and threshold) is a module of this Safe, with its own Allow, recipients and a larger budget than the ops key.',
  build: (deployment, { committee, ...rest }, context) =>
    opsPayments.build(deployment, { ops: committee, ...rest }, context),
}

export type AdminDelayParams = {
  /** D, seconds: at least the longest owners' delay elsewhere. */
  delay: number
  guardians?: readonly Address[]
}

/**
 * The owner-path routes out of a narrow delay, delayed D (the covering rule, SPEC.md §5.1):
 * `(Owners, Safe.*)` (guard, module guard, modules, fallback handler, owner management),
 * `(Owners, engine.configure)`, and `(Owners, *)` for DELEGATECALL only. Every other owner call
 * stays instant.
 */
const adminDelay: Template<AdminDelayParams> = {
  id: 'admin-delay',
  title: 'Admin delay: Safe administration, configure and DELEGATECALLs wait D',
  summary:
    "Delays only the ways out of a policy: every call to the Safe itself (guards, modules, fallback handler, owners), engine.configure, and any DELEGATECALL. What a narrower owners' delay (e.g. on one token) needs next to it; every other owner call stays instant. Adds delays only: the owners still need their Allows.",
  build: (deployment, { delay, guardians = [] }, context) => [
    timelockAt(deployment, onContract(OWNERS, context.safe), { delay, guardians }),
    timelockAt(deployment, onFunction(OWNERS, deployment.engine, SELECTORS.configure), { delay, guardians }),
    timelockAt(deployment, anyCall(OWNERS), { delay, guardians }, OP_DELEGATECALL),
  ],
}

export type FunctionDelayParams = {
  /** The contract, e.g. USDC. */
  to: Address
  selector: Hex
  delay: number
  guardians: readonly Address[]
  cancellers?: readonly Address[]
  /** A token: delay all four spend shapes (transfer, transferFrom, approve, increaseAllowance). */
  token?: boolean
}

/**
 * A delay with guardians on one owners' function only (the Spark request): the Admin delay plus
 * `(Owners, to.f)` (each spend selector of a token: delaying `transfer` alone leaves `approve`).
 */
const functionDelay: Template<FunctionDelayParams> = {
  id: 'function-delay',
  title: 'Delay on one function: e.g. USDC transfers wait D, guardians can freeze them',
  summary:
    "The owners' calls to one function wait D, with guardians and optional cancellers; for a token, transfer, transferFrom, approve and increaseAllowance all wait. Includes the Admin delay (Safe administration, configure, DELEGATECALLs) with the same guardians, so the delay cannot be removed faster, nor while a guardian freezes it. Other owner calls stay instant; other actors are not delayed.",
  build: (deployment, { to, selector, delay, guardians, cancellers = [], token = false }, context) => [
    // The guardians go on the covers too: the owners' configure (removing this delay) matches those.
    ...adminDelay.build(deployment, { delay, guardians }, context),
    ...(token ? SPEND_SELECTORS : [selector]).map((f) =>
      timelockAt(deployment, onFunction(OWNERS, to, f), { delay, guardians, cancellers }),
    ),
  ],
}

export const templates = {
  owners,
  everyone,
  adminDelay,
  functionDelay,
  opsPayments,
  agentCow,
  recovery,
  committee,
}

// ---------------------------------------------------------------------------------------------
// Replacing an existing attachment with a weaker one (review B3)
// ---------------------------------------------------------------------------------------------

export type WeakerReplacement = { change: Change; existing: Attachment; reasons: string[] }

const tokenName = (token: Address, ctx: LabelContext) =>
  BigInt(token) === 0n ? 'the native token' : (ctx.tokenOf?.(token)?.symbol ?? addressLabel(token, ctx))

const missing = (before: readonly Address[], after: readonly Address[]) =>
  before.filter((x) => !after.some((y) => isAddressEqual(x, y)))

/** Why `next` protects less than `before` (same policy), or nothing. */
function weakerReasons(before: PolicySettings, next: PolicySettings, ctx: LabelContext): string[] {
  const reasons: string[] = []
  if (before.policy === 'timelock' && next.policy === 'timelock') {
    const [a, b] = [before.settings, next.settings]
    if (b.delay < a.delay) reasons.push(`delay ${durationLabel(a.delay)} → ${durationLabel(b.delay)}`)
    if (missing(a.guardians, b.guardians).length) reasons.push('fewer guardians')
    if (missing(a.lifters, b.lifters).length) reasons.push('fewer lifters')
    if (missing(a.cancellers, b.cancellers).length) reasons.push('fewer cancellers')
  } else if (before.policy === 'limit' && next.policy === 'limit') {
    const [a, b] = [before.settings, next.settings]
    for (const l of a.limits) {
      const m = b.limits.find((x) => isAddressEqual(x.token, l.token))
      // A one-time budget (period 0) never refills: any period is weaker; otherwise a longer one is.
      const longer = m && m.period !== 0n && (l.period === 0n || m.period > l.period)
      if (!m) reasons.push(`no budget for ${tokenName(l.token, ctx)}`)
      else if (m.amount > l.amount || longer)
        reasons.push(
          `budget ${amountLabel(l.token, l.amount, ctx)} ${periodLabel(l.period)} → ${amountLabel(m.token, m.amount, ctx)} ${periodLabel(m.period)}`,
        )
    }
    if (b.passUnpriced && !a.passUnpriced) reasons.push('other calls now pass')
  } else if (before.policy === 'args' && next.policy === 'args') {
    if (before.settings.strict && !next.settings.strict) reasons.push('other calls no longer denied')
  } else if (before.policy === 'coSigner' && next.policy === 'coSigner') {
    const [a, b] = [before.settings, next.settings]
    if (b.required < a.required) reasons.push(`${a.required} → ${b.required} approvals required`)
    if (missing(a.approvers, b.approvers).length) reasons.push('fewer approvers')
  }
  return reasons
}

/**
 * The changes of a template that re-configure an existing attachment with weaker settings (a lower
 * delay, a higher budget, fewer guardians or approvers, `strict` off, `passUnpriced` on, an
 * operation dropped from the op mask, e.g. `(Owners, *)` turned DELEGATECALL-only): the UI
 * shows "replaces X (weaker)" and asks for a confirmation before adding them.
 */
export function weakerReplacements(
  changes: readonly Change[],
  attachments: readonly Attachment[],
  deployment: V2Deployment,
  ctx: LabelContext = {},
): WeakerReplacement[] {
  const found: WeakerReplacement[] = []
  for (const change of changes) {
    if (change.detach) continue
    const existing = attachments.find((a) => a.attachmentId === changeAttachmentId(change))
    if (!existing) continue
    // Same id, so same scope, kind and policy; the op mask can still narrow (review rev 4, S3).
    const reasons = weakerOps(change.kind, existing.opMask, change.opMask)
    const name = policyNameOf(deployment, change.policy)
    if (existing.settings && name) {
      try {
        reasons.push(...weakerReasons(existing.settings, decodeSettings(name, change.settings), ctx))
      } catch {
        // Undecodable settings: validateChanges reports them.
      }
    }
    if (reasons.length) found.push({ change, existing, reasons })
  }
  return found
}

/** `Timelock 72h, guardians G (weaker: delay 72h → 0s)`. */
export const weakerLabel = (w: WeakerReplacement, ctx: LabelContext = {}): string =>
  `replaces ${w.existing.settings ? settingsLabel(w.existing.settings, ctx) : 'an attachment'} (weaker: ${w.reasons.join(', ')})`

export type TemplateId = keyof typeof templates
