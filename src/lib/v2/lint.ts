import { type Address, type Hex, isAddressEqual } from 'viem'
import type { Attachment, Roles } from './attachments'
import {
  OWNER_MANAGEMENT_SELECTORS,
  POLICY_INFO,
  PRICED_SIGN_LIB_SELECTORS,
  PRICED_TOKEN_SELECTORS,
  type V2Deployment,
} from './policies'
import {
  ANY,
  AttachmentKind,
  CallMatch,
  OP_DELEGATECALL,
  OWNERS,
  actorLabel,
  callLabel,
  namesSelector,
  namesTo,
} from './scopes'
import { type LabelContext, type TimelockSettings, durationLabel } from './settings'

/**
 * Lint rules over a (projected) configuration (PLAN §5 "Lint panel"). Pure: give it the
 * attachments after the draft (`projectAttachments`), the roles, the Safe's owners and modules and
 * the engine timings. `block` findings need an explicit confirmation in the UI; `warn` ones are
 * advice.
 *
 * @example
 * lint({ safe, deployment, attachments: [allow(Agent, *)], roles, owners, modules: [agent], engine })
 * // → [{ rule: 'wildcard-allow-module', severity: 'block', message: 'Agent may call anything …', attachmentIds: [id] },
 * //    { rule: 'allow-without-freeze', severity: 'block', message: 'Agent has an Allow and no Freeze …', … }]
 */

export type LintSeverity = 'block' | 'warn'

export type LintRule =
  | 'wildcard-allow-module'
  | 'call-wide-allow-module'
  | 'delegatecall-grant'
  | 'global-policy'
  | 'global-freeze'
  | 'timelock-order'
  | 'delay-below-timelock'
  | 'limit-unpriceable-allow'
  | 'allow-without-freeze'
  | 'freeze-misses-actor'
  | 'freeze-on-recovery'
  | 'safe-target-allow-not-exact'
  | 'quorum-on-module'
  | 'module-timelock-no-window'
  | 'no-guardian'
  | 'owner-can-lift'
  | 'fallback-handler'
  | 'unknown-policy'
  | 'actor-not-module'

export type LintFinding = { rule: LintRule; severity: LintSeverity; message: string; attachmentIds: Hex[] }

export type LintInput = {
  safe: Address
  deployment: V2Deployment
  attachments: readonly Attachment[]
  roles: Roles
  owners: readonly Address[]
  modules: readonly Address[]
  engine: { delay: bigint; maxFreeze: bigint }
  /** The Safe's current fallback handler, if known. */
  fallbackHandler?: Address
  ctx?: LabelContext
}

const isAny = (a: Address) => isAddressEqual(a, ANY)
const isOwners = (a: Address) => isAddressEqual(a, OWNERS)
const same = (a: Address, b: Address) => isAddressEqual(a, b)

const timelockDelay = (a: Attachment): bigint =>
  a.settings?.policy === 'timelock' ? BigInt((a.settings.settings as TimelockSettings).delay) : 0n

/** Actors with an exact ALLOW on the Safe's owner management: the Recovery role(s). */
export function recoveryActors(safe: Address, attachments: readonly Attachment[]): Address[] {
  const found: Address[] = []
  for (const a of attachments) {
    if (
      a.kind === AttachmentKind.ALLOW &&
      !isAny(a.scope.actor) &&
      !isOwners(a.scope.actor) &&
      a.scope.callMatch === CallMatch.TO_SELECTOR &&
      same(a.scope.to, safe) &&
      OWNER_MANAGEMENT_SELECTORS.includes(a.scope.selector.toLowerCase() as Hex) &&
      !found.some((f) => same(f, a.scope.actor))
    )
      found.push(a.scope.actor)
  }
  return found
}

