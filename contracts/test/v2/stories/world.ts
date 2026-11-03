import { impersonateAccount, setBalance, time } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import {
  AbiCoder,
  type BaseContract,
  type BytesLike,
  type ContractTransactionResponse,
  type Interface,
  type Signer,
  ZeroAddress,
  getAddress,
  id,
  keccak256,
} from 'ethers'
import { ethers } from 'hardhat'
import type {
  ArgsPolicy,
  CoSignerPolicy,
  E2eToken,
  IPolicyGuard,
  LimitPolicy,
  PolicyGuard,
  Safe,
  TimelockPolicy,
} from '../../../typechain-types'
import {
  type MetaTx,
  type SafeInfra,
  type SafeTx,
  completeTx,
  deploySafe,
  deploySafeInfra,
  execAsModule,
  execAsOwners,
  multiSendTx,
  safeTxHash,
  signSafeTx,
} from '../fixtures/safe'
import { revertData } from '../helpers'
import {
  FQN,
  deployEngine as deployEngineScript,
  deployPolicies,
  deployQuietly,
  engineAt,
} from '../../../scripts/lib/v2-deployment'

/**
 * Rev 3 story world: a real Safe 1.5.0 (2-of-3) guarded by the real engine (`PolicyGuardConfig`
 * + `PolicyGuard`, installed as guard and module guard) and the real policies, with a USDC-style
 * token. Every story in this folder builds on it. It deploys through `scripts/lib/v2-deployment.ts`,
 * so the tests run exactly what `scripts/deploy-v2.ts` deploys (F = 7 d and C = 12 h are its defaults).
 */

export const coder = AbiCoder.defaultAbiCoder()

export const HOUR = 3600n
export const DAY = 24n * HOUR
export const WEEK = 7n * DAY
export const MONTH = 30n * DAY
/** Owners' timelock T < recovery's timelock R < maximum freeze F; cooldown C (SPEC §5.1). */
export const T = DAY
export const R = 3n * DAY
export const F = 7n * DAY
export const C = 12n * HOUR

export const ANY = ZeroAddress
export const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
export const CallMatch = { ANY: 0, CONTRACT: 1, FUNCTION: 2 } as const
export const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export const Op = { CALL: 0, DELEGATECALL: 1 } as const
export const Mask = { DEFAULT: 0, CALL: 1, DELEGATECALL: 2, ALL: 3 } as const

export const usdc = (n: number | bigint) => BigInt(n) * 10n ** 6n
export const MAX_UINT = 2n ** 256n - 1n
export const SENTINEL = OWNERS // Safe's owner-list sentinel is also address 1

export const sel = (signature: string) => id(signature).slice(0, 10)
export const SEL = {
  transfer: sel('transfer(address,uint256)'),
  transferFrom: sel('transferFrom(address,address,uint256)'),
  approve: sel('approve(address,uint256)'),
  increaseAllowance: sel('increaseAllowance(address,uint256)'),
  decreaseAllowance: sel('decreaseAllowance(address,uint256)'),
  swapOwner: sel('swapOwner(address,address,address)'),
  addOwnerWithThreshold: sel('addOwnerWithThreshold(address,uint256)'),
  setGuard: sel('setGuard(address)'),
  configure: sel('configure((bool,(address,address,bytes4,uint8),uint8,address,uint8,bytes)[])'),
  empty: '0x00000000',
  any: '0xffffffff', // ArgsPolicy ANY_SELECTOR
}

// ---------------------------------------------------------------------------------------------
// Scopes, changes, ids
// ---------------------------------------------------------------------------------------------

export type Scope = { actor: string; to: string; selector: string; callMatch: number }
export type Change = {
  detach: boolean
  scope: Scope
  kind: number
  policy: string
  opMask: number
  settings: string
}

