import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from 'viem'
import { limitPolicyAbi, policyEngineV2Abi, timelockPolicyAbi } from './abi'
import { POLICY_INFO, type PolicyName, type V2Deployment, policyNameOf } from './policies'
import {
  ANY,
  AttachmentKind,
  type CallMatch,
  ENGINE_V2_INTERFACE_ID,
  FreezeRole,
  OWNERS,
  type Operation,
  type PolicyLevel,
  type Scope,
  levelOf,
} from './scopes'
import { type PolicySettings, settingsFromView } from './settings'

/**
 * Reads a Safe's V2 configuration from the engine's enumeration views (SPEC §12) and folds it into
 * the org-chart model: the "Everyone" band (actor ANY) plus one card per actor, each attachment
 * with its decoded settings, and the freeze state per Safe and per actor.
 *
 * Every function takes the viem client explicitly so the agent can reuse them. Reads are issued in
 * parallel; with `batch: { multicall: true }` on the client (as `src/config/client.ts`) they go out
 * as one multicall.
 *
 * @example
 * const model = await loadSafeModel(publicClient, deployment, safe, { modules: state.modules })
 * model.everyone            // [{ kind: POLICY, policyName: 'freeze', ... }]
 * model.actors[0].actor     // OWNERS (always first)
 * model.actors[0].attachments.map((a) => a.label) …
 */

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

/** `AttachmentView` of the engine, with plain TS types. */
export type AttachmentView = {
  attachmentId: Hex
  scopeKey: Hex
  scope: Scope
  kind: AttachmentKind
  policy: Address
  opMask: number
  policyLevel: PolicyLevel
}

export type Attachment = AttachmentView & {
  /** Scope level 0..7. */
  level: number
  /** Known V2 policy (undefined for built-ins and unknown contracts). */
  policyName?: PolicyName
  /** Decoded settings of a known policy; `settingsError` when the read failed. */
  settings?: PolicySettings
  settingsError?: string
}

/** Where an attachment shows on an actor card. */
export type AttachmentRole = 'canDo' | 'limitedBy' | 'protectedBy' | 'denied'

export type FreezePhase = 'none' | 'frozen' | 'cooldown'

export type FreezeState = { frozenAt: bigint; frozenUntil: bigint; cooldownUntil: bigint; epoch: bigint }

export type FreezeView = FreezeState & {
  /** `ANY` for the Safe-wide freeze. */
  actor: Address
  phase: FreezePhase
  /** End of the current phase (frozen until / cooling down until); 0 when `none`. */
  until: bigint
}

export type Roles = { guardians: Address[]; lifters: Address[] }

export type ActorCard = {
  actor: Address
  /** Enabled as a module on the Safe (false for OWNERS and for actors with stale attachments). */
  isModule: boolean
  attachments: Attachment[]
  /** The actor's own freeze (`freezeActor`); undefined for OWNERS, who are frozen Safe-wide only. */
  freeze?: FreezeView
}

export type SafeV2Model = {
  safe: Address
  engine: Address
  /** Actor ANY: global and call-wide scopes (levels 0..3). */
  everyone: Attachment[]
  /** OWNERS first, then enabled modules (in Safe order), then other actors that have attachments. */
  actors: ActorCard[]
  roles: Roles
  /** The Safe-wide freeze. */
  freeze: FreezeView
  /** Every attachment, in engine order. */
  attachments: Attachment[]
}

export const attachmentRole = (a: Pick<Attachment, 'kind' | 'policyName'>): AttachmentRole => {
  if (a.kind === AttachmentKind.ALLOW) return 'canDo'
  if (a.kind === AttachmentKind.DENY) return 'denied'
  switch (a.policyName) {
    case 'freeze':
    case 'timelock':
    case 'coSigner':
    case 'safenet':
      return 'protectedBy'
    default:
      return 'limitedBy'
  }
}

/** Phase of a freeze key at `now` (unix seconds), SPEC §7.1. */
export function freezeView(actor: Address, state: FreezeState, now: bigint): FreezeView {
  if (now < state.frozenUntil) return { ...state, actor, phase: 'frozen', until: state.frozenUntil }
  if (now < state.cooldownUntil) return { ...state, actor, phase: 'cooldown', until: state.cooldownUntil }
  return { ...state, actor, phase: 'none', until: 0n }
}

const EMPTY_FREEZE: FreezeState = { frozenAt: 0n, frozenUntil: 0n, cooldownUntil: 0n, epoch: 0n }

const byLevel = (a: Attachment, b: Attachment) => a.level - b.level

