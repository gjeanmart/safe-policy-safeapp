import { existsSync, readFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from 'viem'
import { safeAbi } from '../../src/abi'
import { publicClient } from '../../src/config/client'
import * as appContracts from '../../src/config/contracts'
import { describeError, describeRevertData } from '../../src/lib/errors'
import type { ModuleTx } from '../../src/lib/moduleTx'
import type { SafeState } from '../../src/lib/safe'
import {
  ANY,
  type Attachment,
  AttachmentKind,
  EXACT_LEVEL,
  ENGINE_V2_INTERFACE_ID,
  type FreezeView,
  type Gate,
  GateKind,
  type LabelContext,
  NO_LEVEL,
  POLICY_INFO,
  type PreviewOutcome,
  type Schedule,
  type ScheduleStatus,
  type TimelockSettings,
  type V2Deployment,
  MODULE_PROOF_LIFETIME,
  Verdict,
  collapseGates,
  coSignerModuleTxDigest,
  deploymentNames,
  describeReason,
  amountLabel,
  durationLabel,
  freezeView,
  loadSafeModel,
  moduleCallHash,
  policyEngineV2Abi,
  readCoSignerModuleTxNonce,
  readEngineInfo,
  readFreezeState,
  readFreezeStatus,
  readLimitRemaining,
  readMatchingAttachments,
  readPolicySettings,
  readRoles,
  readSchedule,
  readTimelockConfiguredAt,
  revertDataOf,
  runPreview,
  safenetModuleTxDigest,
  scheduleStatus,
  scopeLabel,
  selectorName,
  settingsLabel,
  timelockPolicyAbi,
} from '../../src/lib/v2'
import { type Config, nameAddress, tokenByAddress } from './config'
import { CliError } from './output'

/**
 * Policy Engine V2 support for the role (SPEC: contracts/contracts/v2/SPEC.md). The V1 code paths
 * in chain.ts stay as they were; they branch here when the Safe's guard is a V2 engine.
 *
 * Module-path identity is the `callHash` (SPEC §7): a Timelock schedule, a co-signature or a Safenet
 * attestation for the role's call is keyed by it and consumed when the call executes.
 */

// The V2 lib takes a PublicClient; the app's client is a `let` rebuilt when the RPC URL changes.
const client = (): PublicClient => publicClient as unknown as PublicClient

// ---------------------------------------------------------------------------------------------
// Detection and deployment
// ---------------------------------------------------------------------------------------------

/** ITransactionGuard, IModuleGuard, and the engine's own interface (SPEC §6.1). */
const V2_INTERFACES: readonly Hex[] = ['0xe6d7a83a', '0x58401ed8', ENGINE_V2_INTERFACE_ID]

/** True iff `address` answers `supportsInterface` for all three V2 interfaces. */
export async function isV2Engine(address: Address): Promise<boolean> {
  if (isAddressEqual(address, zeroAddress)) return false
  try {
    const answers = await Promise.all(
      V2_INTERFACES.map((id) =>
        client().readContract({
          address,
          abi: policyEngineV2Abi,
          functionName: 'supportsInterface',
          args: [id],
        }),
      ),
    )
    return answers.every(Boolean)
  } catch {
    return false
  }
}

/** The V2 engine guarding this Safe, if any: the module guard first (it scopes the role). */
export async function detectV2(
  state: SafeState,
): Promise<{ engine: Address; modulePath: boolean; ownerPath: boolean } | undefined> {
  const [moduleIsV2, guardIsV2] = await Promise.all([isV2Engine(state.moduleGuard), isV2Engine(state.guard)])
  const engine = moduleIsV2 ? state.moduleGuard : guardIsV2 ? state.guard : undefined
  if (!engine) return undefined
  return {
    engine: getAddress(engine),
    modulePath: moduleIsV2 && isAddressEqual(state.moduleGuard, engine),
    ownerPath: guardIsV2 && isAddressEqual(state.guard, engine),
  }
}

const looksLikeDeployment = (value: unknown): value is V2Deployment => {
  const v = value as Partial<V2Deployment> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.engine === 'string' &&
    isAddress(v.engine) &&
    typeof v.policies === 'object' &&
    v.policies !== null &&
    'timelock' in v.policies
  )
}