/** `(actor, *)`. */
export const anyCall = (actor: string): Scope => ({
  actor,
  to: ZeroAddress,
  selector: SEL.empty,
  callMatch: CallMatch.ANY,
})
/** `(actor, to.*)`. */
export const onContract = (actor: string, to: string): Scope => ({
  actor,
  to,
  selector: SEL.empty,
  callMatch: CallMatch.CONTRACT,
})
/** `(actor, to.selector)`; `selector` `0x00000000` names empty calldata. */
export const onFunction = (actor: string, to: string, selector: string): Scope => ({
  actor,
  to,
  selector,
  callMatch: CallMatch.FUNCTION,
})

export const scopeKey = (s: Scope) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]))
export const attachmentId = (s: Scope, kind: number, policy: string = ZeroAddress) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [scopeKey(s), kind, policy]))

export const allow = (s: Scope, opMask: number = Mask.DEFAULT): Change => ({
  detach: false,
  scope: s,
  kind: Kind.ALLOW,
  policy: ZeroAddress,
  opMask,
  settings: '0x',
})
export const deny = (s: Scope, opMask: number = Mask.DEFAULT): Change => ({
  ...allow(s, opMask),
  kind: Kind.DENY,
})
export const attach = (
  s: Scope,
  policy: string | BaseContract,
  settings: string,
  opMask: number = Mask.DEFAULT,
): Change => ({
  detach: false,
  scope: s,
  kind: Kind.POLICY,
  policy: typeof policy === 'string' ? policy : addrOf(policy),
  opMask,
  settings,
})
export const detach = (s: Scope, kind: number, policy: string | BaseContract = ZeroAddress): Change => ({
  detach: true,
  scope: s,
  kind,
  policy: typeof policy === 'string' ? policy : addrOf(policy),
  opMask: 0,
  settings: '0x',
})

/** The address a contract was deployed at (typechain contracts carry it as `target`). */
export const addrOf = (c: BaseContract) => getAddress(c.target as string)

// ---------------------------------------------------------------------------------------------
// Policy settings
// ---------------------------------------------------------------------------------------------

export type TimelockSettings = {
  delay: bigint | number
  window?: bigint | number
  guardians?: string[]
  lifters?: string[]
  cancellers?: string[]
}
export const timelockSettings = (s: TimelockSettings) =>
  coder.encode(
    ['tuple(uint32 delay, uint32 window, address[] guardians, address[] lifters, address[] cancellers)'],
    [[s.delay, s.window ?? 0, s.guardians ?? [], s.lifters ?? [], s.cancellers ?? []]],
  )

export const ArgsTarget = { WORD: 0, CALL_TO: 1, VALUE: 2 } as const
export const ArgsOp = { EQ: 0, NEQ: 1, IN: 2, NOT_IN: 3, LTE: 4, GTE: 5, EQ_SAFE: 6 } as const
export type Constraint = { selector: string; target: number; index: number; op: number; values: string[] }
export const word = (v: string | bigint) =>
  typeof v === 'bigint' ? coder.encode(['uint256'], [v]) : coder.encode(['address'], [v])
/** WORD constraint on head word `index` of `selector`. */
export const onWord = (selector: string, index: number, op: number, values: (string | bigint)[] = []) => ({
  selector,
  target: ArgsTarget.WORD,
  index,
  op,
  values: values.map(word),
})
export const argsSettings = (constraints: Constraint[], strict = true) =>
  coder.encode(
    [
      'tuple(tuple(bytes4 selector, uint8 target, uint16 index, uint8 op, bytes32[] values)[] constraints, bool strict)',
    ],
    [[constraints.map((c) => [c.selector, c.target, c.index, c.op, c.values]), strict]],
  )