/**
 * Groups attachments into the org chart (pure). `freezes` holds the engine freeze state per key
 * (`ANY` and module actors); missing keys read as never frozen.
 */
export function buildModel(input: {
  safe: Address
  engine: Address
  attachments: readonly Attachment[]
  modules: readonly Address[]
  roles: Roles
  freezes: ReadonlyMap<Address, FreezeState>
  now: bigint
}): SafeV2Model {
  const freezeOf = (actor: Address) =>
    freezeView(actor, input.freezes.get(getAddress(actor)) ?? EMPTY_FREEZE, input.now)
  const order: Address[] = [OWNERS, ...input.modules.map((m) => getAddress(m))]
  for (const a of input.attachments) {
    const actor = getAddress(a.scope.actor)
    if (!isAddressEqual(actor, ANY) && !order.some((o) => isAddressEqual(o, actor))) order.push(actor)
  }
  const actors = order.map((actor): ActorCard => ({
    actor,
    isModule: input.modules.some((m) => isAddressEqual(m, actor)),
    attachments: input.attachments.filter((a) => isAddressEqual(a.scope.actor, actor)).sort(byLevel),
    freeze: isAddressEqual(actor, OWNERS) ? undefined : freezeOf(actor),
  }))
  return {
    safe: input.safe,
    engine: input.engine,
    everyone: input.attachments.filter((a) => isAddressEqual(a.scope.actor, ANY)).sort(byLevel),
    actors,
    roles: input.roles,
    freeze: freezeOf(ANY),
    attachments: [...input.attachments],
  }
}

/** Adds level and policy name to an engine view (pure). */
export function toAttachment(view: AttachmentView, deployment: V2Deployment): Attachment {
  return {
    ...view,
    level: levelOf(view.scope),
    policyName: view.kind === AttachmentKind.POLICY ? policyNameOf(deployment, view.policy) : undefined,
  }
}

type RawAttachmentView = {
  attachmentId: Hex
  scopeKey: Hex
  scope: { actor: Address; to: Address; selector: Hex; callMatch: number }
  kind: number
  policy: Address
  opMask: number
  policyLevel: number
}

const fromRaw = (raw: RawAttachmentView): AttachmentView => ({
  attachmentId: raw.attachmentId,
  scopeKey: raw.scopeKey,
  scope: { ...raw.scope, callMatch: raw.scope.callMatch as CallMatch },
  kind: raw.kind as AttachmentKind,
  policy: raw.policy,
  opMask: raw.opMask,
  policyLevel: raw.policyLevel as PolicyLevel,
})

// ---------------------------------------------------------------------------------------------
// Engine reads (one function per view)
// ---------------------------------------------------------------------------------------------

/** `supportsInterface(IPolicyEngineV2)`: picks the V2 screens for an installed guard. */
export async function isEngineV2(client: PublicClient, guard: Address): Promise<boolean> {
  if (isAddressEqual(guard, zeroAddress)) return false
  try {
    return await client.readContract({
      address: guard,
      abi: policyEngineV2Abi,
      functionName: 'supportsInterface',
      args: [ENGINE_V2_INTERFACE_ID],
    })
  } catch {
    return false
  }
}

export type EngineInfo = {
  delay: bigint
  expiry: bigint
  maxFreeze: bigint
  freezeCooldown: bigint
  signLib: Address
  trustedBatches: readonly Address[]
}

/** The engine's immutables. */
export async function readEngineInfo(client: PublicClient, engine: Address): Promise<EngineInfo> {
  const read = <F extends 'DELAY' | 'EXPIRY' | 'MAX_FREEZE' | 'FREEZE_COOLDOWN'>(functionName: F) =>
    client.readContract({ address: engine, abi: policyEngineV2Abi, functionName })
  const [delay, expiry, maxFreeze, freezeCooldown, signLib, trustedBatches] = await Promise.all([
    read('DELAY'),
    read('EXPIRY'),
    read('MAX_FREEZE'),
    read('FREEZE_COOLDOWN'),
    client.readContract({ address: engine, abi: policyEngineV2Abi, functionName: 'SIGN_LIB' }),
    client.readContract({ address: engine, abi: policyEngineV2Abi, functionName: 'getTrustedBatches' }),
  ])
  return { delay, expiry, maxFreeze, freezeCooldown, signLib, trustedBatches }
}

/** `getAttachments(safe)`: every attachment, grouped by scope. */
export async function readAttachments(
  client: PublicClient,
  engine: Address,
  safe: Address,
): Promise<AttachmentView[]> {
  const views = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'getAttachments',
    args: [safe],
  })
  return views.map(fromRaw)
}

