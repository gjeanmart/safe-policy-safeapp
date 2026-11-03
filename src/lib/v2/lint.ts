import { type Address, type Hex, isAddressEqual } from 'viem'
import type { Attachment } from './attachments'
import { configureCoverIds } from './changes'
import {
  NFT_SELECTORS,
  OWNER_MANAGEMENT_SELECTORS,
  SELECTORS,
  SPEND_SELECTORS,
  type V2Deployment,
} from './policies'
import {
  CallMatch,
  EXACT_LEVEL,
  Kind,
  OP_CALL,
  OP_DELEGATECALL,
  OWNERS,
  actorLabel,
  callLabel,
  isAny,
  isOwners,
  scopeCovers,
} from './scopes'
import { type LabelContext, durationLabel } from './settings'

/**
 * Lint over a (projected) rev 3 configuration (DESIGN §9.6, 16 rules). Pure: give it the
 * attachments after the draft (`projectAttachments`) and the Safe's modules. `block` findings need
 * an explicit confirmation in the UI; `warn` ones are advice. The engine's own configure rules are
 * not repeated here: `validateChanges` refuses those.
 *
 * @example
 * lint({ safe, deployment, attachments: [allow (Agent, *)], modules: [agent] })
 * // → [{ rule: 'wildcard-allow-module', severity: 'block', ... }, { rule: 'actor-no-guardian', ... }]
 */

export type LintSeverity = 'block' | 'warn'

export type LintRule =
  | 'wildcard-allow-module'
  | 'delegatecall-grant'
  | 'safe-target-allow-not-exact'
  | 'actor-not-module'
  | 'unknown-policy'
  | 'no-owners-timelock'
  | 'timelock-not-covering-configure'
  | 'actor-no-guardian'
  | 'no-way-back'
  | 'deny-covers-configure'
  | 'limit-unlisted-spend'
  | 'limit-nft-actor'
  | 'strict-covers-safe-admin'
  | 'canceller-covers-owners'
  | 'delay-below-cooldown'
  | 'self-oversight'

export type LintFinding = { rule: LintRule; severity: LintSeverity; message: string; attachmentIds: Hex[] }

export type LintInput = {
  safe: Address
  deployment: V2Deployment
  attachments: readonly Attachment[]
  modules: readonly Address[]
  ctx?: LabelContext
  /** TimelockPolicy `COOLDOWN` (C), seconds; rule 15 is skipped until it is known. */
  cooldown?: bigint
}

const timelockOf = (a: Attachment) => (a.settings?.policy === 'timelock' ? a.settings.settings : undefined)

