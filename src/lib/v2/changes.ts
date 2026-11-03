import {
  type Address,
  type Hex,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  size,
  zeroAddress,
} from 'viem'
import { policyGuardAbi } from './abi'
import { type UncoveredRoute, uncoveredRoute } from './rev3/cover'
import type { Attachment } from './attachments'
import {
  POLICY_INFO,
  SAFE_HANDLERS,
  SELECTORS,
  type V2Deployment,
  policyNameOf,
  selectorName,
} from './policies'
import {
  ACTOR_LEVEL_OFFSET,
  CallMatch,
  EXACT_LEVEL,
  Kind,
  LEVEL_COUNT,
  MAX_ATTACHMENTS_PER_SCOPE,
  OP_ALL,
  OP_CALL,
  OP_DELEGATECALL,
  Operation,
  type Scope,
  actorLabel,
  attachmentId,
  isAny,
  isNormalized,
  levelOf,
  normalizeOpMask,
  normalizeScope,
  scopeAt,
  scopeKey,
} from './scopes'
import {
  type LabelContext,
  type PolicySettings,
  type TimelockSettings,
  decodeSettings,
  durationLabel,
  encodeSettings,
  settingsLabel,
  validateSettings,
} from './settings'

/**
 * Configuration changes (SPEC.md §3.2–3.3). Configuration is an ordinary owner transaction
 * `engine.configure(Change[])`, judged like any other call: the owners' Timelock delays it, their
 * freeze blocks it. This module builds changes, merges a draft by attachment id, projects the
 * result, mirrors every configure-time engine and policy rule, and builds the owner calls (configure,
 * and the install batch `[configure, setModuleGuard, setGuard]`).
 *
 * @example
 * const draft = [allowChange(onFunction(ops, USDC, SELECTORS.transfer))]
 * const problems = validateChanges(model.attachments, draft, { deployment, safe })
 * const tx = configureCall(deployment.engine, draft)       // one owner transaction, never batched
 */

