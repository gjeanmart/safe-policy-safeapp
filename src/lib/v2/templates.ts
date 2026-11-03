import { type Address, type Hex, isAddressEqual } from 'viem'
import { type ChangeSet, allowChange, policyChange, roleChange } from './changes'
import { SELECTORS, type V2Deployment } from './policies'
import { ANY, type AttachmentChange, CallMatch, FreezeRole, OWNERS, type Scope } from './scopes'
import { DAY, HOUR, MONTH, type QuorumTier, type TokenLimit, WEEK } from './settings'

/**
 * Ready-made set-ups: the design doc's example table plus the asks from Slack / Notion (Spark,
 * DeFi ops, the shopping list, InfiniFi's approval matrix). Each template is a function of its
 * parameters returning a {@link ChangeSet}; the builder merges it into the draft with
 * `combineChangeSets` and the lint panel checks the result.
 *
 * @example
 * const set = templates.ownersTimelock.build(deployment, { delay: 24 * HOUR })
 * // → Allow (Owners, *) · Timelock 24h at (Owners, *) · Freeze (Safe-wide) at (Owners, *)
 * const ops = templates.opsPayments.build(deployment, {
 *   ops: OPS_KEY, token: USDC, recipients: [VENDOR_A, VENDOR_B], amount: 5_000_000_000n, period: MONTH,
 * })
 * // → Allow (Ops, USDC.transfer) · Recipients there · Limit 5,000 USDC / month at (Ops, *) · Freeze at (Ops, *)
 */

export type Template<P> = {
  id: string
  title: string
  summary: string
  /** Where the ask comes from (design doc table, Slack thread, ...). */
  source: string
  build: (deployment: V2Deployment, params: P) => ChangeSet
}

