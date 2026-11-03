import {
  type Address,
  type Hex,
  concat,
  encodeFunctionData,
  encodePacked,
  getAddress,
  isAddressEqual,
  parseAbi,
  size,
  zeroAddress,
} from 'viem'
import { policyEngineV2Abi } from './abi'
import type { Attachment } from './attachments'
import { POLICY_INFO, SELECTORS, type V2Deployment, policyNameOf, selectorName } from './policies'
import {
  ANY,
  type AttachmentChange,
  AttachmentKind,
  CallMatch,
  ChangeType,
  EXACT_LEVEL,
  type FreezeRole,
  MAX_ATTACHMENTS_PER_SCOPE,
  MAX_BATCH_CALLS,
  MAX_ROLE_MEMBERS,
  OP_ALL,
  OP_CALL,
  OP_DELEGATECALL,
  OWNERS,
  Operation,
  PolicyLevel,
  type RoleChange,
  type Scope,
  actorLabel,
  attachmentId,
  configurationRoot,
  isNormalized,
  levelOf,
  namesTo,
  normalizeOpMask,
  normalizeScope,
  scopeKey,
} from './scopes'
import {
  type LabelContext,
  type PolicySettings,
  decodeSettings,
  encodeSettings,
  settingsLabel,
  validateSettings,
} from './settings'

/**
 * Configuration changes (SPEC §5): AttachmentChange / RoleChange builders, a draft that merges
 * edits by attachment id, local validation mirroring the engine's apply rules (§5.2), the
 * configuration root, the calldata of request / apply / invalidate, and MultiSend batching.
 *
 * @example
 * const set: ChangeSet = { changes: [allowChange({ actor: ops, to: USDC, selector: SELECTORS.transfer, callMatch: CallMatch.TO_SELECTOR })], roles: [] }
 * const root = changeSetRoot(set)                       // = engine.configurationRoot(changes, roles)
 * const txs = [engineCalls.requestConfiguration(engine, root)]       // owners sign, wait DELAY,
 * const later = [engineCalls.applyConfiguration(engine, set)]        // then apply the same set
 */

export type ChangeSet = { changes: AttachmentChange[]; roles: RoleChange[] }

export const emptyChangeSet = (): ChangeSet => ({ changes: [], roles: [] })

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

const checksumScope = (scope: Scope): Scope => {
  const normalized = normalizeScope(scope)
  return { ...normalized, actor: getAddress(normalized.actor), to: getAddress(normalized.to) }
}

/** A SET change; the scope is normalized (open parts zeroed) so the root matches the engine's. */
export function setChange(
  scope: Scope,
  kind: AttachmentKind,
  policy: Address,
  opMask: number,
  data: Hex,
): AttachmentChange {
  return {
    changeType: ChangeType.SET,
    scope: checksumScope(scope),
    kind,
    policy: getAddress(policy),
    opMask,
    data,
  }
}

/** Built-in ALLOW. CALL only by default; DELEGATECALL is only accepted at the exact level (§6.3). */
export const allowChange = (scope: Scope, opMask: number = OP_CALL): AttachmentChange =>
  setChange(scope, AttachmentKind.ALLOW, zeroAddress, opMask, '0x')

/** Built-in DENY; covers both operations by default (restrictions may cover DELEGATECALL anywhere). */
export const denyChange = (scope: Scope, opMask: number = OP_ALL): AttachmentChange =>
  setChange(scope, AttachmentKind.DENY, zeroAddress, opMask, '0x')

/**
 * Attaches a known policy with its settings. Defaults to both operations, so a DELEGATECALL the
 * actor is granted at the exact scope is still protected.
 */
export const policyChange = (
  deployment: V2Deployment,
  scope: Scope,
  value: PolicySettings,
  opMask: number = OP_ALL,
): AttachmentChange =>
  setChange(scope, AttachmentKind.POLICY, deployment.policies[value.policy], opMask, encodeSettings(value))

/** DETACH of an existing attachment (the engine ignores opMask and data). */
export const detachChange = (a: Pick<Attachment, 'scope' | 'kind' | 'policy'>): AttachmentChange => ({
  changeType: ChangeType.DETACH,
  scope: checksumScope(a.scope),
  kind: a.kind,
  policy: getAddress(a.policy),
  opMask: 0,
  data: '0x',
})

export const roleChange = (role: FreezeRole, account: Address, enabled = true): RoleChange => ({
  role,
  account: getAddress(account),
  enabled,
})