/** App preset "Recipients": `transfer` word 0 IN, `transferFrom` word 1 IN, empty calldata CALL_TO IN. */
export const recipientsPreset = (recipients: string[]): Constraint[] => [
  onWord(SEL.transfer, 0, ArgsOp.IN, recipients),
  onWord(SEL.transferFrom, 1, ArgsOp.IN, recipients),
  { selector: SEL.empty, target: ArgsTarget.CALL_TO, index: 0, op: ArgsOp.IN, values: recipients.map(word) },
]
/** App preset "Spenders": `approve` word 0 IN, word 1 LTE cap. */
export const spendersPreset = (spenders: string[], cap: bigint): Constraint[] => [
  onWord(SEL.approve, 0, ArgsOp.IN, spenders),
  onWord(SEL.approve, 1, ArgsOp.LTE, [cap]),
]
/** App preset "Receiver is the Safe": EQ_SAFE on head word `index` of `selector`. */
export const receiverIsSafe = (selector: string, index: number): Constraint =>
  onWord(selector, index, ArgsOp.EQ_SAFE)

export type TokenLimit = { token: string; amount: bigint; period: bigint | number }
export const limitSettings = (limits: TokenLimit[], passUnpriced = false) =>
  coder.encode(
    ['tuple(tuple(address token, uint128 amount, uint64 period)[] limits, bool passUnpriced)'],
    [[limits.map((l) => [l.token, l.amount, l.period]), passUnpriced]],
  )

export const cosignerSettings = (approvers: string[], required: number) =>
  coder.encode(['tuple(address[] approvers, uint8 required)'], [[approvers, required]])

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export type Actor = HardhatEthersSigner

export interface World {
  infra: SafeInfra
  safe: Safe
  safeAddress: string
  engine: IPolicyGuard
  guard: PolicyGuard
  engineAddress: string
  configAddress: string
  batch: string
  /**
   * Safe 1.5.0's `TokenCallbackHandler`: token callbacks, no ERC-1271. `install` sets it as the
   * fallback handler, so the owners' off-chain signatures (permits, Permit2, CoW orders) cannot
   * move funds around the policies (SPEC §6).
   */
  tokenCallbackHandler: string
  timelock: TimelockPolicy
  args: ArgsPolicy
  limit: LimitPolicy
  cosigner: CoSignerPolicy
  token: E2eToken
  tokenAddress: string
  deployer: Actor
  o1: Actor
  o2: Actor
  o3: Actor
  owners: Actor[]
  /** Two of the three owners: the threshold. */
  quorum: Actor[]
  ops: Actor
  agent: Actor
  recovery: Actor
  guardian: Actor
  guardian2: Actor
  cosignerKey: Actor
  attacker: Actor
  vendorA: Actor
  vendorB: Actor
  newOwner1: Actor
  newOwner2: Actor
  stranger: Actor
  members: Actor[]
}

/** The engine, every policy and a 2-of-3 Safe 1.5.0 holding 100,000 USDC and 10 ETH; no guard yet. */
export async function deployWorld(): Promise<World> {
  const s = await ethers.getSigners()
  const [deployer, o1, o2, o3, ops, agent, recovery, guardian, guardian2, cosignerKey, attacker] = s
  const [vendorA, vendorB, newOwner1, newOwner2, stranger, m1, m2, m3] = s.slice(11)
  const infra = await deploySafeInfra()
  const batch = await infra.multiSendCallOnly.getAddress()
  const { engine, guard, configAddress } = await deployEngine([batch])
  const p = await deployPolicies(deployQuietly, { timelock: { maxFreeze: F, cooldown: C } })
  const timelock = (await ethers.getContractAt(FQN.timelock, p.timelock)) as unknown as TimelockPolicy
  const args = (await ethers.getContractAt(FQN.args, p.args)) as unknown as ArgsPolicy
  const limit = (await ethers.getContractAt(FQN.limit, p.limit)) as unknown as LimitPolicy
  const cosigner = (await ethers.getContractAt(FQN.coSigner, p.coSigner)) as unknown as CoSignerPolicy
  const token = (await ethers.deployContract('E2eToken')) as unknown as E2eToken
  const handler = await ethers.deployContract(
    'contracts/vendor/safe-smart-account/handler/TokenCallbackHandler.sol:TokenCallbackHandler',
  )
  const owners = [o1, o2, o3]
  const safe = await deploySafe(owners, 2, { infra })
  const safeAddress = await safe.getAddress()
  await token.mint(safeAddress, usdc(100_000))
  await deployer.sendTransaction({ to: safeAddress, value: ethers.parseEther('10') })
  return {
    infra,
    safe,
    safeAddress,
    engine,
    guard,
    engineAddress: await engine.getAddress(),
    configAddress,
    batch,
    tokenCallbackHandler: await handler.getAddress(),
    timelock,
    args,
    limit,
    cosigner,
    token,
    tokenAddress: await token.getAddress(),
    deployer,
    o1,
    o2,
    o3,
    owners,
    quorum: [o1, o2],
    ops,
    agent,
    recovery,
    guardian,
    guardian2,
    cosignerKey,
    attacker,
    vendorA,
    vendorB,
    newOwner1,
    newOwner2,
    stranger,
    members: [m1, m2, m3],
  }
}