/** V2Deployment-shaped values anywhere in a value (an object, an array, or a record of them). */
function collectDeployments(value: unknown, depth = 0, out: V2Deployment[] = []): V2Deployment[] {
  if (looksLikeDeployment(value)) out.push(value)
  else if (depth < 2 && Array.isArray(value)) value.forEach((v) => collectDeployments(v, depth + 1, out))
  else if (depth < 2 && typeof value === 'object' && value !== null)
    Object.values(value).forEach((v) => collectDeployments(v, depth + 1, out))
  return out
}

/** `SAFE_ROLE_V2_DEPLOYMENT`: the JSON printed by `pnpm deploy:v2:sepolia`, inline or a file path. */
function envDeployments(): V2Deployment[] {
  const raw = process.env.SAFE_ROLE_V2_DEPLOYMENT?.trim()
  if (!raw) return []
  const text =
    raw.startsWith('{') || raw.startsWith('[') ? raw : existsSync(raw) ? readFileSync(raw, 'utf8') : ''
  if (!text) throw new CliError(`SAFE_ROLE_V2_DEPLOYMENT: no such file ${raw}.`)
  try {
    const found = collectDeployments(JSON.parse(text))
    if (!found.length) throw new Error('no { engine, policies } object')
    return found
  } catch (error) {
    throw new CliError(
      `SAFE_ROLE_V2_DEPLOYMENT is not a V2Deployment: ${error instanceof Error ? error.message : String(error)}`,
      'Paste one "// V2Deployment" JSON block printed by the deploy script.',
    )
  }
}

const isDeployed = (d: V2Deployment) => !isAddressEqual(d.engine, zeroAddress)

/**
 * Known V2 deployments: the override first, then whatever src/config/contracts.ts exports in the
 * `V2Deployment` shape (whatever its name), skipping zero-address placeholders.
 */
export function knownDeployments(): V2Deployment[] {
  return [...envDeployments(), ...collectDeployments(appContracts)].filter(isDeployed)
}

/**
 * The deployment of `engine`. Policies are shared between engines (they key state by engine), so a
 * known deployment of another engine lends its policy addresses when this one is not listed.
 */
export function deploymentFor(engine: Address): V2Deployment {
  const known = knownDeployments()
  const exact = known.find((d) => isAddressEqual(d.engine, engine))
  if (exact) return exact
  const other = known[0]
  if (other) return { ...other, engine }
  throw new CliError(
    `This Safe's guard ${engine} is a Policy Engine V2, but no V2 addresses are configured: V2 is not ` +
      'deployed in src/config/contracts.ts yet.',
    'Start the CLI/signer with SAFE_ROLE_V2_DEPLOYMENT=<file or JSON of the V2Deployment printed by ' +
      '`pnpm deploy:v2:sepolia`> (or pass --v2-deployment <file>).',
  )
}

export type V2Context = {
  engine: Address
  deployment: V2Deployment
  /** The engine is the Safe's module guard: the role's calls are checked. */
  modulePath: boolean
  ownerPath: boolean
  labels: LabelContext
}

/** Names every address the CLI knows: address book, Safe, role, tokens, V2 contracts. */
export function labelContext(config: Config, deployment: V2Deployment): LabelContext {
  const names = deploymentNames(deployment)
  return {
    tokenOf: (token) => tokenByAddress(token),
    nameOf: (address) =>
      isAddressEqual(address, zeroAddress)
        ? undefined
        : (nameAddress(config, address).name ?? names(address)),
  }
}

export async function v2Context(config: Config, state: SafeState): Promise<V2Context | undefined> {
  const found = await detectV2(state)
  if (!found) return undefined
  const deployment = deploymentFor(found.engine)
  return { ...found, deployment, labels: labelContext(config, deployment) }
}