export type Change = {
  /** Remove the attachment `(scope, kind, policy)`; `opMask` and `settings` are ignored. */
  detach: boolean
  scope: Scope
  kind: Kind
  policy: Address
  /** 0 = default (CALL for ALLOW, both ops for DENY / POLICY). */
  opMask: number
  settings: Hex
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

/** An attach (or update) change; the scope is normalized and checksummed. */
export const attachChange = (
  scope: Scope,
  kind: Kind,
  policy: Address,
  opMask: number,
  settings: Hex,
): Change => ({
  detach: false,
  scope: normalizeScope(scope),
  kind,
  policy: getAddress(policy),
  opMask,
  settings,
})

/** Built-in ALLOW, CALL only unless asked (DELEGATECALL only at the exact level). */
export const allowChange = (scope: Scope, opMask: number = OP_CALL): Change =>
  attachChange(scope, Kind.ALLOW, zeroAddress, opMask, '0x')

/** Built-in DENY, both operations by default. */
export const denyChange = (scope: Scope, opMask: number = OP_ALL): Change =>
  attachChange(scope, Kind.DENY, zeroAddress, opMask, '0x')

/** A known policy with its settings; both operations by default, so a granted DELEGATECALL is seen too. */
export const policyChange = (
  deployment: V2Deployment,
  scope: Scope,
  value: PolicySettings,
  opMask: number = OP_ALL,
): Change =>
  attachChange(scope, Kind.POLICY, deployment.policies[value.policy], opMask, encodeSettings(value))

/** Detach of an existing attachment (the engine does not call the policy). */
export const detachChange = (a: Pick<Attachment, 'scope' | 'kind' | 'policy'>): Change => ({
  detach: true,
  scope: normalizeScope(a.scope),
  kind: a.kind,
  policy: getAddress(a.policy),
  opMask: 0,
  settings: '0x',
})

/** The attachment a change targets: `attachmentId(scopeKey(scope), kind, policy)`. */
export const changeAttachmentId = (change: Pick<Change, 'scope' | 'kind' | 'policy'>): Hex =>
  attachmentId(scopeKey(normalizeScope(change.scope)), change.kind, change.policy)

// ---------------------------------------------------------------------------------------------
// Draft editing
// ---------------------------------------------------------------------------------------------

/**
 * Adds `change` to a draft: a later edit of the same attachment replaces the earlier one, and a
 * detach of an attachment that only exists in the draft just drops it.
 */
export function mergeChange(
  draft: readonly Change[],
  change: Change,
  isAttached: (id: Hex) => boolean,
): Change[] {
  const id = changeAttachmentId(change)
  const rest = draft.filter((c) => changeAttachmentId(c) !== id)
  if (change.detach && !isAttached(id)) return rest
  return [...rest, change]
}

export const mergeChanges = (
  draft: readonly Change[],
  changes: readonly Change[],
  isAttached: (id: Hex) => boolean,
): Change[] => changes.reduce((acc, c) => mergeChange(acc, c, isAttached), [...draft])

/**
 * The order `configure` applies: detaches first (they free slots under the per-scope cap), then
 * every attach in draft order. The Timelock covering rule is checked on the final configuration
 * (`IPolicy.validate`), so the order of the Timelocks does not matter.
 */
export function sortForApply(changes: readonly Change[]): Change[] {
  return [...changes.filter((c) => c.detach), ...changes.filter((c) => !c.detach)]
}

// ---------------------------------------------------------------------------------------------
// Projection and validation (so the UI refuses what `configure` would revert)
// ---------------------------------------------------------------------------------------------

/** The attachments after applying `changes` to `current`, in order (pure). Freeze state is kept. */
export function projectAttachments(
  current: readonly Attachment[],
  changes: readonly Change[],
  deployment: V2Deployment,
): Attachment[] {
  const result = [...current]
  for (const change of changes) {
    const scope = normalizeScope(change.scope)
    const key = scopeKey(scope)
    const id = attachmentId(key, change.kind, change.policy)
    const index = result.findIndex((a) => a.attachmentId === id)
    if (change.detach) {
      if (index >= 0) result.splice(index, 1)
      continue
    }
    const policyName = change.kind === Kind.POLICY ? policyNameOf(deployment, change.policy) : undefined
    let settings: PolicySettings | undefined
    let settingsError: string | undefined
    if (policyName) {
      try {
        settings = decodeSettings(policyName, change.settings)
      } catch (error) {
        settingsError = error instanceof Error ? error.message : String(error)
      }
    }
    const next: Attachment = {
      attachmentId: id,
      scopeKey: key,
      scope,
      kind: change.kind,
      policy: getAddress(change.policy),
      opMask: normalizeOpMask(change.kind, change.opMask),
      level: levelOf(scope),
      policyName,
      settings,
      settingsError,
      freeze: result[index]?.freeze,
    }
    if (index >= 0) result[index] = next
    else result.push(next)
  }
  return result
}

/** `index`: the change it is about, or -1 for the draft as a whole. */
export type ChangeProblem = { index: number; message: string }

/** The ids a Timelock must sit at to cover `actor`'s call to `engine.configure` (SPEC.md §5.1). */
export const configureCoverIds = (deployment: V2Deployment, actor: Address): Hex[] =>
  Array.from({ length: isAny(actor) ? ACTOR_LEVEL_OFFSET : LEVEL_COUNT }, (_, level) =>
    attachmentId(
      scopeKey(scopeAt(level, actor, deployment.engine, SELECTORS.configure)),
      Kind.POLICY,
      deployment.policies.timelock,
    ),
  )

/**
 * The Timelock covering rule (SPEC.md §5.1, `TimelockNotCoveringConfiguration`) on a final
 * configuration: the first owner-path route (any DELEGATECALL, `engine.configure`, `Safe.setGuard`,
 * `setModuleGuard`, `enableModule`, `disableModule`, `setFallbackHandler`) not delayed as long as the
 * owners' longest delay, or `null`. Mirrors `TimelockPolicyFreeze.validate` (`rev3/cover.ts`, checked
 * against the engine by the contract tests); `(ANY, *)` covers count, as on-chain.
 */
export function validateTimelockCover(
  state: readonly Attachment[],
  context: { deployment: V2Deployment; safe: Address },
): UncoveredRoute | null {
  const { deployment, safe } = context
  const covers = state.flatMap((a) =>
    a.kind === Kind.POLICY &&
    isAddressEqual(a.policy, deployment.policies.timelock) &&
    a.settings?.policy === 'timelock'
      ? [{ scope: a.scope, opMask: a.opMask, delay: a.settings.settings.delay }]
      : [],
  )
  return uncoveredRoute(covers, deployment.engine, safe)
}

/** Where the "Admin delay" template puts each route's cover. */
const ROUTE_COVER: Record<string, string> = {
  'any DELEGATECALL': '(Owners, any call) with DELEGATECALL',
  'engine.configure': '(Owners, engine.configure)',
}

/** The sentence for an uncovered route. */
export const uncoveredRouteMessage = (route: UncoveredRoute): string =>
  `${route.name.charAt(0).toUpperCase()}${route.name.slice(1)} must be delayed at least ${durationLabel(route.delay)}, the owners' longest delay: otherwise ` +
  `the owners could remove or bypass that delay faster than it delays. Add a Timelock of ` +
  `${durationLabel(route.delay)} at ${ROUTE_COVER[route.name] ?? '(Owners, Safe.*)'} (the "Admin delay" template does).`

/**
 * Every configure-time rule of the engine (SPEC.md §3.2) and of the known policies, applied in order
 * on a projection: `InvalidScope`, `AllowNotPerActor`, `DelegateCallNotExact`, `InvalidOpMask`,
 * `InvalidPolicy` (shape only: the engine checks ERC-165), the policies' `InvalidSettings`,
 * `TooManyAttachments`, `NotAttached`; then, on the final projection, the Timelock covering rule
 * (`TimelockNotCoveringConfiguration`, reported with `index: -1`, the draft as a whole).
 */
export function validateChanges(
  current: readonly Attachment[],
  changes: readonly Change[],
  context: { deployment: V2Deployment; safe: Address },
): ChangeProblem[] {
  const { deployment } = context
  const problems: ChangeProblem[] = []
  let state = [...current]
  changes.forEach((change, index) => {
    const add = (message: string) => problems.push({ index, message })
    const { scope } = change
    if (!isNormalized(scope)) {
      add('Invalid scope: a named contract cannot be the zero address, open parts must be zero')
      return
    }
    const id = changeAttachmentId(change)
    if (change.detach) {
      if (!state.some((a) => a.attachmentId === id)) add('Not attached')
      state = projectAttachments(state, [change], deployment)
      return
    }
    if (change.opMask > OP_ALL || change.opMask < 0) add(`Invalid op mask ${change.opMask}`)
    const opMask = normalizeOpMask(change.kind, change.opMask)
    if (change.kind === Kind.POLICY) {
      if (isAddressEqual(change.policy, zeroAddress)) add('Pick a policy')
      const name = policyNameOf(deployment, change.policy)
      if (name) {
        try {
          const value = decodeSettings(name, change.settings)
          for (const message of validateSettings(value, { safe: context.safe, actor: scope.actor }))
            add(message)
        } catch {
          add('Settings do not decode')
        }
      }
    } else {
      if (!isAddressEqual(change.policy, zeroAddress) || size(change.settings) !== 0)
        add('Allow / Deny take no policy and no settings')
      if (change.kind === Kind.ALLOW) {
        if (isAny(scope.actor)) add('An Allow must name an actor (Owners or a module), never Everyone')
        if (opMask & OP_DELEGATECALL && levelOf(scope) !== EXACT_LEVEL)
          add('DELEGATECALL can only be allowed for one actor on one function of one contract')
      }
    }
    const key = scopeKey(normalizeScope(scope))
    const exists = state.some((a) => a.attachmentId === id)
    if (!exists && state.filter((a) => a.scopeKey === key).length >= MAX_ATTACHMENTS_PER_SCOPE)
      add(`At most ${MAX_ATTACHMENTS_PER_SCOPE} attachments per scope`)
    state = projectAttachments(state, [change], deployment)
  })
  // Checked once, on the final configuration, as `configure` does after the batch.
  const uncovered = validateTimelockCover(state, context)
  if (uncovered) problems.push({ index: -1, message: uncoveredRouteMessage(uncovered) })
  return problems
}

// ---------------------------------------------------------------------------------------------
// Owner calls
// ---------------------------------------------------------------------------------------------

/** A transaction the owners sign (execTransaction fields minus gas, which V2 requires to be zero). */
export type OwnerCall = { to: Address; value: bigint; data: Hex; operation: Operation; description: string }

const call = (to: Address, data: Hex, description: string): OwnerCall => ({
  to,
  value: 0n,
  data,
  operation: Operation.CALL,
  description,
})

const safeAdminAbi = parseAbi([
  'function setGuard(address guard)',
  'function setModuleGuard(address moduleGuard)',
  'function setFallbackHandler(address handler)',
])

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * `engine.configure(changes)` as an owner transaction. Once the engine guards the Safe it must be a
 * top-level CALL with zero value (never inside a batch, `GuardTargetDenied`); the owners' Timelock,
 * freeze and co-signer apply to it.
 */
export const configureCall = (engine: Address, changes: readonly Change[]): OwnerCall =>
  call(
    engine,
    encodeFunctionData({ abi: policyGuardAbi, functionName: 'configure', args: [changes] }),
    `configure(${plural(changes.length, 'change')})`,
  )

export const safeCalls = {
  setGuard: (safe: Address, guard: Address): OwnerCall =>
    call(
      safe,
      encodeFunctionData({ abi: safeAdminAbi, functionName: 'setGuard', args: [guard] }),
      `setGuard(${guard})`,
    ),
  setModuleGuard: (safe: Address, guard: Address): OwnerCall =>
    call(
      safe,
      encodeFunctionData({ abi: safeAdminAbi, functionName: 'setModuleGuard', args: [guard] }),
      `setModuleGuard(${guard})`,
    ),
  setFallbackHandler: (safe: Address, handler: Address): OwnerCall =>
    call(
      safe,
      encodeFunctionData({ abi: safeAdminAbi, functionName: 'setFallbackHandler', args: [handler] }),
      `setFallbackHandler(${handler})`,
    ),
}

/**
 * Installs the engine (SPEC.md §3.3): `[configure, setFallbackHandler?, setModuleGuard, setGuard]` in
 * one owner batch, before any guard runs (so none of it is checked). Leftovers from an earlier install
 * are detached first in the same `configure`.
 *
 * By default the batch also sets Safe's TokenCallbackHandler as fallback handler: with an ERC-1271
 * handler (CompatibilityFallbackHandler) the owners' off-chain signatures move funds with no policy
 * running, which voids the owners' Timelock / freeze / recovery timeline (SPEC.md §5.1, §6). Pass
 * `fallbackHandler: null` to keep the current handler; the call is skipped when `currentHandler`
 * already is the one asked for.
 */
export function installCalls(
  safe: Address,
  deployment: V2Deployment,
  changes: readonly Change[],
  leftovers: readonly Attachment[] = [],
  options: { fallbackHandler?: Address | null; currentHandler?: Address } = {},
): OwnerCall[] {
  const { fallbackHandler = SAFE_HANDLERS.tokenCallback, currentHandler } = options
  const touched = new Set(changes.map(changeAttachmentId))
  const detaches = leftovers.filter((a) => !touched.has(a.attachmentId)).map(detachChange)
  const setHandler =
    fallbackHandler !== null && !(currentHandler && isAddressEqual(currentHandler, fallbackHandler))
  return [
    configureCall(deployment.engine, sortForApply([...detaches, ...changes])),
    ...(setHandler ? [safeCalls.setFallbackHandler(safe, fallbackHandler)] : []),
    safeCalls.setModuleGuard(safe, deployment.engine),
    safeCalls.setGuard(safe, deployment.engine),
  ]
}

/**
 * V2 needs Safe ≥ 1.5.0: older Safes have no module guard, so every module would run unchecked.
 * Parses `VERSION()` (`1.5.0`, `1.5.0+L2`).
 */
export function supportsV2(version: string): boolean {
  const [major = 0, minor = 0] = version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
  return major > 1 || (major === 1 && minor >= 5)
}

/** A top-level `engine.configure` CALL: what TimelockPolicy marks `isConfiguration`. */
export const isConfigurationCall = (
  engine: Address,
  c: Pick<OwnerCall, 'to' | 'data' | 'operation'>,
): boolean =>
  c.operation === Operation.CALL &&
  isAddressEqual(c.to, engine) &&
  size(c.data) >= 4 &&
  c.data.slice(0, 10).toLowerCase() === SELECTORS.configure

// ---------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------

const shortAddress = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** `any call`, `any function of USDC`, `USDC.transfer`. */
export function callPhrase(scope: Scope, ctx: LabelContext = {}): string {
  if (scope.callMatch === CallMatch.ANY) return 'any call'
  const target = ctx.nameOf?.(getAddress(scope.to)) ?? shortAddress(scope.to)
  if (scope.callMatch === CallMatch.CONTRACT) return `any function of ${target}`
  return `${target}.${selectorName(scope.selector) ?? scope.selector}`
}

const opsPhrase = (kind: Kind, opMask: number): string => {
  const mask = normalizeOpMask(kind, opMask)
  if (kind === Kind.ALLOW)
    return mask & OP_DELEGATECALL
      ? mask & OP_CALL
        ? ' (CALL and DELEGATECALL)'
        : ' (DELEGATECALL only)'
      : ''
  return mask === OP_ALL ? '' : mask === OP_CALL ? ' (CALL only)' : ' (DELEGATECALL only)'
}

/** What re-configuring an attached policy resets. */
const RECONFIGURE_NOTE: Partial<Record<string, string>> = {
  limit: ' (resets the budget: spent goes back to 0)',
  timelock: ' (schedules wait the full delay again, from the change; the freeze state is kept)',
}

/** What re-configuring this existing attachment resets (a budget, the schedules' clock), if anything. */
export function changeNote(change: Change, deployment: V2Deployment, attached: boolean): string | undefined {
  if (!attached || change.detach || change.kind !== Kind.POLICY) return undefined
  const note = RECONFIGURE_NOTE[policyNameOf(deployment, change.policy) ?? '']
  return note?.trim().replace(/^\((.*)\)$/, '$1')
}

/**
 * The builder's live sentence: `Ops may call USDC.transfer`, `Ops may call USDC.transfer, with
 * conditions: to Vendor A`, `Owners: Timelock 24h, guardians G on any call`, `Removes ...`.
 */
export function describeChange(
  change: Change,
  deployment: V2Deployment,
  ctx: LabelContext = {},
  /** The attachment already exists: an attach re-configures it. */
  attached = false,
  /** Append what a re-configuration resets (off when the caller shows {@link changeNote} apart). */
  withNote = true,
): string {
  const who = actorLabel(change.scope.actor, ctx.nameOf)
  const what = callPhrase(change.scope, ctx)
  const ops = opsPhrase(change.kind, change.opMask)
  const name = policyNameOf(deployment, change.policy)
  const policyLabel = (): string => {
    if (!name) return `policy ${shortAddress(change.policy)}`
    if (change.detach) return POLICY_INFO[name].label
    try {
      return settingsLabel(decodeSettings(name, change.settings), ctx)
    } catch {
      return `${POLICY_INFO[name].label} (bad settings)`
    }
  }
  switch (change.kind) {
    case Kind.ALLOW:
      return change.detach ? `${who} may no longer call ${what}` : `${who} may call ${what}${ops}`
    case Kind.DENY:
      return change.detach ? `Stops denying ${who}: ${what}` : `Denies ${who}: ${what}${ops}`
    default:
      if (change.detach) return `Removes ${policyLabel()} from ${who}, ${what}`
      return `${attached ? 'Re-configures' : 'Adds'} ${policyLabel()} for ${who}, ${what}${ops}${attached && withNote ? (RECONFIGURE_NOTE[name ?? ''] ?? '') : ''}`
  }
}

/** Timelock settings of the given attachments. */
export const timelockSettingsOf = (attachments: readonly Attachment[]): TimelockSettings[] =>
  attachments.flatMap((a) => (a.settings?.policy === 'timelock' ? [a.settings.settings] : []))