/** The attachment a change targets: `attachmentId(scopeKey(scope), kind, policy)`. */
export const changeAttachmentId = (change: Pick<AttachmentChange, 'scope' | 'kind' | 'policy'>): Hex =>
  attachmentId(scopeKey(normalizeScope(change.scope)), change.kind, change.policy)

// ---------------------------------------------------------------------------------------------
// Draft editing
// ---------------------------------------------------------------------------------------------

/**
 * Adds `change` to a draft: a later edit of the same attachment replaces the earlier one, and a
 * DETACH of an attachment that only exists in the draft just drops it.
 */
export function mergeChange(
  draft: readonly AttachmentChange[],
  change: AttachmentChange,
  isAttached: (attachmentId: Hex) => boolean,
): AttachmentChange[] {
  const id = changeAttachmentId(change)
  const rest = draft.filter((c) => changeAttachmentId(c) !== id)
  if (change.changeType === ChangeType.DETACH && !isAttached(id)) return rest
  return [...rest, change]
}

/** Same for roles: the last edit of `(role, account)` wins. */
export const mergeRole = (draft: readonly RoleChange[], change: RoleChange): RoleChange[] => [
  ...draft.filter((r) => !(r.role === change.role && isAddressEqual(r.account, change.account))),
  change,
]

/** DETACHes first (they free slots for the SETs under the per-scope cap, `MAX_ATTACHMENTS_PER_SCOPE`), order otherwise kept. */
export const sortForApply = (changes: readonly AttachmentChange[]): AttachmentChange[] => [
  ...changes.filter((c) => c.changeType === ChangeType.DETACH),
  ...changes.filter((c) => c.changeType === ChangeType.SET),
]

/** Merges change sets (templates on top of a draft), in order. */
export function combineChangeSets(sets: readonly ChangeSet[], isAttached: (id: Hex) => boolean): ChangeSet {
  let changes: AttachmentChange[] = []
  let roles: RoleChange[] = []
  for (const set of sets) {
    for (const change of set.changes) changes = mergeChange(changes, change, isAttached)
    for (const role of set.roles) roles = mergeRole(roles, role)
  }
  return { changes: sortForApply(changes), roles }
}

// ---------------------------------------------------------------------------------------------
// Projection and validation (mirror of SPEC §5.2, so the UI refuses what `apply` would revert)
// ---------------------------------------------------------------------------------------------

/**
 * The attachments after applying `changes` to `current`, in order (pure). Settings are decoded from
 * the change data for known policies, so the org chart and lint can show the draft.
 */
export function projectAttachments(
  current: readonly Attachment[],
  changes: readonly AttachmentChange[],
  deployment: V2Deployment,
): Attachment[] {
  const result = [...current]
  for (const change of changes) {
    const scope = normalizeScope(change.scope)
    const key = scopeKey(scope)
    const id = attachmentId(key, change.kind, change.policy)
    const index = result.findIndex((a) => a.attachmentId === id)
    if (change.changeType === ChangeType.DETACH) {
      if (index >= 0) result.splice(index, 1)
      continue
    }
    const policyName =
      change.kind === AttachmentKind.POLICY ? policyNameOf(deployment, change.policy) : undefined
    let settings: PolicySettings | undefined
    let settingsError: string | undefined
    if (policyName) {
      try {
        settings = decodeSettings(policyName, change.data)
      } catch (error) {
        settingsError = error instanceof Error ? error.message : String(error)
      }
    }
    const next: Attachment = {
      attachmentId: id,
      scopeKey: key,
      scope,
      kind: change.kind,
      policy: change.policy,
      opMask: normalizeOpMask(change.opMask),
      policyLevel: policyName
        ? POLICY_INFO[policyName].level
        : (result[index]?.policyLevel ?? PolicyLevel.CALL),
      level: levelOf(scope),
      policyName,
      settings,
      settingsError,
    }
    if (index >= 0) result[index] = next
    else result.push(next)
  }
  return result
}

export type ChangeProblem = {
  /** Index in `set.changes`, or in `set.roles` when `role` is true; undefined for the whole set. */
  index?: number
  role?: boolean
  message: string
}

/**
 * Problems that would make `applyConfiguration` (or `configureImmediately`) revert, checked
 * locally: scope normalization, op mask, built-in shape, DELEGATECALL grant level, 6 attachments
 * per scope, DETACH of something not attached, `DELAY ≥` timelock delay at ANY / OWNERS, settings,
 * role caps. Unknown policy contracts are only checked for shape (the engine checks ERC-165).
 */
