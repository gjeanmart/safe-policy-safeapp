import { existsSync, readFileSync } from 'node:fs'
import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  zeroHash,
} from 'viem'
import { publicClient } from '../../../src/config/client'
import * as appContracts from '../../../src/config/contracts'
import type { ModuleTx } from '../../../src/lib/moduleTx'
import { CliError } from '../output'
import {
  POLICY_GUARD_INTERFACE_ID,
  TIMELOCK_POLICY_INTERFACE_ID,
  argsPolicyAbi,
  coSignerPolicyAbi,
  limitPolicyAbi,
  policyAbi,
  policyGuardAbi,
  safenetPolicyAbi,
  timelockPolicyAbi,
  v2ErrorsAbi,
} from './abi'

/**
 * A small, self-contained client for Policy Engine V2 rev 3 (contracts/contracts/v2/SPEC.md): engine
 * detection, deployment addresses, attachments, the `matches` preview, a policy `check` run as an
 * `eth_call` from the engine, and the policy views the role needs. It duplicates part of the app's
 * src/lib/v2 on purpose, so the CLI does not depend on that library while it is being rewritten.
 */

// The app's client is a `let` rebuilt when the RPC URL changes: read it at each call.
export const client = (): PublicClient => publicClient as unknown as PublicClient

/** Actor wildcard (everyone, owners included) and the owner path (Safe's module-list sentinel). */
export const ANY: Address = zeroAddress
export const OWNERS: Address = '0x0000000000000000000000000000000000000001'
export const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export const CallMatch = { ANY: 0, CONTRACT: 1, FUNCTION: 2 } as const
export const EXACT_LEVEL = 5
export const OP_CALL = 1
export const OP_DELEGATECALL = 2

export type Scope = { actor: Address; to: Address; selector: Hex; callMatch: number }
export type Attachment = {
  attachmentId: Hex
  scopeKey: Hex
  scope: Scope
  kind: number
  policy: Address
  opMask: number
  level: number
}
export type Call = { to: Address; value: bigint; data: Hex; operation: number }
export type Found = {
  callIndex: number
  level: number
  attachmentId: Hex
  kind: number
  policy: Address
  opMask: number
  counts: boolean
}
export type PolicyKind = 'timelock' | 'limit' | 'args' | 'coSigner' | 'safenet' | 'unknown'

export const levelOf = (scope: Scope): number => (isAddressEqual(scope.actor, ANY) ? 0 : 3) + scope.callMatch

// ---------------------------------------------------------------------------------------------
// Deployment addresses
// ---------------------------------------------------------------------------------------------

export type Rev3Deployment = {
  engine: Address
  engineConfig?: Address
  trustedBatches?: Address[]
  policies: {
    timelock: Address
    timelockQueue?: Address
    timelockFreeze?: Address
    args?: Address
    limit?: Address
    coSigner?: Address
    safenet?: Address
  }
  /** First block worth scanning for this engine's events (the Timelock queue). */
  fromBlock?: bigint
}

type Loose = Record<string, unknown>

/** A rev 3 entry: `engine` plus `policies.timelock`, and not a rev 2 one (which had a Freeze policy). */
function asDeployment(value: unknown, parentFromBlock?: unknown): Rev3Deployment | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Loose
  const policies = v.policies as Loose | undefined
  if (typeof v.engine !== 'string' || !isAddress(v.engine) || typeof policies !== 'object' || !policies)
    return undefined
  if (typeof policies.timelock !== 'string' || 'freeze' in policies || 'recipients' in policies)
    return undefined
  if (!('engineConfig' in v) && !('timelockQueue' in policies) && !('args' in policies)) return undefined
  const address = (a: unknown) => (typeof a === 'string' && isAddress(a) ? getAddress(a) : undefined)
  const fromBlock = v.fromBlock ?? parentFromBlock
  return {
    engine: getAddress(v.engine),
    engineConfig: address(v.engineConfig),
    trustedBatches: Array.isArray(v.trustedBatches)
      ? v.trustedBatches.map(address).filter((a): a is Address => !!a)
      : undefined,
    policies: {
      timelock: getAddress(policies.timelock),
      timelockQueue: address(policies.timelockQueue),
      timelockFreeze: address(policies.timelockFreeze),
      args: address(policies.args),
      limit: address(policies.limit),
      coSigner: address(policies.coSigner),
      safenet: address(policies.safenet),
    },
    fromBlock:
      typeof fromBlock === 'bigint' || typeof fromBlock === 'number' || typeof fromBlock === 'string'
        ? BigInt(fromBlock)
        : undefined,
  }
}

