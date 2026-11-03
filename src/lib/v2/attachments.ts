import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  getAddress,
  isAddressEqual,
  zeroAddress,
} from 'viem'
import { limitPolicyAbi, policyGuardAbi, timelockPolicyAbi } from './abi'
import { POLICY_INFO, type PolicyName, type V2Deployment, policyNameOf } from './policies'
import {
  ANY,
  type CallMatch,
  InterfaceIds,
  Kind,
  OWNERS,
  type Scope,
  isAny,
  isOwners,
  levelOf,
} from './scopes'
import { type PolicySettings, settingsFromView } from './settings'

/**
 * Reads a Safe's rev 3 configuration from the engine views (`getScopes`, `getAttachments`) and the
 * policies' `getSettings`, and folds it into the org-chart model: the "Everyone" band (actor ANY)
 * plus one card per actor. Timelock attachments carry their freeze state.
 *
 * Every function takes the viem client explicitly so the agent can reuse them.
 *
 * @example
 * const model = await loadSafeModel(publicClient, deployment, safe, { modules: state.modules })
 * model.actors[0].actor     // OWNERS (always first)
 * model.actors[0].attachments.filter((a) => attachmentRole(a) === 'protectedBy')
 */

/** `AttachmentView` of the engine, with plain TS types. */
export type AttachmentView = {
  attachmentId: Hex
  scopeKey: Hex
  scope: Scope
  kind: Kind
  policy: Address
  opMask: number
}

/** Freeze state of one Timelock attachment (TimelockPolicy `freezeState`). */
export type FreezeState = { frozenUntil: bigint; cooldownUntil: bigint }
export type FreezePhase = 'active' | 'frozen' | 'cooldown'

export type Attachment = AttachmentView & {
  /** Scope level 0..5. */
  level: number
  /** Known policy (undefined for ALLOW / DENY and unknown contracts). */
  policyName?: PolicyName
  /** Decoded settings of a known policy; `settingsError` when the read or decode failed. */
  settings?: PolicySettings
  settingsError?: string
  /** Timelock only. */
  freeze?: FreezeState
}

/** Where an attachment shows on an actor card. */
export type AttachmentRole = 'canDo' | 'limitedBy' | 'protectedBy'

export const attachmentRole = (a: Pick<Attachment, 'kind' | 'policyName'>): AttachmentRole => {
  if (a.kind === Kind.ALLOW) return 'canDo'
  if (a.kind === Kind.DENY) return 'limitedBy'
  return a.policyName === 'timelock' || a.policyName === 'coSigner' || a.policyName === 'safenet'
    ? 'protectedBy'
    : 'limitedBy'
}

export const freezePhase = (state: FreezeState | undefined, now: bigint): FreezePhase =>
  !state ? 'active' : now < state.frozenUntil ? 'frozen' : now < state.cooldownUntil ? 'cooldown' : 'active'

export type ActorCard = {
  actor: Address
  /** Enabled as a module (false for OWNERS and for actors with stale attachments). */
  isModule: boolean
  attachments: Attachment[]
}

export type SafeV2Model = {
  safe: Address
  engine: Address
  /** Actor ANY: levels 0..2. */
  everyone: Attachment[]
  /** OWNERS first, then enabled modules (in Safe order), then other actors that have attachments. */
  actors: ActorCard[]
  /** Every attachment, in engine order. */
  attachments: Attachment[]
  /** Block time of the read. */
  now: bigint
}

const byLevel = (a: Attachment, b: Attachment) => a.level - b.level

/** Groups attachments into the org chart (pure). */
export function buildModel(input: {
  safe: Address
  engine: Address
  attachments: readonly Attachment[]
  modules: readonly Address[]
  now: bigint
}): SafeV2Model {
  const order: Address[] = [OWNERS, ...input.modules.map((m) => getAddress(m))]
  for (const a of input.attachments) {
    const actor = getAddress(a.scope.actor)
    if (!isAny(actor) && !order.some((o) => isAddressEqual(o, actor))) order.push(actor)
  }
  return {
    safe: input.safe,
    engine: input.engine,
    everyone: input.attachments.filter((a) => isAny(a.scope.actor)).sort(byLevel),
    actors: order.map((actor) => ({
      actor,
      isModule: input.modules.some((m) => isAddressEqual(m, actor)),
      attachments: input.attachments.filter((a) => isAddressEqual(a.scope.actor, actor)).sort(byLevel),
    })),
    attachments: [...input.attachments],
    now: input.now,
  }
}