export function validateChangeSet(
  current: readonly Attachment[],
  set: ChangeSet,
  context: {
    deployment: V2Deployment
    delay: bigint
    roles: { guardians: readonly Address[]; lifters: readonly Address[] }
  },
): ChangeProblem[] {
  const problems: ChangeProblem[] = []
  let state = [...current]
  set.changes.forEach((change, index) => {
    const add = (message: string) => problems.push({ index, message })
    const { scope } = change
    if (!isNormalized(scope) || (namesTo(scope.callMatch) && isAddressEqual(scope.to, zeroAddress))) {
      add('Invalid scope: open parts must be zero and a named target cannot be the zero address')
      return
    }
    const id = changeAttachmentId(change)
    if (change.changeType === ChangeType.DETACH) {
      if (!state.some((a) => a.attachmentId === id)) add('Not attached')
      state = projectAttachments(state, [change], context.deployment)
      return
    }
    const opMask = normalizeOpMask(change.opMask)
    if (opMask > OP_ALL) add(`Invalid op mask ${change.opMask}`)
    if (change.kind !== AttachmentKind.POLICY) {
      if (!isAddressEqual(change.policy, zeroAddress) || size(change.data) !== 0)
        add('Allow / Deny take no policy and no settings')
      if (change.kind === AttachmentKind.ALLOW && opMask & OP_DELEGATECALL && levelOf(scope) !== EXACT_LEVEL)
        add('DELEGATECALL can only be allowed for one actor on one function of one contract')
    } else {
      const name = policyNameOf(context.deployment, change.policy)
      if (isAddressEqual(change.policy, zeroAddress)) add('Pick a policy')
      if (name) {
        try {
          const value = decodeSettings(name, change.data)
          for (const message of validateSettings(value)) add(message)
          const actor = scope.actor
          if (
            value.policy === 'timelock' &&
            (isAddressEqual(actor, ANY) || isAddressEqual(actor, OWNERS)) &&
            BigInt(value.settings.delay) > context.delay
          )
            add(`Timelock longer than the configuration delay (${context.delay}s): the engine refuses it`)
        } catch {
          add('Settings do not decode')
        }
      }
    }
    const key = scopeKey(scope)
    const exists = state.some((a) => a.attachmentId === id)
    if (!exists && state.filter((a) => a.scopeKey === key).length >= MAX_ATTACHMENTS_PER_SCOPE)
      add(`At most ${MAX_ATTACHMENTS_PER_SCOPE} attachments per scope`)
    state = projectAttachments(state, [change], context.deployment)
  })

  const members = {
    0: [...context.roles.guardians],
    1: [...context.roles.lifters],
  } as Record<FreezeRole, Address[]>
  set.roles.forEach((change, index) => {
    if (isAddressEqual(change.account, zeroAddress)) {
      problems.push({ index, role: true, message: 'A role member cannot be the zero address' })
      return
    }
    const list = members[change.role]
    const at = list.findIndex((m) => isAddressEqual(m, change.account))
    if (change.enabled && at < 0) list.push(change.account)
    if (!change.enabled && at >= 0) list.splice(at, 1)
    if (list.length > MAX_ROLE_MEMBERS)
      problems.push({ index, role: true, message: `At most ${MAX_ROLE_MEMBERS} members per role` })
  })
  return problems
}

// ---------------------------------------------------------------------------------------------
// Root and calldata
// ---------------------------------------------------------------------------------------------

/** `keccak256(abi.encode(changes, roles))`, what `requestConfiguration` commits to. */
export const changeSetRoot = (set: ChangeSet): Hex => configurationRoot(set.changes, set.roles)

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
  'function multiSend(bytes transactions) payable',
])

const count = (set: ChangeSet) =>
  `${set.changes.length} change${set.changes.length === 1 ? '' : 's'}, ${set.roles.length} role${set.roles.length === 1 ? '' : 's'}`