/** `getScopes(safe)`: populated scopes and their keys. */
export async function readScopes(
  client: PublicClient,
  engine: Address,
  safe: Address,
): Promise<{ key: Hex; scope: Scope }[]> {
  const [keys, scopes] = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'getScopes',
    args: [safe],
  })
  return keys.map((key, i) => {
    const scope = scopes[i]!
    return { key, scope: { ...scope, callMatch: scope.callMatch as CallMatch } }
  })
}

/** `getScopeAttachments(safe, key)`: the attachments of one scope, in storage order. */
export async function readScopeAttachments(
  client: PublicClient,
  engine: Address,
  safe: Address,
  key: Hex,
): Promise<AttachmentView[]> {
  const views = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'getScopeAttachments',
    args: [safe, key],
  })
  return views.map(fromRaw)
}

/** `getAttachment(safe, id)`, or undefined if not attached. */
export async function readAttachment(
  client: PublicClient,
  engine: Address,
  safe: Address,
  attachmentId: Hex,
): Promise<AttachmentView | undefined> {
  const [exists, view] = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'getAttachment',
    args: [safe, attachmentId],
  })
  return exists ? fromRaw(view) : undefined
}

/** `levelsUsed(safe)`: bit i set iff level i is populated. */
export async function readLevelsUsed(client: PublicClient, engine: Address, safe: Address): Promise<number> {
  return client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'levelsUsed',
    args: [safe],
  })
}

/** `getRoleMembers` for both roles. */
export async function readRoles(client: PublicClient, engine: Address, safe: Address): Promise<Roles> {
  const [guardians, lifters] = await Promise.all(
    [FreezeRole.GUARDIAN, FreezeRole.LIFTER].map((role) =>
      client.readContract({
        address: engine,
        abi: policyEngineV2Abi,
        functionName: 'getRoleMembers',
        args: [safe, role],
      }),
    ),
  )
  return { guardians: [...(guardians ?? [])], lifters: [...(lifters ?? [])] }
}

/** `getFreezeState(safe, actor)`; `ANY` for the Safe-wide freeze. */
export async function readFreezeState(
  client: PublicClient,
  engine: Address,
  safe: Address,
  actor: Address,
): Promise<FreezeState> {
  const s = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'getFreezeState',
    args: [safe, actor],
  })
  return { frozenAt: s.frozenAt, frozenUntil: s.frozenUntil, cooldownUntil: s.cooldownUntil, epoch: s.epoch }
}

/** `freezeStatus(safe, actor)`: what FreezePolicy and TimelockPolicy read. */
export async function readFreezeStatus(
  client: PublicClient,
  engine: Address,
  safe: Address,
  actor: Address,
): Promise<{ safeFrozen: boolean; actorFrozen: boolean; epoch: bigint }> {
  const [safeFrozen, actorFrozen, epoch] = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'freezeStatus',
    args: [safe, actor],
  })
  return { safeFrozen, actorFrozen, epoch }
}

/** `rootConfigured(safe, root)`: when a requested root becomes applicable, 0 if not requested. */
export async function readRootValidFrom(
  client: PublicClient,
  engine: Address,
  safe: Address,
  root: Hex,
): Promise<bigint> {
  return client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'rootConfigured',
    args: [safe, root],
  })
}

export type RootStatus = 'none' | 'pending' | 'ready' | 'expired'

/** SPEC §5.1: pending before `validFrom`, applicable until `validFrom + EXPIRY`. */
export const rootStatus = (validFrom: bigint, expiry: bigint, now: bigint): RootStatus =>
  validFrom === 0n ? 'none' : now < validFrom ? 'pending' : now < validFrom + expiry ? 'ready' : 'expired'

export type MatchView = { callIndex: number; scopeLevel: number; attachment: AttachmentView }

/**
 * `getMatchingAttachments`: what a transaction would match per call (batch sub-calls included),
 * without running policies. `policy` filters to one policy contract (`zeroAddress` = all).
 */
export async function readMatchingAttachments(
  client: PublicClient,
  engine: Address,
  safe: Address,
  actor: Address,
  call: { to: Address; value: bigint; data: Hex; operation: Operation },
  policy: Address = zeroAddress,
): Promise<MatchView[]> {
  const matches = await client.readContract({
    address: engine,
    abi: policyEngineV2Abi,
    functionName: 'getMatchingAttachments',
    args: [safe, actor, call.to, call.value, call.data, call.operation, policy],
  })
  return matches.map((m) => ({
    callIndex: m.callIndex,
    scopeLevel: m.scopeLevel,
    attachment: fromRaw(m.attachment),
  }))
}