/**
 * The engine as `scripts/deploy-v2.ts` deploys it (`PolicyGuardConfig`, then `PolicyGuard(batches,
 * config)`), typed as `IPolicyGuard`, plus the guard's own (partial) ABI.
 */
export async function deployEngine(batches: string[]) {
  const d = await deployEngineScript(batches)
  const engine = await engineAt(d.engine)
  const guard = (await ethers.getContractAt(FQN.engine, d.engine)) as unknown as PolicyGuard
  return { engine, guard, configAddress: d.engineConfig }
}

/**
 * Installs the engine as one owners' batch (SPEC §3.3): `[configure(changes), enableModule(m)...,
 * setFallbackHandler(TokenCallbackHandler), setModuleGuard, setGuard]`, executed before any guard
 * runs. Leftovers of an earlier install are detached by putting their detach changes first in
 * `changes`. `fallbackHandler: null` keeps the Safe's handler (the compatibility handler, with
 * ERC-1271: the owners' off-chain signatures then bypass every policy).
 */
export async function install(
  w: World,
  changes: Change[],
  opts: { modules?: string[]; safe?: Safe; signers?: Signer[]; fallbackHandler?: string | null } = {},
) {
  const safe = opts.safe ?? w.safe
  const self = await safe.getAddress()
  const iface = safe.interface as Interface
  const handler = opts.fallbackHandler === undefined ? w.tokenCallbackHandler : opts.fallbackHandler
  const calls: MetaTx[] = [
    { to: w.engineAddress, data: w.engine.interface.encodeFunctionData('configure', [changes]) },
    ...(opts.modules ?? []).map((m) => ({ to: self, data: iface.encodeFunctionData('enableModule', [m]) })),
    ...(handler === null
      ? []
      : [{ to: self, data: iface.encodeFunctionData('setFallbackHandler', [handler]) }]),
    { to: self, data: iface.encodeFunctionData('setModuleGuard', [w.engineAddress]) },
    { to: self, data: iface.encodeFunctionData('setGuard', [w.engineAddress]) },
  ]
  return execAsOwners(safe, multiSendTx(w.batch, calls), opts.signers ?? w.quorum)
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

export const call = (to: string, data: BytesLike = '0x', value: bigint = 0n): MetaTx => ({
  to,
  data,
  value,
  operation: Op.CALL,
})
export const tokenCall = (w: World, fn: string, args: unknown[]): MetaTx =>
  call(w.tokenAddress, (w.token.interface as Interface).encodeFunctionData(fn, args))
export const transfer = (w: World, to: string, amount: bigint) => tokenCall(w, 'transfer', [to, amount])
export const approve = (w: World, spender: string, amount: bigint) =>
  tokenCall(w, 'approve', [spender, amount])
/** A call to the Safe itself. */
export const safeCall = (w: World, fn: string, args: unknown[]): MetaTx =>
  call(w.safeAddress, (w.safe.interface as Interface).encodeFunctionData(fn, args))
/** `engine.configure(changes)` as a call (owner path: implicit grant; module path: exact Allow). */
export const configureCall = (w: World, changes: Change[]): MetaTx =>
  call(w.engineAddress, w.engine.interface.encodeFunctionData('configure', [changes]))
/** A MultiSendCallOnly batch, DELEGATECALLed. */
export const batchTx = (w: World, calls: MetaTx[]) => multiSendTx(w.batch, calls)

/** `swapOwner(prev, old, new)` with `prev` read from the current owner list. */
export async function swapOwnerCall(w: World, oldOwner: string, newOwner: string, safe: Safe = w.safe) {
  const list = (await safe.getOwners()).map((o) => getAddress(o))
  const i = list.indexOf(getAddress(oldOwner))
  if (i < 0) throw new Error(`${oldOwner} is not an owner`)
  const prev = i === 0 ? SENTINEL : list[i - 1]
  return call(
    await safe.getAddress(),
    (safe.interface as Interface).encodeFunctionData('swapOwner', [prev, oldOwner, newOwner]),
  )
}

/** The owners execute `tx` (2-of-3 by default). */
export const execOwners = (w: World, tx: SafeTx, signers: Signer[] = w.quorum) =>
  execAsOwners(w.safe, tx, signers)
/** `module` executes `tx` through `execTransactionFromModule`. */
export const execModule = (w: World, module: Signer, tx: MetaTx) => execAsModule(w.safe, module, tx)

/** Module-path `ctx.txHash` (SPEC §3.1). */
export function moduleCallHash(w: World, actor: string, tx: MetaTx) {
  return keccak256(
    coder.encode(
      ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
      [w.safeAddress, actor, tx.to, tx.value ?? 0n, tx.data ?? '0x', tx.operation ?? Op.CALL],
    ),
  )
}

/** Owner-path `ctx.txHash`: the Safe transaction hash (at the current nonce unless `tx.nonce`). */
export const ownerTxHash = (w: World, tx: SafeTx) => safeTxHash(w.safe, tx)

/**
 * The owners schedule `tx` in the Timelock with their signatures (anyone relays; here `relayer`).
 * Returns the Safe transaction hash. `tx.nonce` defaults to the Safe's current nonce.
 */
export async function scheduleOwners(
  w: World,
  tx: SafeTx,
  signers: Signer[] = w.quorum,
  relayer: Signer = w.stranger,
) {
  const full = await completeTx(w.safe, tx)
  const sigs = await signSafeTx(w.safe, full, signers)
  await w.timelock.connect(relayer).schedule(w.engineAddress, w.safeAddress, full, sigs)
  return safeTxHash(w.safe, full)
}

/** `module` schedules its own call in the Timelock. */
export async function scheduleModule(w: World, module: Actor, tx: MetaTx) {
  await w.timelock
    .connect(module)
    .scheduleModuleTx(
      w.engineAddress,
      w.safeAddress,
      tx.to,
      tx.value ?? 0n,
      tx.data ?? '0x',
      tx.operation ?? Op.CALL,
    )
  return moduleCallHash(w, module.address, tx)
}

/** Owners' signatures over the Timelock cancel digest of `txHash` (relayed to `cancelAsOwners`). */
export async function signCancel(w: World, txHash: string, signers: Signer[]) {
  const digest = await w.timelock.cancelDigest(w.engineAddress, w.safeAddress, txHash)
  // Safe's `checkNSignatures` accepts eth_sign signatures (v + 4) over the raw digest.
  const signed = await Promise.all(
    signers.map(async (s) => {
      const sig = ethers.Signature.from(await s.signMessage(ethers.getBytes(digest)))
      return {
        owner: BigInt(await s.getAddress()),
        sig: ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 4, 1)]),
      }
    }),
  )
  signed.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  return ethers.concat(signed.map((x) => x.sig))
}