/** Rev 3 deployments anywhere in a value: an entry, an array, or a record of them (or of wrappers). */
function collect(
  value: unknown,
  depth = 0,
  out: Rev3Deployment[] = [],
  fromBlock?: unknown,
): Rev3Deployment[] {
  const found = asDeployment(value, fromBlock)
  if (found) out.push(found)
  else if (depth < 3 && Array.isArray(value)) value.forEach((v) => collect(v, depth + 1, out, fromBlock))
  else if (depth < 3 && typeof value === 'object' && value !== null)
    Object.values(value).forEach((v) => collect(v, depth + 1, out, (value as Loose).fromBlock ?? fromBlock))
  return out
}

/** `SAFE_ROLE_V2_DEPLOYMENT` (or `--v2-deployment`): the deployment JSON, inline or a file path. */
function envDeployments(): Rev3Deployment[] {
  const raw = process.env.SAFE_ROLE_V2_DEPLOYMENT?.trim()
  if (!raw) return []
  const text =
    raw.startsWith('{') || raw.startsWith('[') ? raw : existsSync(raw) ? readFileSync(raw, 'utf8') : ''
  if (!text) throw new CliError(`SAFE_ROLE_V2_DEPLOYMENT: no such file ${raw}.`)
  let found: Rev3Deployment[]
  try {
    found = collect(JSON.parse(text))
  } catch (error) {
    throw new CliError(
      `SAFE_ROLE_V2_DEPLOYMENT is not JSON: ${error instanceof Error ? error.message : error}`,
    )
  }
  if (!found.length)
    throw new CliError(
      'SAFE_ROLE_V2_DEPLOYMENT has no rev 3 deployment.',
      'Pass { "engine", "engineConfig", "policies": { "timelock", "timelockQueue", "timelockFreeze", "args", "limit", "coSigner", "safenet" } }.',
    )
  return found
}

/** Known rev 3 deployments: the override first, then src/config/contracts.ts. Zero engines are skipped. */
export function knownDeployments(): Rev3Deployment[] {
  return [...envDeployments(), ...collect(appContracts)].filter((d) => !isAddressEqual(d.engine, zeroAddress))
}

export const NOT_DEPLOYED_HINT =
  'Rev 3 addresses come from src/config/contracts.ts, or SAFE_ROLE_V2_DEPLOYMENT=<file or JSON> ' +
  '(--v2-deployment <file>) for the CLI and the signer.'

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/** True iff `address` reports `IPolicyGuard` through ERC-165 (SPEC §3, IPolicyGuard NatSpec). */
export async function isRev3Engine(address: Address): Promise<boolean> {
  if (isAddressEqual(address, zeroAddress)) return false
  try {
    return await client().readContract({
      address,
      abi: policyGuardAbi,
      functionName: 'supportsInterface',
      args: [POLICY_GUARD_INTERFACE_ID],
    })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Engine reads
// ---------------------------------------------------------------------------------------------

export async function readAttachments(engine: Address, safe: Address): Promise<Attachment[]> {
  const views = await client().readContract({
    address: engine,
    abi: policyGuardAbi,
    functionName: 'getAttachments',
    args: [safe],
  })
  return views.map((v) => {
    const scope = { ...v.scope, to: getAddress(v.scope.to), actor: getAddress(v.scope.actor) }
    return {
      attachmentId: v.attachmentId,
      scopeKey: v.scopeKey,
      scope,
      kind: v.kind,
      policy: getAddress(v.policy),
      opMask: v.opMask,
      level: levelOf(scope),
    }
  })
}

export async function readMatches(
  engine: Address,
  safe: Address,
  actor: Address,
  tx: ModuleTx,
): Promise<{ calls: Call[]; found: Found[]; engineError: Hex }> {
  const [calls, found, engineError] = await client().readContract({
    address: engine,
    abi: policyGuardAbi,
    functionName: 'matches',
    args: [safe, actor, tx.to, tx.value, tx.data, tx.operation],
  })
  return {
    calls: calls.map((c) => ({ ...c, to: getAddress(c.to) })),
    found: found.map((f) => ({ ...f, policy: getAddress(f.policy) })),
    engineError,
  }
}

/** `ScopeLib.moduleCallHash`: the module path's `ctx.txHash` (no nonce). */
export const moduleCallHash = (safe: Address, actor: Address, tx: ModuleTx): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'uint8' },
      ],
      [safe, actor, tx.to, tx.value, tx.data, tx.operation],
    ),
  )

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type DecodedError = { name: string; args: readonly unknown[] }