/** UI presets (SPEC/plan: 1h / 24h / 72h). */
export const TIMELOCK_PRESETS = [
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

const anyCall = (actor: Address): Scope => ({
  actor,
  to: ANY,
  selector: '0x00000000',
  callMatch: CallMatch.ANY,
})
const onContract = (actor: Address, to: Address): Scope => ({
  actor,
  to,
  selector: '0x00000000',
  callMatch: CallMatch.TO,
})
const exact = (actor: Address, to: Address, selector: Hex): Scope => ({
  actor,
  to,
  selector,
  callMatch: CallMatch.TO_SELECTOR,
})

/**
 * FreezePolicy where D2 puts it: the owners read the Safe-wide freeze only (they are never frozen
 * per actor, SPEC §7.1), other actors read both. Never attach it to a Recovery actor.
 */
export const freezeFor = (deployment: V2Deployment, actor: Address): AttachmentChange =>
  policyChange(deployment, anyCall(actor), {
    policy: 'freeze',
    settings: { safeWide: true, actor: !isAddressEqual(actor, OWNERS) },
  })

// ---------------------------------------------------------------------------------------------

export type OwnersTimelockParams = {
  /** Seconds; must not exceed the engine's DELAY (the engine enforces it). Default 24h. */
  delay?: number
  /** Extra cancellers besides the owners' rising-threshold cancel. */
  cancellers?: readonly Address[]
}

const ownersTimelock: Template<OwnersTimelockParams> = {
  id: 'owners-timelock',
  title: 'Owners: Allow + Timelock 24h',
  summary:
    'Owners can do anything after a delay; the guardian freeze clears their queue. Fixes WA-4014: every owner call, setGuard included, waits.',
  source: 'Design doc example set-up, row (Owners, *)',
  build: (deployment, { delay = DAY, cancellers = [] }) => ({
    changes: [
      allowChange(anyCall(OWNERS)),
      policyChange(deployment, anyCall(OWNERS), {
        policy: 'timelock',
        settings: { delay, window: 0, clearOnFreeze: true, cancellers },
      }),
      freezeFor(deployment, OWNERS),
    ],
    roles: [],
  }),
}

export type OpsPaymentsParams = {
  ops: Address
  token: Address
  recipients: readonly Address[]
  /** Budget in the token's base units. */
  amount: bigint
  /** Seconds; default 30 days. */
  period?: bigint
}

const opsPayments: Template<OpsPaymentsParams> = {
  id: 'ops-payments',
  title: 'Ops payments: Allow token.transfer + Recipients + Limit',
  summary: 'An ops key pays listed vendors in one token, within a budget, frozen with the rest of the Safe.',
  source: 'Design doc example set-up, rows (Ops, *) and (Ops, USDC.transfer)',
  build: (deployment, { ops, token, recipients, amount, period = BigInt(MONTH) }) => ({
    changes: [
      allowChange(exact(ops, token, SELECTORS.transfer)),
      policyChange(deployment, exact(ops, token, SELECTORS.transfer), {
        policy: 'recipients',
        settings: { recipients, spenders: [], maxApproval: 0n, strict: false },
      }),
      policyChange(deployment, anyCall(ops), {
        policy: 'limit',
        settings: { limits: [{ token, amount, period }], passUnpriced: false },
      }),
      freezeFor(deployment, ops),
    ],
    roles: [],
  }),
}

export type AgentCowParams = {
  agent: Address
  /** Budget per sell token (an order spends `sellAmount + feeAmount`, an approval reserves). */
  budgets: readonly TokenLimit[]
  /** CoW's GPv2VaultRelayer: the only spender the agent may approve. */
  vaultRelayer: Address
  cosigner: Address
}

const agentCow: Template<AgentCowParams> = {
  id: 'agent-cow',
  title: 'Agent: Allow CoW + Limit + Co-signer',
  summary:
    'An AI agent signs CoW orders (through PolicySignLib, so the order fields are priced) and approves the vault relayer, within a budget, with a co-signer and its own kill switch.',
  source:
    'Design doc example set-up, rows (Agent, *) and (Agent, CoW calls); shopping list "agent kill switch"',
  build: (deployment, { agent, budgets, vaultRelayer, cosigner }) => ({
    changes: [
      allowChange(exact(agent, deployment.signLib, SELECTORS.signCowOrder)),
      ...budgets.map((b) => allowChange(exact(agent, b.token, SELECTORS.approve))),
      policyChange(deployment, anyCall(agent), {
        policy: 'recipients',
        settings: {
          recipients: [],
          spenders: [vaultRelayer],
          // Approvals are token-agnostic here: cap them at the largest budget, never unlimited.
          maxApproval: budgets.reduce((max, b) => (b.amount > max ? b.amount : max), 0n),
          strict: true,
        },
      }),
      policyChange(deployment, anyCall(agent), {
        policy: 'limit',
        settings: { limits: budgets, passUnpriced: false },
      }),
      policyChange(deployment, anyCall(agent), { policy: 'coSigner', settings: { cosigner } }),
      freezeFor(deployment, agent),
    ],
    roles: [],
  }),
}

export type RecoveryParams = {
  safe: Address
  recovery: Address
  /** Seconds; T < R < F: longer than the owners' timelock, shorter than MAX_FREEZE. Default 72h. */
  delay?: number
  /** Owner-management selectors granted; default `swapOwner` only. */
  selectors?: readonly Hex[]
  /** Also make the recovery key a lifter (it may end a freeze early). Default true. */
  lifter?: boolean
}

const recovery: Template<RecoveryParams> = {
  id: 'recovery',
  title: 'Recovery: Timelock 72h + Allow swapOwner',
  summary:
    'A recovery module replaces an owner after 72h. No Freeze attached: recovery passes a freeze because nothing froze it. Owners stop it by removing the module (T < R).',
  source: 'Design doc example set-up, rows (Recovery, *) and (Recovery, Safe.swapOwner)',
  build: (
    deployment,
    { safe, recovery, delay = 3 * DAY, selectors = [SELECTORS.swapOwner], lifter = true },
  ) => ({
    changes: [
      // Calls to the Safe itself need an exact-scope ALLOW on the module path (SPEC §6.4).
      ...selectors.map((selector) => allowChange(exact(recovery, safe, selector))),
      policyChange(deployment, anyCall(recovery), {
        policy: 'timelock',
        // A module schedule has no nonce: a window keeps a forgotten one from living forever.
        settings: { delay, window: WEEK, clearOnFreeze: false, cancellers: [] },
      }),
    ],
    roles: lifter ? [roleChange(FreezeRole.LIFTER, recovery)] : [],
  }),
}

export type GuardianFreezeParams = {
  guardians: readonly Address[]
  /** Accounts that may only lift (e.g. the recovery key). */
  lifters?: readonly Address[]
  /** Actors the freeze covers; default the owners. Never include a Recovery actor. */
  actors?: readonly Address[]
}

const guardianFreeze: Template<GuardianFreezeParams> = {
  id: 'guardian-freeze',
  title: 'Guardian freeze',
  summary:
    'A guardian freezes the Safe (or one agent) instantly for at most 7 days; Freeze is attached to every listed actor. Configuration cannot be applied while frozen.',
  source: 'Shopping list "lockdown, workspace-wide, agent kill switch"; plan D2',
  build: (deployment, { guardians, lifters = [], actors = [OWNERS] }) => ({
    changes: actors.map((actor) => freezeFor(deployment, actor)),
    roles: [
      ...guardians.map((g) => roleChange(FreezeRole.GUARDIAN, g)),
      ...lifters.map((l) => roleChange(FreezeRole.LIFTER, l)),
    ],
  }),
}

export type CancellableTimelockParams = {
  /** Default the owners. */
  actor?: Address
  target: Address
  /** A single function; omit for any function on `target`. */
  selector?: Hex
  /** Seconds; default 24h. At OWNERS it must not exceed the engine's DELAY. */
  delay?: number
  /** Who else may cancel, e.g. another Safe calling `cancel` from its own transaction. */
  cancellers: readonly Address[]
  /** Also grant the call (when the actor has no ALLOW covering it yet). */
  allow?: boolean
}

const cancellableTimelock: Template<CancellableTimelockParams> = {
  id: 'spark-cancellable-timelock',
  title: 'Spark: Timelock cancellable by another Safe',
  summary:
    'Calls to one contract wait a delay; another Safe (or any listed address) can cancel the queued call. The Scheduled event carries the full call for alerts.',
  source: 'Spark via Akshay (#proj-policies)',
  build: (deployment, { actor = OWNERS, target, selector, delay = DAY, cancellers, allow = false }) => {
    const scope = selector ? exact(actor, target, selector) : onContract(actor, target)
    return {
      changes: [
        ...(allow ? [allowChange(scope)] : []),
        policyChange(deployment, scope, {
          policy: 'timelock',
          settings: { delay, window: 0, clearOnFreeze: isAddressEqual(actor, OWNERS), cancellers },
        }),
      ],
      roles: [],
    }
  },
}

export type QuorumParams = {
  /** Base requirement for every owner transaction; usually the Safe's threshold. */
  required: number
  /** E.g. 5 signatures above 10,000 USDC. */
  tiers: readonly QuorumTier[]
}

/**
 * Owner-side restrictions (Co-signer, Safenet, Quorum) at `(Owners, *)` do not reach the
 * configuration path: they must also sit at its exact scopes (SPEC §5.1, §14 D-19), or two owners
 * request a root that detaches them, wait the delay and apply. `invalidateRoot` stays free: it is
 * how the honest owners kill a malicious request.
 */
export const onConfiguration = (deployment: V2Deployment): Scope[] =>
  [SELECTORS.requestConfiguration, SELECTORS.applyConfiguration].map((selector) =>
    exact(OWNERS, deployment.engine, selector),
  )

const quorumLargeTransfers: Template<QuorumParams> = {
  id: 'quorum-large-transfers',
  title: 'Quorum on large transfers',
  summary:
    'Owner transactions moving more than a tier amount (summed over a batch, priced like the transfer budget) need more owner signatures than the threshold; configuration changes need the base quorum too.',
  source: 'zkSync / InfiniFi approval matrix (Notion)',
  build: (deployment, { required, tiers }) => ({
    changes: [
      policyChange(deployment, anyCall(OWNERS), { policy: 'quorum', settings: { required, tiers } }),
      ...onConfiguration(deployment).map((scope) =>
        policyChange(deployment, scope, { policy: 'quorum', settings: { required, tiers: [] } }),
      ),
    ],
    roles: [],
  }),
}

export const templates = {
  ownersTimelock,
  opsPayments,
  agentCow,
  recovery,
  guardianFreeze,
  cancellableTimelock,
  quorumLargeTransfers,
}

export type TemplateId = keyof typeof templates