/** For the V2-only commands (schedule, queue). */
export function requireV2(ctx: V2Context | undefined): V2Context {
  if (ctx) return ctx
  const deployed = knownDeployments().length > 0
  throw new CliError(
    deployed
      ? "This Safe's guard is not the Policy Engine V2: schedules and queues only exist on V2."
      : 'Policy Engine V2 is not deployed (no V2 addresses in src/config/contracts.ts), and this Safe uses V1.',
    'Run safe-role status to see which guard the Safe uses.',
  )
}

// ---------------------------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------------------------

export const isoTime = (seconds: bigint | number): string =>
  new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z')

/** `3m 05s`, `4h 12m`, `2d 3h`. */
export function countdown(seconds: bigint | number): string {
  let s = Math.max(0, Math.round(Number(seconds)))
  const d = Math.floor(s / 86_400)
  s -= d * 86_400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

const now = async (): Promise<bigint> => (await client().getBlock()).timestamp

export type FreezeReport = {
  /** `active` = not frozen (V2's "ACTIVE" state, SPEC §7.1). */
  state: 'active' | 'frozen' | 'cooldown'
  until: string | null
  text: string
}

export function freezeReport(view: FreezeView, at: bigint): FreezeReport {
  if (view.phase === 'frozen')
    return {
      state: 'frozen',
      until: isoTime(view.until),
      text: `frozen until ${isoTime(view.until)} (in ${countdown(view.until - at)})`,
    }
  if (view.phase === 'cooldown')
    return {
      state: 'cooldown',
      until: isoTime(view.until),
      text: `active, cooling down until ${isoTime(view.until)} (cannot be frozen again before)`,
    }
  return { state: 'active', until: null, text: 'active (not frozen)' }
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export async function v2Status(config: Config, ctx: V2Context) {
  const { engine } = ctx
  const [info, safeFreeze, roleFreeze, roles, at] = await Promise.all([
    readEngineInfo(client(), engine),
    readFreezeState(client(), engine, config.safe, ANY),
    readFreezeState(client(), engine, config.safe, config.role),
    readRoles(client(), engine, config.safe),
    now(),
  ])
  const safe = freezeReport(freezeView(ANY, safeFreeze, at), at)
  const role = freezeReport(freezeView(config.role, roleFreeze, at), at)
  const name = (a: Address) => ctx.labels.nameOf?.(a) ?? a
  return {
    engine: {
      version: 'v2' as const,
      address: engine,
      modulePath: ctx.modulePath,
      ownerPath: ctx.ownerPath,
      configDelay: durationLabel(info.delay),
      maxFreeze: durationLabel(info.maxFreeze),
      freezeCooldown: durationLabel(info.freezeCooldown),
    },
    freeze: { safe, role, guardians: roles.guardians.map(name), lifters: roles.lifters.map(name) },
  }
}

// ---------------------------------------------------------------------------------------------
// Simulate: preview gates + a real dry run
// ---------------------------------------------------------------------------------------------

export type GateRow = {
  /** `0` (the call) or `tx` (transaction-level). */
  call: string
  scope: string
  gate: string
  verdict: 'allow' | 'pass' | 'deny'
  reason?: string
  needs?: string
}

export type V2Simulation = {
  engine: Address
  callHash: Hex
  allowed: boolean
  /** Denied: the gate a real execution reverts with. Allowed: the Allow that granted it. */
  deciding?: GateRow
  gates: GateRow[]
  needs: string[]
  /** What to do next, in order. */
  next: string[]
  /** `execTransactionFromModule` as an eth_call from the role (catches inner-call failures). */
  execution: { ok: boolean; reason?: string }
}

const VERDICTS = { [Verdict.PASS]: 'pass', [Verdict.ALLOW]: 'allow', [Verdict.DENY]: 'deny' } as const

function gateRow(g: Gate, byId: Map<string, Attachment>, ctx: V2Context): GateRow {
  const attachment = byId.get(g.attachmentId.toLowerCase())
  const scope =
    g.scopeLevel === NO_LEVEL || !attachment
      ? g.kind === GateKind.RULE
        ? 'engine rule'
        : `level ${g.scopeLevel}`
      : scopeLabel(attachment.scope, ctx.labels.nameOf, selectorName)
  let gate: string
  if (g.kind === GateKind.ALLOW) gate = 'Allow'
  else if (g.kind === GateKind.DENY) gate = 'Deny'
  else if (g.kind === GateKind.RULE) gate = `Engine: ${g.error?.name ?? 'rule'}`
  else {
    const label = g.policyName ? POLICY_INFO[g.policyName].label : (ctx.labels.nameOf?.(g.policy) ?? g.policy)
    gate = attachment?.settings ? settingsLabel(attachment.settings, ctx.labels) : label
  }
  return {
    call: g.txLevel ? 'tx' : String(g.callIndex),
    scope,
    gate,
    verdict: VERDICTS[g.verdict],
    ...(g.reasonText ? { reason: g.reasonText } : {}),
    ...(g.needs ? { needs: g.needs } : {}),
  }
}

/** Decodes a failed dry run with the V2 errors (engine rules, policy denies) and Safe GS codes. */
function describeV2Failure(error: unknown, labels: LabelContext): string {
  const data = revertDataOf(error)
  if (!data) return describeError(error)
  const { text, error: decoded } = describeReason(data, labels)
  if (decoded?.name === 'Error' || text.startsWith('unknown revert')) return describeRevertData(data)
  return decoded?.name === 'PolicyDenied' || !decoded ? text : `${decoded.name}: ${text}`
}

/** Next steps for a denied (or allowed) preview, specific enough for an agent to act on. */
async function nextSteps(
  config: Config,
  ctx: V2Context,
  planId: string,
  callHash: Hex,
  outcome: PreviewOutcome,
): Promise<string[]> {
  if (outcome.allowed) return [`Show the user the action and the deciding gate, then exec ${planId}.`]
  const steps: string[] = []
  const add = (s: string) => !steps.includes(s) && steps.push(s)
  const { deployment } = ctx
  for (const g of outcome.denies) {
    const args = g.error?.args ?? []
    switch (g.error?.name) {
      case 'NotScheduled':
        add(
          `Timelock: schedule it first (safe-role schedule ${planId} / safe_role_schedule), wait the delay, then exec.`,
        )
        break
      case 'ScheduleExpired':
        add(
          `Timelock: the schedule expired (its window passed). Schedule it again (safe-role schedule ${planId} / ` +
            'safe_role_schedule): the new schedule replaces the expired one. Wait the delay, then exec within the window.',
        )
        break
      case 'ClearedByFreeze':
        add(
          `Timelock: a freeze cleared the schedule. Once not frozen, schedule again (safe-role schedule ${planId}).`,
        )
        break
      case 'NotReady': {
        const readyAt = args[1] as bigint
        add(
          `Timelock: scheduled; executable from ${isoTime(readyAt)}. Wait (safe-role queue shows the countdown), then simulate and exec ${planId}.`,
        )
        break
      }
      case 'MissingCoSignature':
      case 'CoSignatureExpired': {
        const cosigner = args[0] as Address
        const [nonce, at] = await Promise.all([
          readCoSignerModuleTxNonce(client(), deployment, config.safe, callHash),
          now(),
        ])
        const deadline = at + MODULE_PROOF_LIFETIME
        const digest = coSignerModuleTxDigest(
          config.chainId,
          deployment.policies.coSigner,
          ctx.engine,
          config.safe,
          callHash,
          nonce,
          deadline,
        )
        add(
          `Co-signer: ${g.error?.name === 'CoSignatureExpired' ? 'the pushed co-signature expired; ' : ''}` +
            `ask ${ctx.labels.nameOf?.(cosigner) ?? cosigner} (${cosigner}) to sign the EIP-712 digest ${digest} ` +
            `(CoSignerPolicyV2 ModuleTransaction{engine, safe, callHash ${callHash}, nonce ${nonce}, deadline ${deadline} = ${isoTime(deadline)}}); ` +
            `anyone relays cosign(engine, safe, callHash, cosigner, ${deadline}, signature) to the CoSignerPolicyV2 ` +
            'before the deadline. Then simulate again.',
        )
        break
      }
      case 'MissingAttestation':
      case 'AttestationExpired': {
        const deadline = (await now()) + MODULE_PROOF_LIFETIME
        const digest = safenetModuleTxDigest(
          config.chainId,
          deployment.policies.safenet,
          ctx.engine,
          config.safe,
          callHash,
          deadline,
        )
        add(
          `Safenet: ${g.error?.name === 'AttestationExpired' ? 'the credited attestation expired; ' : ''}` +
            `needs an attestation of digest ${digest} (deadline ${deadline} = ${isoTime(deadline)}), submitted with ` +
            `submitAttestation(engine, safe, callHash, ${deadline}, attestation) to the SafenetPolicyV2. Then simulate again.`,
        )
        break
      }
      case 'Unpriced':
        add(
          'Transfer budget: it cannot price this call, or has no budget for this token. Stop; the owners decide.',
        )
        break
      case 'LimitExceeded': {
        const [id, token] = args as readonly [Hex, Address]
        try {
          const r = await readLimitRemaining(client(), deployment, config.safe, id, token)
          add(
            r.period === 0n
              ? 'Transfer budget: one-time budget, it does not reset. Stop; only the owners can raise it.'
              : `Transfer budget: resets at ${isoTime(r.windowStart + r.period)}. Wait for the reset or ask the owners. Never split the payment to fit.`,
          )
        } catch {
          add('Transfer budget: over budget. Wait for the reset (safe-role policies) or ask the owners.')
        }
        break
      }
      case 'Frozen':
        add(
          `Freeze: frozen until ${isoTime(args[2] as bigint)}. Nothing to retry: wait, or a guardian/lifter lifts it.`,
        )
        break
      case 'NotGranted':
        add(
          'Not granted: no Allow covers this call for the role. Stop; the owners would have to add one (Safe App, V2 builder).',
        )
        break
      case 'AllowNotExact':
        add('A module needs an Allow on exactly this function to call the Safe or the engine. Stop.')
        break
      default:
        add(`${g.reasonText || 'Denied'}: explain it to the user and stop. Do not work around it.`)
    }
  }
  return steps
}

/** `execTransactionFromModule` as an eth_call from the role: the ground truth, inner call included. */
async function dryRun(
  config: Config,
  tx: ModuleTx,
  labels: LabelContext,
): Promise<V2Simulation['execution']> {
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
    return { ok: false, reason: describeV2Failure(error, labels) }
  }
}

/** Preview (every gate) plus a real dry run of `execTransactionFromModule` as the role. */
export async function v2Simulate(
  config: Config,
  ctx: V2Context,
  tx: ModuleTx,
  planId: string,
): Promise<V2Simulation> {
  const callHash = moduleCallHash(config.safe, config.role, tx.to, tx.value, tx.data, tx.operation)
  const [preview, model, execution] = await Promise.all([
    runPreview(client(), ctx.deployment, config.safe, config.role, tx, ctx.labels),
    loadSafeModel(client(), ctx.deployment, config.safe),
    dryRun(config, tx, ctx.labels),
  ])
  if (!preview.ok) {
    return {
      engine: ctx.engine,
      callHash,
      allowed: false,
      gates: [],
      needs: [],
      next: [`The preview failed (${preview.reason}); the dry run says: ${execution.reason ?? 'OK'}.`],
      execution,
    }
  }
  const byId = new Map(model.attachments.map((a) => [a.attachmentId.toLowerCase(), a]))
  const rows = collapseGates(preview.gates).map((g) => gateRow(g, byId, ctx))
  const { outcome } = preview
  const deciding = outcome.deciding && gateRow(outcome.deciding, byId, ctx)
  const next = await nextSteps(config, ctx, planId, callHash, outcome)
  if (outcome.allowed && !execution.ok)
    next.unshift(`The policies allow it, but the call itself fails: ${execution.reason}.`)
  return {
    engine: ctx.engine,
    callHash,
    allowed: outcome.allowed && execution.ok,
    ...(deciding ? { deciding } : {}),
    gates: rows,
    needs: outcome.needs,
    next,
    execution,
  }
}

// ---------------------------------------------------------------------------------------------
// Policies: the role's view
// ---------------------------------------------------------------------------------------------

export type Budget = {
  scope: string
  token: string
  amount: string
  spent: string
  available: string
  period: string
  /** Next reset, or null for a one-time budget. */
  resetsAt: string | null
  resetsIn: string | null
}

export async function v2Policies(config: Config, ctx: V2Context) {
  const model = await loadSafeModel(client(), ctx.deployment, config.safe)
  const at = await now()
  const { labels } = ctx
  const scopeOf = (a: Attachment) => scopeLabel(a.scope, labels.nameOf, selectorName)
  const describe = (a: Attachment) =>
    a.kind === AttachmentKind.DENY
      ? 'Deny: always denied'
      : a.settings
        ? settingsLabel(a.settings, labels)
        : a.policyName
          ? POLICY_INFO[a.policyName].label
          : `unknown policy ${a.policy}`
  const mine = model.attachments.filter((a) => isAddressEqual(a.scope.actor, config.role))
  const everyone = model.everyone
  const selfTarget = (a: Attachment) =>
    isAddressEqual(a.scope.to, config.safe) || isAddressEqual(a.scope.to, ctx.engine)

  const grants = [...everyone, ...mine]
    .filter((a) => a.kind === AttachmentKind.ALLOW)
    .map((a) => ({
      scope: scopeOf(a),
      operations: a.opMask === 2 ? 'DELEGATECALL' : a.opMask === 3 ? 'CALL + DELEGATECALL' : 'CALL',
      ...(selfTarget(a) && a.level !== EXACT_LEVEL
        ? { note: 'does not count for a module calling the Safe or the engine (needs an exact-scope Allow)' }
        : {}),
    }))
  const protection = (a: Attachment) => ({
    scope: scopeOf(a),
    policy:
      a.kind === AttachmentKind.DENY ? 'Deny' : a.policyName ? POLICY_INFO[a.policyName].label : a.policy,
    rule: describe(a),
  })

  const limits = [...everyone, ...mine].filter(
    (a) => a.policyName === 'limit' && a.settings?.policy === 'limit',
  )
  const budgets: Budget[] = (
    await Promise.all(
      limits.flatMap((a) =>
        a.settings?.policy === 'limit'
          ? a.settings.settings.limits.map(async (l): Promise<Budget> => {
              const r = await readLimitRemaining(
                client(),
                ctx.deployment,
                config.safe,
                a.attachmentId,
                l.token,
              )
              const amount = (v: bigint) => amountLabel(l.token, v, labels)
              const reset = r.period === 0n ? null : r.windowStart + r.period
              return {
                scope: scopeOf(a),
                token: BigInt(l.token) === 0n ? 'ETH' : (labels.tokenOf?.(l.token)?.symbol ?? l.token),
                amount: amount(r.amount),
                spent: amount(r.spent),
                available: amount(r.available),
                period: r.period === 0n ? 'one-time' : durationLabel(r.period),
                resetsAt: reset === null ? null : isoTime(reset),
                resetsIn: reset === null ? null : countdown(reset - at),
              }
            })
          : [],
      ),
    )
  ).flat()

  return {
    grants,
    protectionsOnMe: mine.filter((a) => a.kind !== AttachmentKind.ALLOW).map(protection),
    protectionsOnEveryone: everyone.filter((a) => a.kind !== AttachmentKind.ALLOW).map(protection),
    budgets,
  }
}

// ---------------------------------------------------------------------------------------------
// Timelock: what applies, scheduling checks, queue
// ---------------------------------------------------------------------------------------------

/** Current merged Timelock settings for the role's call (SPEC §8.2), or undefined if none applies. */
export async function timelockFor(
  config: Config,
  ctx: V2Context,
  tx: ModuleTx,
): Promise<
  | { delay: bigint; window: bigint; clearOnFreeze: boolean; cancellers: Address[]; configuredAt: bigint }
  | undefined
> {
  const timelock = ctx.deployment.policies.timelock
  if (isAddressEqual(timelock, zeroAddress)) return undefined
  const matches = await readMatchingAttachments(client(), ctx.engine, config.safe, config.role, tx, timelock)
  const ids = [
    ...new Set(
      matches
        .filter((m) => m.attachment.kind === AttachmentKind.POLICY)
        .map((m) => m.attachment.attachmentId),
    ),
  ]
  if (!ids.length) return undefined
  const [settings, configuredAt] = await Promise.all([
    Promise.all(
      ids.map(async (id) => {
        const s = await readPolicySettings(client(), ctx.deployment, config.safe, 'timelock', id)
        return s.settings as TimelockSettings
      }),
    ),
    // The delay runs from the latest (re)configuration when it is later than the schedule (D-20).
    readTimelockConfiguredAt(client(), ctx.deployment, config.safe, ids),
  ])
  const windows = settings.map((s) => s.window).filter((w) => w > 0)
  return {
    delay: BigInt(Math.max(...settings.map((s) => s.delay))),
    window: BigInt(windows.length ? Math.min(...windows) : 0),
    clearOnFreeze: settings.some((s) => s.clearOnFreeze),
    cancellers: [...new Set(settings.flatMap((s) => s.cancellers.map((c) => getAddress(c))))],
    configuredAt,
  }
}

export type QueueEntry = {
  callHash: Hex
  /** Plan id to exec (CALL only), recreated from the scheduled call. */
  planId?: string
  intent?: string
  to: Address
  value: bigint
  data: Hex
  operation: number
  scheduledAt: string
  status: ScheduleStatus | 'untimelocked'
  readyAt?: string
  /** `in 3m 05s` while waiting. */
  countdown?: string
  expiresAt?: string
  next: string
}

export async function scheduleState(
  config: Config,
  ctx: V2Context,
  tx: ModuleTx,
  schedule: Schedule,
  at: bigint,
): Promise<Pick<QueueEntry, 'status' | 'readyAt' | 'countdown' | 'expiresAt'>> {
  const timelock = await timelockFor(config, ctx, tx)
  if (!timelock) return { status: 'untimelocked' }
  const { epoch } = await readFreezeStatus(client(), ctx.engine, config.safe, config.role)
  const s = scheduleStatus(schedule, { now: at, ...timelock, freezeEpoch: epoch })
  return {
    status: s.status,
    readyAt: isoTime(s.readyAt),
    ...(s.status === 'waiting' ? { countdown: countdown(s.readyAt - at) } : {}),
    ...(s.expiresAt !== undefined ? { expiresAt: isoTime(s.expiresAt) } : {}),
  }
}

const scheduledEvent = timelockPolicyAbi.find((e) => e.type === 'event' && e.name === 'Scheduled')!
type ScheduledEvent = Extract<(typeof timelockPolicyAbi)[number], { type: 'event'; name: 'Scheduled' }>

/** LOGS_BLOCK_RANGE of the app (most public RPCs cap eth_getLogs at 50k blocks). */
const LOG_CHUNK = 49_999n

/** The role's schedules still stored in the Timelock (Scheduled events, then `getSchedule`). */
export async function readQueue(
  config: Config,
  ctx: V2Context,
  fromBlock?: bigint,
): Promise<{ from: bigint; to: bigint; live: { call: ModuleTx; schedule: Schedule }[] }> {
  const timelock = ctx.deployment.policies.timelock
  const head = await client().getBlockNumber()
  const from = fromBlock ?? (head > BigInt(config.lookbackBlocks) ? head - BigInt(config.lookbackBlocks) : 0n)
  const calls = new Map<string, ModuleTx>()
  for (let start = from; start <= head; start += LOG_CHUNK + 1n) {
    const end = start + LOG_CHUNK > head ? head : start + LOG_CHUNK
    const logs = await client().getLogs({
      address: timelock,
      event: scheduledEvent as ScheduledEvent,
      args: { engine: ctx.engine, safe: config.safe },
      fromBlock: start,
      toBlock: end,
    })
    for (const log of logs) {
      const a = log.args
      if (!a.actor || !a.txHash || !isAddressEqual(a.actor, config.role)) continue
      calls.set(a.txHash, {
        to: getAddress(a.to!),
        value: a.value!,
        data: a.data!,
        operation: Number(a.operation) as ModuleTx['operation'],
      })
    }
  }
  const live = (
    await Promise.all(
      [...calls].map(async ([hash, call]) => {
        const schedule = await readSchedule(client(), ctx.deployment, config.safe, hash as Hex)
        return schedule && isAddressEqual(schedule.actor, config.role) ? { call, schedule } : undefined
      }),
    )
  ).filter((x) => x !== undefined)
  return { from, to: head, live }
}

export const blockTime = now

export type ScheduleCheck =
  | {
      ok: true
      callHash: Hex
      delay: bigint
      /** Estimated: the policy recomputes it from the current settings at execution. */
      readyAt: bigint
      cancellers: Address[]
    }
  | { ok: false; reason: string; hint: string }

/**
 * Whether scheduling the role's call makes sense now: a Timelock applies, the preview's only
 * denies are needs (schedule first, co-signature, ...), and no live schedule exists. Run by the CLI
 * before asking the signer, and again by the signer before it signs.
 */
export async function scheduleCheck(
  config: Config,
  ctx: V2Context,
  tx: ModuleTx,
  planId: string,
): Promise<ScheduleCheck> {
  const fail = (reason: string, hint: string): ScheduleCheck => ({ ok: false, reason, hint })
  const [timelock, sim, at] = await Promise.all([
    timelockFor(config, ctx, tx),
    v2Simulate(config, ctx, tx, planId),
    now(),
  ])
  if (!timelock)
    return fail('No Timelock applies to this call: there is nothing to schedule.', `Simulate ${planId}.`)
  if (sim.allowed) return fail('No schedule needed: the call is allowed now.', `Exec ${planId}.`)
  const existing = await readSchedule(client(), ctx.deployment, config.safe, sim.callHash)
  if (existing && isAddressEqual(existing.actor, config.role)) {
    const state = await scheduleState(config, ctx, tx, existing, at)
    // A cleared or expired schedule is replaced by a new one (TimelockPolicy, review F1 / M-4).
    if (state.status !== 'cleared' && state.status !== 'expired')
      return fail(
        `Already scheduled (${state.status}${state.readyAt ? `, ready at ${state.readyAt}` : ''}).`,
        'Run safe-role queue.',
      )
  }
  const blocking = sim.gates.filter((g) => g.verdict === 'deny' && !g.needs)
  if (blocking.length || !sim.needs.includes('schedule'))
    return fail(
      `Scheduling would not help: ${blocking.map((g) => `${g.gate} → ${g.reason ?? 'deny'}`).join('; ') || 'the Timelock does not ask for a schedule'}.`,
      'Explain the denial to the user; do not work around it.',
    )
  if (timelock.clearOnFreeze) {
    const { safeFrozen, actorFrozen } = await readFreezeStatus(client(), ctx.engine, config.safe, config.role)
    if (safeFrozen || actorFrozen)
      return fail(
        'Frozen: a schedule made now would be cleared by the freeze.',
        'Wait until the freeze ends (safe-role status), then schedule.',
      )
  }
  return {
    ok: true,
    callHash: sim.callHash,
    delay: timelock.delay,
    readyAt: at + timelock.delay,
    cancellers: timelock.cancellers,
  }
}
