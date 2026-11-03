import { type Address, isAddressEqual } from 'viem'
import type { Attachment } from './attachments'
import { type Change, allowChange, policyChange } from './changes'
import { SELECTORS, type V2Deployment } from './policies'
import { OWNERS, anyCall, onFunction } from './scopes'
import {
  DAY,
  HOUR,
  MONTH,
  type TimelockSettings,
  type TokenLimit,
  WEEK,
  recipientsConstraints,
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

const timelock = (
  deployment: V2Deployment,
  actor: Address,
  settings: Partial<TimelockSettings> & { delay: number },
): Change =>
  policyChange(deployment, anyCall(actor), {
    policy: 'timelock',
    settings: { window: 0, guardians: [], lifters: [], cancellers: [], ...settings },
  })

/** A guardian's kill switch on an actor: Timelock delay 0 at (actor, *), no schedule needed. */
export const killSwitch = (
  deployment: V2Deployment,
  actor: Address,
  guardians: readonly Address[],
): Change[] => (guardians.length ? [timelock(deployment, actor, { delay: 0, guardians })] : [])

// ---------------------------------------------------------------------------------------------

export type OwnersParams = {
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
  title: 'Owners: Allow + Timelock with guardians',
  summary:
    "The owners can do anything, after a delay T; configuration (engine.configure) waits too. The guardians can freeze the owners' queue at once.",
  build: (deployment, { delay = DAY, guardians, lifters = [], cancellers = [] }) => [
    allowChange(anyCall(OWNERS)),
    timelock(deployment, OWNERS, { delay, guardians, lifters, cancellers }),
  ],
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
  title: 'Ops payments: Allow token.transfer + Recipients + Budget',
  summary:
    'An ops key pays listed recipients in one token, within a budget per period; a guardian can stop it.',
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
  approvers: readonly Address[]
  guardians: readonly Address[]
}

const agentCow: Template<AgentCowParams> = {
  id: 'agent-cow',
  title: 'Agent CoW: approve + pre-sign, Budget, Co-signer, kill switch',
  summary:
    'An AI agent approves the CoW vault relayer (capped) and pre-signs orders. The approvals count against a budget; the order itself is opaque (passUnpriced). Every transaction needs a co-signer; a guardian can stop the agent at once.',
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
    policyChange(deployment, anyCall(agent), {
      policy: 'coSigner',
      settings: { approvers, required: 1 },
    }),
    timelock(deployment, agent, { delay: 0, guardians }),
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
  title: 'Recovery: Allow swapOwner + Timelock R, no guardian',
  summary:
    "A recovery module replaces an owner after R. No guardian: a freeze of the owners never stops it. It may lift the owners' freeze. The owners stop a rogue recovery by detaching it (T < R).",
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

export const templates = { owners, opsPayments, agentCow, recovery, committee }

export type TemplateId = keyof typeof templates