/** Revert data of a failed call, wherever the RPC client put it. */
export function revertDataOf(error: unknown): Hex | undefined {
  let e: unknown = error
  for (let i = 0; i < 10 && e; i++) {
    const data = (e as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x')) return data as Hex
    const nested = (data as { data?: unknown } | undefined)?.data
    if (typeof nested === 'string' && nested.startsWith('0x')) return nested as Hex
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * TODO(rev 3 fix T2): errors the contracts add in this round, until `abi.ts` is regenerated.
 * Decoding takes the first match, so a duplicate after regeneration is harmless; delete it then.
 */
const PENDING_ERRORS = [
  {
    type: 'error',
    name: 'CancelledTransaction',
    inputs: [{ name: 'txHash', type: 'bytes32', internalType: 'bytes32' }],
  },
] as const satisfies Abi

/** Decodes a rev 3 engine or policy error; `PolicyDenied` is unwrapped into its policy's reason. */
export function decodeV2Error(data: Hex | undefined): DecodedError | undefined {
  if (!data || data === '0x') return undefined
  try {
    const { errorName, args } = decodeErrorResult({ abi: [...v2ErrorsAbi, ...PENDING_ERRORS], data })
    return { name: errorName, args: args ?? [] }
  } catch {
    try {
      const { errorName, args } = decodeErrorResult({
        abi: [
          { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
          { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
        ],
        data,
      })
      return { name: errorName, args: args ?? [] }
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Policy check as an eth_call from the engine (SPEC §3.5)
// ---------------------------------------------------------------------------------------------

export type CheckResult = { ok: true } | { ok: false; data?: Hex; message: string }

/**
 * Runs `policy.check(ctx, calls, matches)` as an `eth_call` from the engine: same code and state,
 * nothing persists. Some RPCs refuse `eth_call` from an account with code; the retry overrides the
 * engine's code to empty for that call (the rev 3 policies never call the engine back in `check`).
 */
export async function simulateCheck(
  engine: Address,
  policy: Address,
  ctx: { safe: Address; actor: Address; txHash: Hex },
  calls: Call[],
  matches: { callIndex: number; level: number; attachmentId: Hex }[],
): Promise<CheckResult> {
  const data = encodeFunctionData({ abi: policyAbi, functionName: 'check', args: [ctx, calls, matches] })
  const run = (override: boolean) =>
    client().call({
      account: engine,
      to: policy,
      data,
      ...(override ? { stateOverride: [{ address: engine, code: '0x' }] } : {}),
    })
  let result: { data?: Hex }
  try {
    try {
      result = await run(false)
    } catch (error) {
      if (revertDataOf(error)) throw error
      result = await run(true)
    }
  } catch (error) {
    const revert = revertDataOf(error)
    return { ok: false, data: revert, message: error instanceof Error ? error.message.split('\n')[0]! : '' }
  }
  // The engine accepts exactly `IPolicy.check.selector` in one ABI word.
  const selector = data.slice(0, 10)
  return result.data?.toLowerCase() === `${selector}${'0'.repeat(56)}`
    ? { ok: true }
    : { ok: false, message: `returned ${result.data ?? '0x'} instead of the check selector` }
}

// ---------------------------------------------------------------------------------------------
// Policy kinds
// ---------------------------------------------------------------------------------------------

const succeeds = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  )

/**
 * Which rev 3 policy each address is: the deployment's addresses first, then probes (only the
 * Timelock reports its interface through ERC-165; the others answer one view each).
 */
export async function policyKinds(
  engine: Address,
  safe: Address,
  policies: Address[],
  deployment?: Rev3Deployment,
): Promise<Map<string, PolicyKind>> {
  const kinds = new Map<string, PolicyKind>()
  const named = deployment?.policies ?? {}
  await Promise.all(
    [...new Set(policies.map((p) => p.toLowerCase()))].map(async (key) => {
      const address = getAddress(key)
      const known = (
        Object.entries(named) as [PolicyKind | 'timelockQueue' | 'timelockFreeze', Address | undefined][]
      ).find(([, a]) => a && isAddressEqual(a, address))
      if (known && known[0] !== 'timelockQueue' && known[0] !== 'timelockFreeze')
        return kinds.set(key, known[0])
      const read = (abi: readonly unknown[], functionName: string, args: unknown[]) =>
        succeeds(
          client().readContract({ address, abi: abi as typeof policyAbi, functionName, args } as never),
        )
      const kind: PolicyKind = (await client()
        .readContract({
          address,
          abi: timelockPolicyAbi,
          functionName: 'supportsInterface',
          args: [TIMELOCK_POLICY_INTERFACE_ID],
        })
        .catch(() => false))
        ? 'timelock'
        : (await read(coSignerPolicyAbi, 'useCount', [engine, safe, zeroHash]))
          ? 'coSigner'
          : (await read(safenetPolicyAbi, 'isAttested', [engine, safe, zeroHash]))
            ? 'safenet'
            : (await read(limitPolicyAbi, 'remaining', [engine, safe, zeroHash, zeroAddress]))
              ? 'limit'
              : (await read(argsPolicyAbi, 'getSettings', [engine, safe, zeroHash]))
                ? 'args'
                : 'unknown'
      kinds.set(key, kind)
    }),
  )
  return kinds
}

// ---------------------------------------------------------------------------------------------
// Policy views
// ---------------------------------------------------------------------------------------------

export type TimelockState = {
  delay: number
  window: number
  guardians: Address[]
  lifters: Address[]
  cancellers: Address[]
  configuredAt: bigint
  frozenUntil: bigint
  cooldownUntil: bigint
}

export async function readTimelock(
  timelock: Address,
  engine: Address,
  safe: Address,
  id: Hex,
): Promise<TimelockState> {
  const args = [engine, safe, id] as const
  const [settings, configuredAt, [frozenUntil, cooldownUntil]] = await Promise.all([
    client().readContract({ address: timelock, abi: timelockPolicyAbi, functionName: 'getSettings', args }),
    client().readContract({ address: timelock, abi: timelockPolicyAbi, functionName: 'configuredAt', args }),
    client().readContract({ address: timelock, abi: timelockPolicyAbi, functionName: 'freezeState', args }),
  ])
  return {
    delay: settings.delay,
    window: settings.window,
    guardians: settings.guardians.map((a) => getAddress(a)),
    lifters: settings.lifters.map((a) => getAddress(a)),
    cancellers: settings.cancellers.map((a) => getAddress(a)),
    configuredAt,
    frozenUntil: BigInt(frozenUntil),
    cooldownUntil: BigInt(cooldownUntil),
  }
}

export type Schedule = {
  actor: Address
  scheduledAt: bigint
  isConfiguration: boolean
  attachmentIds: Hex[]
}

/** The schedule of `txHash`, or undefined when none is stored. */
export async function readSchedule(
  timelock: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
): Promise<Schedule | undefined> {
  const s = await client().readContract({
    address: timelock,
    abi: timelockPolicyAbi,
    functionName: 'getSchedule',
    args: [engine, safe, txHash],
  })
  if (s.scheduledAt === 0n) return undefined
  return {
    actor: getAddress(s.actor),
    scheduledAt: s.scheduledAt,
    isConfiguration: s.isConfiguration,
    attachmentIds: [...s.attachmentIds],
  }
}

export type LimitSettings = {
  limits: { token: Address; amount: bigint; period: bigint }[]
  passUnpriced: boolean
}

export async function readLimitSettings(limit: Address, engine: Address, safe: Address, id: Hex) {
  const s = await client().readContract({
    address: limit,
    abi: limitPolicyAbi,
    functionName: 'getSettings',
    args: [engine, safe, id],
  })
  return {
    limits: s.limits.map((l) => ({ token: getAddress(l.token), amount: l.amount, period: l.period })),
    passUnpriced: s.passUnpriced,
  } satisfies LimitSettings
}

export async function readRemaining(limit: Address, engine: Address, safe: Address, id: Hex, token: Address) {
  return client().readContract({
    address: limit,
    abi: limitPolicyAbi,
    functionName: 'remaining',
    args: [engine, safe, id, token],
  })
}

export type ArgsConstraint = {
  selector: Hex
  target: number
  index: number
  op: number
  values: readonly Hex[]
}

export async function readArgsSettings(args: Address, engine: Address, safe: Address, id: Hex) {
  const s = await client().readContract({
    address: args,
    abi: argsPolicyAbi,
    functionName: 'getSettings',
    args: [engine, safe, id],
  })
  return { constraints: s.constraints as readonly ArgsConstraint[], strict: s.strict }
}

export async function readCoSigner(coSigner: Address, engine: Address, safe: Address, id: Hex) {
  const s = await client().readContract({
    address: coSigner,
    abi: coSignerPolicyAbi,
    functionName: 'getSettings',
    args: [engine, safe, id],
  })
  return { approvers: s.approvers.map((a) => getAddress(a)), required: s.required }
}

export async function readApprovedUntil(
  coSigner: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
  approver: Address,
): Promise<bigint> {
  return BigInt(
    await client().readContract({
      address: coSigner,
      abi: coSignerPolicyAbi,
      functionName: 'approvedUntil',
      args: [engine, safe, txHash, approver],
    }),
  )
}

export async function readApprovalDigest(
  coSigner: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
  validUntil: bigint,
): Promise<Hex> {
  return client().readContract({
    address: coSigner,
    abi: coSignerPolicyAbi,
    functionName: 'approvalDigest',
    args: [engine, safe, txHash, validUntil],
  })
}

export async function readAttestationDigest(
  safenet: Address,
  engine: Address,
  safe: Address,
  txHash: Hex,
  deadline: bigint,
): Promise<Hex> {
  return client().readContract({
    address: safenet,
    abi: safenetPolicyAbi,
    functionName: 'attestationDigest',
    args: [engine, safe, txHash, deadline],
  })
}

export const blockTime = async (): Promise<bigint> => (await client().getBlock()).timestamp