/** `approver` pushes its CoSigner approval of `txHash`, valid for a day. */
export async function coApprove(w: World, txHash: string, approver: Signer = w.cosignerKey) {
  const until = BigInt(await time.latest()) + DAY
  await w.cosigner.connect(approver).approve(w.engineAddress, w.safeAddress, txHash, until)
}

/** `approver` signs its CoSigner approval off-chain (EIP-712); anyone pushes it with `approveWithSig`. */
export async function coApproveWithSig(
  w: World,
  txHash: string,
  approver: Signer = w.cosignerKey,
  relayer?: Signer,
) {
  const validUntil = BigInt(await time.latest()) + DAY
  const { chainId } = await ethers.provider.getNetwork()
  const useCount = await w.cosigner.useCount(w.engineAddress, w.safeAddress, txHash)
  const signature = await approver.signTypedData(
    { name: 'CoSignerPolicy', version: '1', chainId, verifyingContract: addrOf(w.cosigner) },
    {
      Approval: [
        { name: 'engine', type: 'address' },
        { name: 'safe', type: 'address' },
        { name: 'txHash', type: 'bytes32' },
        { name: 'useCount', type: 'uint256' },
        { name: 'validUntil', type: 'uint64' },
      ],
    },
    { engine: w.engineAddress, safe: w.safeAddress, txHash, useCount, validUntil },
  )
  await w.cosigner
    .connect(relayer ?? w.stranger)
    .approveWithSig(
      w.engineAddress,
      w.safeAddress,
      txHash,
      await approver.getAddress(),
      validUntil,
      signature,
    )
}