/** Builders for the engine calls a Safe makes (msg.sender is the Safe). */
export const engineCalls = {
  /** Only before the engine is the Safe's guard or module guard (`GuardAlreadyEnabled`). */
  configureImmediately: (engine: Address, set: ChangeSet): OwnerCall =>
    call(
      engine,
      encodeFunctionData({
        abi: policyEngineV2Abi,
        functionName: 'configureImmediately',
        args: [set.changes, set.roles],
      }),
      `configureImmediately(${count(set)})`,
    ),

  requestConfiguration: (engine: Address, root: Hex): OwnerCall =>
    call(
      engine,
      encodeFunctionData({ abi: policyEngineV2Abi, functionName: 'requestConfiguration', args: [root] }),
      `requestConfiguration(${root})`,
    ),

  applyConfiguration: (engine: Address, set: ChangeSet): OwnerCall =>
    call(
      engine,
      encodeFunctionData({
        abi: policyEngineV2Abi,
        functionName: 'applyConfiguration',
        args: [set.changes, set.roles],
      }),
      `applyConfiguration(${count(set)})`,
    ),

  invalidateRoot: (engine: Address, root: Hex): OwnerCall =>
    call(
      engine,
      encodeFunctionData({ abi: policyEngineV2Abi, functionName: 'invalidateRoot', args: [root] }),
      `invalidateRoot(${root})`,
    ),

  /** A guardian (EOA or Safe) freezes every listed Safe; frozen / cooling ones are skipped. */
  freeze: (engine: Address, safes: readonly Address[]): OwnerCall =>
    call(
      engine,
      encodeFunctionData({ abi: policyEngineV2Abi, functionName: 'freeze', args: [safes] }),
      `freeze(${safes.length} Safe${safes.length === 1 ? '' : 's'})`,
    ),

  freezeActor: (engine: Address, safe: Address, actor: Address): OwnerCall =>
    call(
      engine,
      encodeFunctionData({ abi: policyEngineV2Abi, functionName: 'freezeActor', args: [safe, actor] }),
      `freezeActor(${actor})`,
    ),

  /** `actor = ANY` lifts the Safe-wide freeze. */
  lift: (engine: Address, safe: Address, actor: Address): OwnerCall =>
    call(
      engine,
      encodeFunctionData({ abi: policyEngineV2Abi, functionName: 'lift', args: [safe, actor] }),
      `lift(${actorLabel(actor)})`,
    ),
}