/** Adds level and policy name to an engine view (pure). */
export const toAttachment = (view: AttachmentView, deployment: V2Deployment): Attachment => ({
  ...view,
  level: levelOf(view.scope),
  policyName: view.kind === Kind.POLICY ? policyNameOf(deployment, view.policy) : undefined,
})

type RawView = {
  attachmentId: Hex
  scopeKey: Hex
  scope: { actor: Address; to: Address; selector: Hex; callMatch: number }
  kind: number
  policy: Address
  opMask: number
}

export const fromRawView = (raw: RawView): AttachmentView => ({
  attachmentId: raw.attachmentId,
  scopeKey: raw.scopeKey,
  scope: { ...raw.scope, callMatch: raw.scope.callMatch as CallMatch },
  kind: raw.kind as Kind,
  policy: raw.policy,
  opMask: raw.opMask,
})

// ---------------------------------------------------------------------------------------------
// Engine reads
// ---------------------------------------------------------------------------------------------

/** `supportsInterface(IPolicyGuard)`: picks the V2 screens for an installed guard. */
export async function isEngineV2(client: PublicClient, guard: Address): Promise<boolean> {
  if (isAddressEqual(guard, zeroAddress)) return false
  try {
    return await client.readContract({
      address: guard,
      abi: policyGuardAbi,
      functionName: 'supportsInterface',
      args: [InterfaceIds.IPolicyGuard],
    })
  } catch {
    return false
  }
}

/** `getAttachments(safe)`: every attachment, grouped by scope. */
export async function readAttachments(
  client: PublicClient,
  engine: Address,
  safe: Address,
): Promise<AttachmentView[]> {
  const views = await client.readContract({
    address: engine,
    abi: policyGuardAbi,
    functionName: 'getAttachments',
    args: [safe],
  })
  return views.map(fromRawView)
}

/** `getScopes(safe)`: populated scopes and their keys. */
export async function readScopes(
  client: PublicClient,
  engine: Address,
  safe: Address,
): Promise<{ key: Hex; scope: Scope }[]> {
  const [keys, scopes] = await client.readContract({
    address: engine,
    abi: policyGuardAbi,
    functionName: 'getScopes',
    args: [safe],
  })
  return keys.map((key, i) => {
    const scope = scopes[i]!
    return { key, scope: { ...scope, callMatch: scope.callMatch as CallMatch } }
  })
}

/** `getAttachment(safe, id)`, or undefined once detached. */
export async function readAttachment(
  client: PublicClient,
  engine: Address,
  safe: Address,
  id: Hex,
): Promise<AttachmentView | undefined> {
  const [exists, view] = await client.readContract({
    address: engine,
    abi: policyGuardAbi,
    functionName: 'getAttachment',
    args: [safe, id],
  })
  return exists ? fromRawView(view) : undefined
}

/** `trustedBatches()`, fixed at deployment. */
export const readTrustedBatches = async (client: PublicClient, engine: Address): Promise<Address[]> => [
  ...(await client.readContract({ address: engine, abi: policyGuardAbi, functionName: 'trustedBatches' })),
]

// ---------------------------------------------------------------------------------------------
// Policy reads
// ---------------------------------------------------------------------------------------------

/** `getSettings(engine, safe, id)` of a known policy, decoded. Safenet has none. */
export async function readPolicySettings(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  policy: PolicyName,
  id: Hex,
): Promise<PolicySettings> {
  if (policy === 'safenet') return { policy, settings: null }
  const view = await client.readContract({
    address: deployment.policies[policy],
    // Every policy has the same `getSettings(engine, safe, id)` signature; only the struct differs.
    abi: POLICY_INFO[policy].abi as Abi,
    functionName: 'getSettings',
    args: [deployment.engine, safe, id],
  })
  return settingsFromView(policy, view)
}