/** A signer for a contract address (another Safe acting directly, e.g. in a `staticCall`). */
export async function impersonate(address: string) {
  await impersonateAccount(address)
  await setBalance(address, ethers.parseEther('1'))
  return ethers.getSigner(address)
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

async function dataOf(action: Promise<unknown> | (() => Promise<unknown>)): Promise<string> {
  try {
    await (typeof action === 'function' ? action() : action)
  } catch (e) {
    const data = revertData(e)
    if (data === undefined) throw new Error(`reverted without data: ${String(e)}`)
    return data
  }
  return expect.fail('expected a revert, but the call succeeded')
}

/** Asserts an engine error (`IPolicyGuard`) and, if given, its arguments. Returns the revert data. */
export async function expectEngineError(
  action: Promise<unknown> | (() => Promise<unknown>),
  w: World,
  name: string,
  args?: unknown[],
) {
  const data = await dataOf(action)
  const parsed = w.engine.interface.parseError(data)
  expect(parsed?.name, `revert data ${data}`).to.equal(name)
  if (args) expect(norm([...parsed!.args])).to.deep.equal(norm(args))
  return data
}

/**
 * Asserts `PolicyDenied(policy, reason)` from the engine with `reason` decoding to `name` in the
 * policy's ABI (and its `args`, if given). Returns the revert data.
 */
export async function expectPolicyDenied(
  action: Promise<unknown> | (() => Promise<unknown>),
  w: World,
  policy: BaseContract,
  name: string,
  args?: unknown[],
) {
  const data = await dataOf(action)
  const outer = w.engine.interface.parseError(data)
  expect(outer?.name, `revert data ${data}`).to.equal('PolicyDenied')
  expect(getAddress(outer!.args.policy)).to.equal(addrOf(policy))
  const inner = policy.interface.parseError(outer!.args.reason)
  expect(inner?.name, `reason ${outer!.args.reason}`).to.equal(name)
  if (args) expect(norm([...inner!.args])).to.deep.equal(norm(args))
  return data
}

/** Asserts a direct revert of a policy function (e.g. `freeze`, `schedule`) with `name`. */
export async function expectPolicyError(
  action: Promise<unknown> | (() => Promise<unknown>),
  policy: BaseContract,
  name: string,
  args?: unknown[],
) {
  const data = await dataOf(action)
  const parsed = policy.interface.parseError(data)
  expect(parsed?.name, `revert data ${data}`).to.equal(name)
  if (args) expect(norm([...parsed!.args])).to.deep.equal(norm(args))
}

/** gasUsed of a transaction. */
export async function gasOf(tx: Promise<ContractTransactionResponse>) {
  return (await (await tx).wait())!.gasUsed
}

function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm)
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string' && v.startsWith('0x')) return v.toLowerCase()
  return v
}