/** Can some call match both scopes (actor, target and selector compatible)? */
const overlaps = (a: Attachment['scope'], b: Attachment['scope']): boolean =>
  (isAny(a.actor) || isAny(b.actor) || same(a.actor, b.actor)) &&
  (!namesTo(a.callMatch) || !namesTo(b.callMatch) || same(a.to, b.to)) &&
  (!namesSelector(a.callMatch) ||
    !namesSelector(b.callMatch) ||
    a.selector.toLowerCase() === b.selector.toLowerCase())

/** Whether LimitPolicy prices every call an ALLOW at this scope grants (SPEC §8.4). */
function isPriceable(scope: Attachment['scope'], signLib: Address): boolean {
  if (!namesSelector(scope.callMatch)) return false
  const selector = scope.selector.toLowerCase() as Hex
  if (BigInt(selector) === 0n) return true // empty calldata: native value only
  if (PRICED_TOKEN_SELECTORS.includes(selector)) return true
  return (
    PRICED_SIGN_LIB_SELECTORS.includes(selector) && (!namesTo(scope.callMatch) || same(scope.to, signLib))
  )
}

/** Runs every rule; `block` findings first. */
export function lint(input: LintInput): LintFinding[] {
  const { safe, deployment, attachments, roles, owners, modules, engine, ctx = {} } = input
  const findings: LintFinding[] = []
  const add = (rule: LintRule, severity: LintSeverity, message: string, ids: Hex[] = []) =>
    findings.push({ rule, severity, message, attachmentIds: ids })
  const who = (actor: Address) => actorLabel(actor, ctx.nameOf)
  const what = (a: Attachment) => callLabel(a.scope, ctx.nameOf)

  const allows = attachments.filter((a) => a.kind === AttachmentKind.ALLOW)
  const policies = attachments.filter((a) => a.kind === AttachmentKind.POLICY)
  const recovery = recoveryActors(safe, attachments)
  const isRecovery = (actor: Address) => recovery.some((r) => same(r, actor))

  // --- Grants ---
  for (const a of allows) {
    const { actor, callMatch } = a.scope
    if (callMatch === CallMatch.ANY && !isOwners(actor)) {
      add(
        'wildcard-allow-module',
        'block',
        isAny(actor)
          ? 'Allow for everyone on any call: every module, present and future, can do anything (calls to the Safe itself excepted)'
          : `${who(actor)} may call anything (any contract, any function). Calls to the Safe itself still need an exact Allow`,
        [a.attachmentId],
      )
    } else if (callMatch === CallMatch.SELECTOR && !isOwners(actor)) {
      add(
        'call-wide-allow-module',
        'warn',
        `${isAny(actor) ? 'Everyone' : who(actor)} may call ${what(a)} on any contract (every token, every vault): pair it with Recipients / Limit / Args`,
        [a.attachmentId],
      )
    }
    if (a.opMask & OP_DELEGATECALL)
      add(
        'delegatecall-grant',
        'block',
        `DELEGATECALL granted to ${who(actor)} on ${what(a)}: the target runs with the Safe's storage and can rewrite its guard, modules and owners`,
        [a.attachmentId],
      )
    if (!isOwners(actor) && a.level !== 7 && namesTo(callMatch) && same(a.scope.to, safe))
      add(
        'safe-target-allow-not-exact',
        'warn',
        `This Allow does not let ${isAny(actor) ? 'modules' : who(actor)} call the Safe itself: that needs an Allow on one actor and one function`,
        [a.attachmentId],
      )
  }

  // --- Global placement ---
  for (const p of policies.filter((p) => isAny(p.scope.actor))) {
    if (p.policyName === 'freeze') {
      add(
        'global-freeze',
        'warn',
        'Freeze for everyone also blocks recovery during a freeze: attach it per actor (Owners, Ops, Agent…) and leave Recovery out',
        [p.attachmentId],
      )
      continue
    }
    const why: Partial<Record<NonNullable<Attachment['policyName']>, string>> = {
      coSigner: 'recovery and every module then depend on the co-signer service',
      safenet: 'recovery and every module then depend on Safenet',
      quorum: 'Quorum denies every module transaction, recovery included',
      timelock: 'it also delays recovery and every module, and binds the configuration delay',
    }
    add(
      'global-policy',
      'block',
      `${p.policyName ? POLICY_INFO[p.policyName].label : 'A policy'} at (Everyone, ${what(p)}) applies to every actor, Recovery included${
        p.policyName && why[p.policyName] ? `: ${why[p.policyName]}` : ''
      }`,
      [p.attachmentId],
    )
  }

  // --- Delays: DELAY ≥ T (engine rule) and T < R < F ---
  const ownersTimelocks = policies.filter(
    (p) => p.policyName === 'timelock' && (isAny(p.scope.actor) || isOwners(p.scope.actor)),
  )
  for (const p of ownersTimelocks) {
    if (timelockDelay(p) > engine.delay)
      add(
        'delay-below-timelock',
        'block',
        `Timelock ${durationLabel(timelockDelay(p))} is longer than the configuration delay ${durationLabel(engine.delay)}: the engine refuses it (owners could otherwise skip it through a configuration change)`,
        [p.attachmentId],
      )
  }
  const ownerWide = ownersTimelocks.filter((p) => p.scope.callMatch === CallMatch.ANY)
  const T = ownerWide.reduce((max, p) => (timelockDelay(p) > max ? timelockDelay(p) : max), 0n)
  for (const r of recovery) {
    const own = policies.filter(
      (p) =>
        p.policyName === 'timelock' &&
        p.scope.callMatch === CallMatch.ANY &&
        (same(p.scope.actor, r) || isAny(p.scope.actor)),
    )
    const R = own.reduce((max, p) => (timelockDelay(p) > max ? timelockDelay(p) : max), 0n)
    const ids = [...own, ...ownerWide].map((p) => p.attachmentId)
    if (R === 0n)
      add(
        'timelock-order',
        'block',
        `${who(r)} can change owners with no delay: attach a Timelock at (${who(r)}, *)`,
        ids,
      )
    else if (R <= T)
      add(
        'timelock-order',
        'block',
        `T < R broken: the owners' timelock (${durationLabel(T)}) is not shorter than ${who(r)}'s (${durationLabel(R)}), so owners cannot remove a rogue recovery in time`,
        ids,
      )
    if (R !== 0n && R >= engine.maxFreeze)
      add(
        'timelock-order',
        'block',
        `R < F broken: ${who(r)}'s timelock (${durationLabel(R)}) outlasts the longest freeze (${durationLabel(engine.maxFreeze)}), so recovery cannot finish while the Safe is frozen`,
        own.map((p) => p.attachmentId),
      )
  }

  // --- Limit next to unpriceable Allows ---
  for (const limit of policies.filter((p) => p.policyName === 'limit')) {
    const passUnpriced = limit.settings?.policy === 'limit' && limit.settings.settings.passUnpriced
    const unpriced = allows.filter(
      (a) => overlaps(a.scope, limit.scope) && !isPriceable(a.scope, deployment.signLib),
    )
    if (unpriced.length === 0) continue
    const list = unpriced.map((a) => `(${who(a.scope.actor)}, ${what(a)})`).join(', ')
    add(
      'limit-unpriceable-allow',
      passUnpriced ? 'block' : 'warn',
      passUnpriced
        ? `The budget at (${who(limit.scope.actor)}, ${what(limit)}) lets unpriced calls pass, and ${list} grants calls it cannot price: they bypass the budget`
        : `The budget at (${who(limit.scope.actor)}, ${what(limit)}) cannot price the calls ${list} grants: they will always be denied`,
      [limit.attachmentId, ...unpriced.map((a) => a.attachmentId)],
    )
  }

  // --- Freeze coverage ---
  const freezes = policies.filter((p) => p.policyName === 'freeze' && p.scope.callMatch === CallMatch.ANY)
  const actorsWithAllow = [...new Set(allows.map((a) => a.scope.actor.toLowerCase()))]
    .map((lower) => allows.find((a) => a.scope.actor.toLowerCase() === lower)!.scope.actor)
    .filter((actor) => !isAny(actor))
  for (const actor of actorsWithAllow) {
    if (isRecovery(actor)) continue
    const covering = freezes.filter((f) => isAny(f.scope.actor) || same(f.scope.actor, actor))
    const flags = covering.map((f) => (f.settings?.policy === 'freeze' ? f.settings.settings : undefined))
    const ids = allows.filter((a) => same(a.scope.actor, actor)).map((a) => a.attachmentId)
    if (!flags.some((f) => f?.safeWide))
      add(
        'allow-without-freeze',
        'block',
        `${who(actor)} has an Allow and no Freeze at (${who(actor)}, *): a guardian's freeze would not stop it`,
        ids,
      )
    else if (!isOwners(actor) && !flags.some((f) => f?.actor))
      add(
        'freeze-misses-actor',
        'warn',
        `${who(actor)}'s Freeze does not read its own freeze: the kill switch (freezeActor) would not stop it`,
        covering.map((f) => f.attachmentId),
      )
  }
  for (const f of policies.filter((p) => p.policyName === 'freeze' && isRecovery(p.scope.actor)))
    add(
      'freeze-on-recovery',
      'warn',
      `Freeze on ${who(f.scope.actor)}: recovery would be blocked during a freeze (freeze, then recover)`,
      [f.attachmentId],
    )

  // --- Policy-specific ---
  for (const p of policies) {
    const actor = p.scope.actor
    if (p.policyName === 'quorum' && !isAny(actor) && !isOwners(actor))
      add(
        'quorum-on-module',
        'warn',
        `Quorum on ${who(actor)} denies all its transactions (owner path only)`,
        [p.attachmentId],
      )
    if (
      p.policyName === 'timelock' &&
      !isAny(actor) &&
      !isOwners(actor) &&
      p.settings?.policy === 'timelock' &&
      p.settings.settings.window === 0
    )
      add(
        'module-timelock-no-window',
        'warn',
        `${who(actor)}'s Timelock has no execution window: a module schedule has no nonce and stays executable forever`,
        [p.attachmentId],
      )
    if (!p.policyName)
      add('unknown-policy', 'warn', `Unknown policy contract ${p.policy} at (${who(actor)}, ${what(p)})`, [
        p.attachmentId,
      ])
  }

  // --- Roles and actors ---
  if (freezes.length > 0 && roles.guardians.length === 0)
    add('no-guardian', 'warn', 'Freeze is attached but nobody is a guardian: nobody can freeze', [])
  for (const account of [...roles.guardians, ...roles.lifters]) {
    if (owners.some((o) => same(o, account)))
      add(
        'owner-can-lift',
        'warn',
        `Owner ${who(account)} is a ${roles.guardians.some((g) => same(g, account)) ? 'guardian' : 'lifter'}: a compromised owner could lift the freeze meant to stop the owners`,
        [],
      )
  }
  if (input.fallbackHandler && !same(input.fallbackHandler, deployment.fallbackHandler))
    add(
      'fallback-handler',
      'warn',
      'The fallback handler accepts off-chain ERC-1271 signatures: a Permit or CoW order signed by the owners bypasses every policy. Switch to PolicyFallbackHandler',
      [],
    )
  const seen = new Set<string>()
  for (const a of attachments) {
    const actor = a.scope.actor
    if (
      isAny(actor) ||
      isOwners(actor) ||
      modules.some((m) => same(m, actor)) ||
      seen.has(actor.toLowerCase())
    )
      continue
    seen.add(actor.toLowerCase())
    add(
      'actor-not-module',
      'warn',
      `${who(actor)} is not an enabled module: its attachments apply only once it is enabled`,
      attachments.filter((b) => same(b.scope.actor, actor)).map((b) => b.attachmentId),
    )
  }

  return [...findings.filter((f) => f.severity === 'block'), ...findings.filter((f) => f.severity === 'warn')]
}