/** Safe self-calls used when installing the engine. */
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
 * Installs V2 on a Safe that has no V2 guard yet, in the only order that also works one
 * transaction at a time (WP7a, `Install.test.ts`): configure first (`GuardAlreadyEnabled` once
 * either guard is set), then the fallback handler (ERC-1271 only accepts on-chain approvals), the
 * module guard, and the transaction guard last (after `setGuard` every further owner transaction
 * is checked, so `setModuleGuard` would need the owners' Allow and wait their Timelock). As one
 * MultiSend batch the guard checks the batch once, before any of it runs. `configureImmediately`
 * only takes an empty configuration (SPEC §14 D-25): a Safe with leftovers changes them through
 * the delayed path first.
 */
export const installCalls = (safe: Address, deployment: V2Deployment, set: ChangeSet): OwnerCall[] => [
  engineCalls.configureImmediately(deployment.engine, set),
  safeCalls.setFallbackHandler(safe, deployment.fallbackHandler),
  safeCalls.setModuleGuard(safe, deployment.engine),
  safeCalls.setGuard(safe, deployment.engine),
]

/**
 * V2 needs Safe ≥ 1.5.0: older Safes have no module guard, so every module would run unchecked.
 * Parses `VERSION()` (`1.5.0`, `1.5.0+L2`).
 */
export function supportsV2(version: string): boolean {
  const [major = 0, minor = 0] = version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
  return major > 1 || (major === 1 && minor >= 5)
}

// ---------------------------------------------------------------------------------------------
// MultiSend batching
// ---------------------------------------------------------------------------------------------

/** `multiSend(bytes)` payload: packed `(uint8 op, address to, uint256 value, uint256 len, bytes data)`. */
export const encodeMultiSend = (
  calls: readonly Pick<OwnerCall, 'to' | 'value' | 'data' | 'operation'>[],
): Hex =>
  encodeFunctionData({
    abi: safeAdminAbi,
    functionName: 'multiSend',
    args: [
      concat(
        calls.map((c) =>
          encodePacked(
            ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
            [c.operation, c.to, c.value, BigInt(size(c.data)), c.data],
          ),
        ),
      ),
    ],
  })

/** One DELEGATECALL to a trusted batch contract (MultiSendCallOnly when every call is a CALL). */
export const batchCall = (multiSend: Address, calls: readonly OwnerCall[]): OwnerCall => ({
  to: getAddress(multiSend),
  value: 0n,
  data: encodeMultiSend(calls),
  operation: Operation.DELEGATECALL,
  description: calls.map((c) => c.description).join(' + '),
})

const CONFIG_SELECTORS: readonly Hex[] = [
  SELECTORS.requestConfiguration,
  SELECTORS.applyConfiguration,
  SELECTORS.invalidateRoot,
]

/** Calls the engine only accepts as a top-level zero-value CALL (SPEC §5.1), never inside a batch. */
export const isConfigurationCall = (engine: Address, c: Pick<OwnerCall, 'to' | 'data'>): boolean =>
  isAddressEqual(c.to, engine) &&
  size(c.data) >= 4 &&
  CONFIG_SELECTORS.includes(c.data.slice(0, 10).toLowerCase() as Hex)

/**
 * Turns a list of calls into the fewest owner transactions: configuration-path calls alone, the
 * rest batched in order through `multiSend` (≤ 8 calls per batch, the engine's cap), a single call
 * left as is.
 */
export function planOwnerTransactions(
  engine: Address,
  multiSend: Address,
  calls: readonly OwnerCall[],
): OwnerCall[] {
  const out: OwnerCall[] = []
  let pending: OwnerCall[] = []
  const flush = () => {
    for (let i = 0; i < pending.length; i += MAX_BATCH_CALLS) {
      const chunk = pending.slice(i, i + MAX_BATCH_CALLS)
      out.push(chunk.length === 1 ? chunk[0]! : batchCall(multiSend, chunk))
    }
    pending = []
  }
  for (const c of calls) {
    if (isConfigurationCall(engine, c)) {
      flush()
      out.push(c)
    } else pending.push(c)
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------

/** `any call`, `any function on USDC`, `transfer on any contract`, `USDC.transfer`. */
export function callPhrase(scope: Scope, ctx: LabelContext = {}): string {
  const target = () => ctx.nameOf?.(getAddress(scope.to)) ?? `${scope.to.slice(0, 6)}…${scope.to.slice(-4)}`
  const fn = () => selectorName(scope.selector) ?? scope.selector
  switch (scope.callMatch) {
    case CallMatch.ANY:
      return 'any call'
    case CallMatch.TO:
      return `any function on ${target()}`
    case CallMatch.SELECTOR:
      return `${fn()} on any contract`
    case CallMatch.TO_SELECTOR:
      return `${target()}.${fn()}`
  }
}

/**
 * The builder's live sentence: `Attaches Limit 5,000 USDC / month to Ops, any call`,
 * `Allows Ops: USDC.transfer`, `Removes Timelock 24h from Owners, any call`.
 */
export function describeChange(
  change: AttachmentChange,
  deployment: V2Deployment,
  ctx: LabelContext = {},
  /** The attachment already exists: a SET re-configures it (a Limit starts fresh budgets). */
  attached = false,
): string {
  const who = actorLabel(change.scope.actor, ctx.nameOf)
  const what = callPhrase(change.scope, ctx)
  const ops = normalizeOpMask(change.opMask) & OP_DELEGATECALL ? ' (DELEGATECALL included)' : ''
  const name = policyNameOf(deployment, change.policy)
  const policyLabel = (): string => {
    if (!name) return `policy ${change.policy}`
    if (change.changeType === ChangeType.DETACH) return POLICY_INFO[name].label
    try {
      return settingsLabel(decodeSettings(name, change.data), ctx)
    } catch {
      return `${POLICY_INFO[name].label} (bad settings)`
    }
  }
  const detach = change.changeType === ChangeType.DETACH
  switch (change.kind) {
    case AttachmentKind.ALLOW:
      return `${detach ? 'Stops allowing' : 'Allows'} ${who}: ${what}${detach ? '' : ops}`
    case AttachmentKind.DENY:
      return `${detach ? 'Stops denying' : 'Denies'} ${who}: ${what}`
    default:
      if (detach) return `Removes ${policyLabel()} from ${who}, ${what}`
      if (!attached) return `Attaches ${policyLabel()} to ${who}, ${what}`
      // LimitPolicy versions its budgets on every configure (review F10).
      return `Re-configures ${policyLabel()} for ${who}, ${what}${RECONFIGURE_NOTE[name ?? ''] ?? ''}`
  }
}

/** What re-configuring an attached policy resets (LimitPolicy versions its budgets, review F10). */
const RECONFIGURE_NOTE: Record<string, string> = {
  limit: ' (resets the budget: spent goes back to 0)',
  // TimelockPolicy counts the delay from the latest configuration (SPEC §14 D-20).
  timelock: ' (calls already scheduled wait the full delay again, from the change)',
}

export const describeRoleChange = (change: RoleChange, ctx: LabelContext = {}): string =>
  `${change.enabled ? 'Adds' : 'Removes'} ${ctx.nameOf?.(getAddress(change.account)) ?? change.account} ${change.enabled ? 'as' : 'from'} ${change.role === 0 ? 'guardian' : 'lifter'}`