// ---------------------------------------------------------------------------------------------
// Policy reads
// ---------------------------------------------------------------------------------------------

/** `getSettings(engine, safe, id)` of a known policy, decoded. Safenet has no settings. */
export async function readPolicySettings(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  policy: PolicyName,
  attachmentId: Hex,
): Promise<PolicySettings> {
  if (policy === 'safenet') return { policy, settings: null }
  const view = await client.readContract({
    address: deployment.policies[policy],
    // Every policy ABI has the same `getSettings(engine, safe, id)` signature; only the struct differs.
    abi: POLICY_INFO[policy].abi as Abi,
    functionName: 'getSettings',
    args: [deployment.engine, safe, attachmentId],
  })
  return settingsFromView(policy, view)
}

export type LimitRemaining = {
  amount: bigint
  spent: bigint
  available: bigint
  period: bigint
  windowStart: bigint
}

/** LimitPolicy `remaining(engine, safe, id, token)`: the budget as it applies now. */
export async function readLimitRemaining(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  attachmentId: Hex,
  token: Address,
): Promise<LimitRemaining> {
  return client.readContract({
    address: deployment.policies.limit,
    abi: limitPolicyAbi,
    functionName: 'remaining',
    args: [deployment.engine, safe, attachmentId, token],
  })
}

// Not in the frozen ILimitPolicy (added by WP4).
const limitReservedAbi = parseAbi([
  'function reserved(address engine, address safe, bytes32 id, address token, address spender) view returns (uint256)',
])

/** LimitPolicy `reserved`: the approval to `spender` counted against the budget in this window. */
export async function readLimitReserved(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  attachmentId: Hex,
  token: Address,
  spender: Address,
): Promise<bigint> {
  return client.readContract({
    address: deployment.policies.limit,
    abi: limitReservedAbi,
    functionName: 'reserved',
    args: [deployment.engine, safe, attachmentId, token, spender],
  })
}

/** TimelockPolicy owners' consecutive-cancel count and the signatures the next cancel needs. */
export async function readCancelState(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
): Promise<{ cancelCount: bigint; requiredSignatures: bigint }> {
  const args = [deployment.engine, safe] as const
  const [cancelCount, requiredSignatures] = await Promise.all([
    client.readContract({
      address: deployment.policies.timelock,
      abi: timelockPolicyAbi,
      functionName: 'cancelCount',
      args,
    }),
    client.readContract({
      address: deployment.policies.timelock,
      abi: timelockPolicyAbi,
      functionName: 'requiredCancelSignatures',
      args,
    }),
  ])
  return { cancelCount, requiredSignatures }
}

// ---------------------------------------------------------------------------------------------
// Everything at once
// ---------------------------------------------------------------------------------------------

/**
 * Reads attachments, their settings, roles and freeze states, and builds the org chart. A failing
 * settings read is kept on the attachment as `settingsError` instead of failing the whole load.
 */
export async function loadSafeModel(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  options: { modules?: readonly Address[]; now?: bigint } = {},
): Promise<SafeV2Model> {
  const { engine } = deployment
  const modules = options.modules ?? []
  const [views, roles, block] = await Promise.all([
    readAttachments(client, engine, safe),
    readRoles(client, engine, safe),
    options.now === undefined ? client.getBlock() : undefined,
  ])
  const now = options.now ?? block!.timestamp

  const attachments = await Promise.all(
    views.map(async (view): Promise<Attachment> => {
      const attachment = toAttachment(view, deployment)
      if (!attachment.policyName) return attachment
      try {
        const settings = await readPolicySettings(
          client,
          deployment,
          safe,
          attachment.policyName,
          view.attachmentId,
        )
        return { ...attachment, settings }
      } catch (error) {
        return { ...attachment, settingsError: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  const freezeKeys = [ANY, ...modules, ...attachments.map((a) => a.scope.actor)]
    .map((a) => getAddress(a))
    .filter((a, i, all) => !isAddressEqual(a, OWNERS) && all.indexOf(a) === i)
  const states = await Promise.all(freezeKeys.map((actor) => readFreezeState(client, engine, safe, actor)))
  const freezes = new Map(freezeKeys.map((actor, i) => [actor, states[i]!]))

  return buildModel({ safe, engine, attachments, modules, roles, freezes, now })
}