export function lint(input: LintInput): LintFinding[] {
  const { safe, deployment, attachments, modules, ctx = {}, cooldown } = input
  const { engine } = deployment
  const findings: LintFinding[] = []
  const add = (rule: LintRule, severity: LintSeverity, message: string, list: readonly Attachment[]) =>
    findings.push({ rule, severity, message, attachmentIds: list.map((a) => a.attachmentId) })
  const who = (actor: Address) => actorLabel(actor, ctx.nameOf)
  const where = (a: Attachment) => callLabel(a.scope, ctx.nameOf)
  const isModule = (actor: Address) => modules.some((m) => isAddressEqual(m, actor))
  const allows = attachments.filter((a) => a.kind === Kind.ALLOW)
  /** What applies to `actor`: its own attachments and Everyone's. */
  const reaching = (actor: Address) =>
    attachments.filter((a) => isAny(a.scope.actor) || isAddressEqual(a.scope.actor, actor))
  const actors = [...new Set(attachments.map((a) => a.scope.actor))].filter((a) => !isAny(a))

  // 1. A module granted a whole contract or everything.
  for (const a of allows) {
    if (isOwners(a.scope.actor)) continue
    if (a.scope.callMatch === CallMatch.ANY)
      add('wildcard-allow-module', 'block', `${who(a.scope.actor)} may call anything, on any contract.`, [a])
    else if (a.scope.callMatch === CallMatch.CONTRACT)
      add('wildcard-allow-module', 'warn', `${who(a.scope.actor)} may call any function of ${where(a)}.`, [a])
  }

  // 2. DELEGATECALL grants run code with the Safe's storage.
  for (const a of allows)
    if (a.opMask & OP_DELEGATECALL)
      add(
        'delegatecall-grant',
        'block',
        `${who(a.scope.actor)} may DELEGATECALL ${where(a)}: that code runs as the Safe and can change anything (owners, modules, guards).`,
        [a],
      )

  // 3. Allows on the Safe or the engine should name one function.
  for (const a of allows)
    if (
      a.scope.callMatch === CallMatch.CONTRACT &&
      (isAddressEqual(a.scope.to, safe) || isAddressEqual(a.scope.to, engine))
    )
      add(
        'safe-target-allow-not-exact',
        isOwners(a.scope.actor) ? 'warn' : 'block',
        isOwners(a.scope.actor)
          ? `The owners may call any function of ${where(a)}: name the functions.`
          : `${who(a.scope.actor)}'s Allow on ${where(a)} does not count on the module path (F5): grant each function at its exact scope.`,
        [a],
      )

  // 4. Attachments on an actor that is not an enabled module.
  for (const actor of actors)
    if (!isOwners(actor) && !isModule(actor))
      add(
        'actor-not-module',
        'warn',
        `${who(actor)} is not an enabled module of this Safe: its attachments do nothing until it is.`,
        attachments.filter((a) => isAddressEqual(a.scope.actor, actor)),
      )

  // 5. A policy contract the app does not know.
  for (const a of attachments)
    if (a.kind === Kind.POLICY && !a.policyName)
      add(
        'unknown-policy',
        'block',
        `${who(a.scope.actor)}, ${where(a)}: ${a.policy} is not a policy of this deployment. Only attach audited code: a policy runs on every matched transaction.`,
        [a],
      )

  // 6. Configuration is instant without an owners' Timelock covering engine.configure.
  const ownersCovers = new Set(configureCoverIds(deployment, OWNERS))
  const ownersConfigTimelocks = attachments.filter(
    (a) => ownersCovers.has(a.attachmentId) && (timelockOf(a)?.delay ?? 0) > 0 && a.opMask & OP_CALL,
  )
  if (ownersConfigTimelocks.length === 0)
    add(
      'no-owners-timelock',
      'warn',
      "No owners' Timelock covers engine.configure: the owners (or anyone holding their keys) can change every rule at once. Attach a Timelock at (Owners, *) (Owners template).",
      [],
    )

  // 7. A module that may configure, without a Timelock on it.
  for (const a of allows) {
    if (isOwners(a.scope.actor) || a.level !== EXACT_LEVEL) continue
    if (!isAddressEqual(a.scope.to, engine) || a.scope.selector.toLowerCase() !== SELECTORS.configure)
      continue
    const covers = new Set(configureCoverIds(deployment, a.scope.actor))
    if (!attachments.some((t) => covers.has(t.attachmentId) && (timelockOf(t)?.delay ?? 0) > 0))
      add(
        'timelock-not-covering-configure',
        'block',
        `${who(a.scope.actor)} may call engine.configure with no Timelock on it: it can rewrite every rule at once.`,
        [a],
      )
  }

  // 8. An actor nobody can stop: no guardian on any Timelock that reaches it. Recovery (only
  //    owner management and configure) is meant to have none.
  for (const actor of actors) {
    const own = allows.filter((a) => isAddressEqual(a.scope.actor, actor))
    if (own.length === 0) continue
    const recoveryShape = own.every(
      (a) =>
        a.level === EXACT_LEVEL &&
        ((isAddressEqual(a.scope.to, safe) &&
          OWNER_MANAGEMENT_SELECTORS.includes(a.scope.selector.toLowerCase() as Hex)) ||
          (isAddressEqual(a.scope.to, engine) && a.scope.selector.toLowerCase() === SELECTORS.configure)),
    )
    if (recoveryShape) continue
    const guarded = reaching(actor).some((t) => (timelockOf(t)?.guardians.length ?? 0) > 0)
    if (!guarded)
      add(
        'actor-no-guardian',
        'warn',
        `Nobody can freeze ${who(actor)}: add a guardian (a Timelock, delay 0 for a kill switch, at (${who(actor)}, *)).`,
        own,
      )
  }

  // 9. No way back: a co-signer reaches the owners' configure and no recovery can configure.
  const ownersConfigCoSigners = attachments.filter(
    (a) => a.policyName === 'coSigner' && scopeCovers(a.scope, OWNERS, engine, SELECTORS.configure),
  )
  const recoveryCanConfigure = allows.some(
    (a) =>
      !isOwners(a.scope.actor) &&
      isModule(a.scope.actor) &&
      a.level === EXACT_LEVEL &&
      isAddressEqual(a.scope.to, engine) &&
      a.scope.selector.toLowerCase() === SELECTORS.configure &&
      !attachments.some(
        (c) =>
          c.policyName === 'coSigner' && scopeCovers(c.scope, a.scope.actor, engine, SELECTORS.configure),
      ),
  )
  if (ownersConfigCoSigners.length > 0 && !recoveryCanConfigure)
    add(
      'no-way-back',
      'block',
      'A co-signer must approve every configuration change and no recovery module can configure without it: if the co-signer disappears, nothing can ever be changed again. Add a Recovery with engine.configure.',
      ownersConfigCoSigners,
    )

  // 10. A Deny covering configure locks the configuration.
  for (const a of attachments)
    if (
      a.kind === Kind.DENY &&
      scopeCovers(a.scope, isAny(a.scope.actor) ? OWNERS : a.scope.actor, engine, SELECTORS.configure) &&
      a.opMask & OP_CALL
    )
      add(
        'deny-covers-configure',
        isAny(a.scope.actor) || isOwners(a.scope.actor) ? 'block' : 'warn',
        `Deny at ${where(a)} for ${who(a.scope.actor)} also denies engine.configure${isAny(a.scope.actor) || isOwners(a.scope.actor) ? ': the owners could never change the configuration again' : ''}.`,
        [a],
      )

  // 11 and 12. Limits that cannot price what the actor is granted.
  for (const limit of attachments) {
    if (limit.settings?.policy !== 'limit') continue
    const { limits, passUnpriced } = limit.settings.settings
    const listed = (token: Address) => limits.some((l) => isAddressEqual(l.token, token))
    const actor = limit.scope.actor
    const granted = allows.filter(
      (a) =>
        (isAny(actor) || isAddressEqual(a.scope.actor, actor)) &&
        a.scope.callMatch !== CallMatch.ANY &&
        (limit.scope.callMatch === CallMatch.ANY || isAddressEqual(limit.scope.to, a.scope.to)),
    )
    const spends = granted.filter(
      (a) =>
        a.scope.callMatch === CallMatch.FUNCTION &&
        SPEND_SELECTORS.includes(a.scope.selector.toLowerCase() as Hex) &&
        !listed(a.scope.to),
    )
    if (spends.length > 0)
      add(
        'limit-unlisted-spend',
        'warn',
        `${spends.map(where).join(', ')}: the budget at ${where(limit)} does not list that token, so these calls are always denied (Unpriced${passUnpriced ? ', even with "other calls pass"' : ''}). List the token.`,
        [limit, ...spends],
      )
    const nft = granted.filter(
      (a) =>
        (a.scope.callMatch === CallMatch.FUNCTION &&
          NFT_SELECTORS.includes(a.scope.selector.toLowerCase() as Hex)) ||
        (a.scope.callMatch === CallMatch.FUNCTION &&
          ([SELECTORS.transferFrom, SELECTORS.approve] as Hex[]).includes(
            a.scope.selector.toLowerCase() as Hex,
          ) &&
          !listed(a.scope.to)),
    )
    if (limit.scope.callMatch === CallMatch.ANY && nft.length > 0)
      add(
        'limit-nft-actor',
        'warn',
        `${who(actor)} moves what looks like ERC-721 (${nft.map(where).join(', ')}) under a budget at (${who(actor)}, *): ERC-721 shares transferFrom / approve with ERC-20 and cannot be priced. Put the budget at (${who(actor)}, token.*) scopes instead.`,
        [limit, ...nft],
      )
  }

  const reachesOwners = (a: Attachment) => isAny(a.scope.actor) || isOwners(a.scope.actor)
  const at = (a: Attachment) => `(${who(a.scope.actor)}, ${where(a)})`

  // 13. A Limit without "other calls pass", or a strict Args, on the owners' calls to the Safe. Limit
  //     and Args ignore calls to the engine (rev 3 fix P1), so engine.configure still works and the
  //     owners can detach it; but setGuard, setModuleGuard, setFallbackHandler and owner management
  //     are denied (Unpriced / NoConstraint) while it is attached.
  for (const a of attachments) {
    const strict =
      (a.settings?.policy === 'limit' && !a.settings.settings.passUnpriced) ||
      (a.settings?.policy === 'args' && a.settings.settings.strict)
    if (!strict || !reachesOwners(a) || !(a.opMask & OP_CALL)) continue
    if (a.scope.callMatch !== CallMatch.ANY && !isAddressEqual(a.scope.to, safe)) continue
    const label =
      a.settings?.policy === 'limit' ? 'Budget (no "other calls pass")' : 'Conditions ("deny other calls")'
    add(
      'strict-covers-safe-admin',
      'warn',
      `${label} at ${at(a)} covers Safe admin calls: setGuard, setModuleGuard, setFallbackHandler and owner management are denied while it is attached. engine.configure is not judged by it, so the owners can still detach it first.`,
      [a],
    )
  }

  // 14. A canceller on a Timelock that delays the owners: it may cancel every owners' schedule
  //     (all but engine.configure, rev 3 fix T4) at any time, with no cap and no cooldown.
  for (const a of attachments) {
    const t = timelockOf(a)
    if (!t || t.cancellers.length === 0) continue
    if (!scopeCovers(a.scope, isAny(a.scope.actor) ? OWNERS : a.scope.actor, engine, SELECTORS.configure))
      continue
    if (!reachesOwners(a)) continue
    add(
      'canceller-covers-owners',
      'warn',
      `${t.cancellers.map(who).join(', ')} can cancel every owners' transaction (all but engine.configure) the Timelock at ${at(a)} delays, at any time and without limit. Prefer cancellers on narrower scopes, e.g. (Owners, USDC.*).`,
      [a],
    )
  }

  // 15. A delay shorter than the cooldown C: once a freeze ends the guardians cannot freeze again
  //     for C, so a transaction scheduled at the start of the cooldown is ready and executed first.
  if (cooldown !== undefined && cooldown > 0n)
    for (const a of attachments) {
      const t = timelockOf(a)
      if (!t || t.delay <= 0 || BigInt(t.delay) >= cooldown) continue
      const guarded = attachments.some(
        (g) =>
          (timelockOf(g)?.guardians.length ?? 0) > 0 &&
          (isAny(g.scope.actor) || isAddressEqual(g.scope.actor, a.scope.actor)),
      )
      if (!guarded) continue
      add(
        'delay-below-cooldown',
        reachesOwners(a) ? 'block' : 'warn',
        `The delay at ${at(a)} (${durationLabel(t.delay)}) is shorter than the guardians' cooldown C (${durationLabel(cooldown)}): after a freeze ends, a transaction scheduled at the start of the cooldown is executed before any guardian can freeze again. Use a delay of at least C.`,
        [a],
      )
    }

  // 16. An actor overseeing itself: its own approver (the co-signer checks nothing), or its own
  //     guardian / lifter (it can lift a freeze someone else put on it). Only the Safe is refused
  //     on-chain. At Everyone, every enabled module the attachment reaches counts.
  for (const a of attachments) {
    if (isOwners(a.scope.actor)) continue
    const subjects = isAny(a.scope.actor) ? modules : [a.scope.actor]
    const roles: [string, readonly Address[]][] =
      a.settings?.policy === 'coSigner'
        ? [['approver', a.settings.settings.approvers]]
        : a.settings?.policy === 'timelock'
          ? [
              ['guardian', a.settings.settings.guardians],
              ['lifter', a.settings.settings.lifters],
            ]
          : []
    for (const [role, list] of roles)
      for (const subject of subjects)
        if (list.some((x) => isAddressEqual(x, subject)))
          add(
            'self-oversight',
            'block',
            `${who(subject)} is its own ${role} at ${at(a)}: ${role === 'approver' ? 'it approves its own transactions, the co-signer checks nothing' : 'it can lift any freeze put on it, nobody can stop it'}. List someone else.`,
            [a],
          )
  }

  return findings
}