/** TimelockPolicy `freezeState(engine, safe, id)`. */
export async function readFreezeState(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  id: Hex,
): Promise<FreezeState> {
  const [frozenUntil, cooldownUntil] = await client.readContract({
    address: deployment.policies.timelock,
    abi: timelockPolicyAbi,
    functionName: 'freezeState',
    args: [deployment.engine, safe, id],
  })
  return { frozenUntil: BigInt(frozenUntil), cooldownUntil: BigInt(cooldownUntil) }
}

/** TimelockPolicy `MAX_FREEZE` (F) and `COOLDOWN` (C). */
export async function readFreezeLimits(
  client: PublicClient,
  deployment: V2Deployment,
): Promise<{ maxFreeze: bigint; cooldown: bigint }> {
  const address = deployment.policies.timelock
  const [maxFreeze, cooldown] = await Promise.all([
    client.readContract({ address, abi: timelockPolicyAbi, functionName: 'MAX_FREEZE' }),
    client.readContract({ address, abi: timelockPolicyAbi, functionName: 'COOLDOWN' }),
  ])
  return { maxFreeze, cooldown }
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
  id: Hex,
  token: Address,
): Promise<LimitRemaining> {
  const r = await client.readContract({
    address: deployment.policies.limit,
    abi: limitPolicyAbi,
    functionName: 'remaining',
    args: [deployment.engine, safe, id, token],
  })
  return { ...r, period: BigInt(r.period), windowStart: BigInt(r.windowStart) }
}

/** When the budget window of `r` resets (undefined for a one-time budget). */
export const limitResetsAt = (r: Pick<LimitRemaining, 'period' | 'windowStart'>): bigint | undefined =>
  r.period === 0n ? undefined : r.windowStart + r.period

// ---------------------------------------------------------------------------------------------
// Everything at once
// ---------------------------------------------------------------------------------------------

/** Settings (and Timelock freeze state) of one attachment; a failed read is kept as `settingsError`. */
export async function enrichAttachment(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  view: AttachmentView,
): Promise<Attachment> {
  const a = toAttachment(view, deployment)
  if (!a.policyName) return a
  try {
    const [settings, freeze] = await Promise.all([
      readPolicySettings(client, deployment, safe, a.policyName, a.attachmentId),
      a.policyName === 'timelock' ? readFreezeState(client, deployment, safe, a.attachmentId) : undefined,
    ])
    return { ...a, settings, freeze }
  } catch (error) {
    return { ...a, settingsError: error instanceof Error ? error.message : String(error) }
  }
}

/** Reads attachments with their settings and builds the org chart. */
export async function loadSafeModel(
  client: PublicClient,
  deployment: V2Deployment,
  safe: Address,
  options: { modules?: readonly Address[] } = {},
): Promise<SafeV2Model> {
  const [views, block] = await Promise.all([
    readAttachments(client, deployment.engine, safe),
    client.getBlock(),
  ])
  const attachments = await Promise.all(views.map((v) => enrichAttachment(client, deployment, safe, v)))
  return buildModel({
    safe,
    engine: deployment.engine,
    attachments,
    modules: options.modules ?? [],
    now: block.timestamp,
  })
}

/** Attachments of `actor` (or of Everyone), owners-path aware: OWNERS is never a module. */
export const attachmentsOf = (attachments: readonly Attachment[], actor: Address): Attachment[] =>
  attachments.filter((a) => isAddressEqual(a.scope.actor, actor))

/** OWNERS first, Everyone last: a stable order for lists of actors. */
export const actorOrder = (a: Address, b: Address): number =>
  (isOwners(a) ? -1 : isAny(a) ? 1 : 0) - (isOwners(b) ? -1 : isAny(b) ? 1 : 0)

export const EVERYONE: Address = ANY
