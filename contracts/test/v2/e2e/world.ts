import { time } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import {
  AbiCoder,
  type BaseContract,
  type BytesLike,
  type ContractTransactionResponse,
  type Interface,
  SigningKey,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  hexlify,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import { deployEngineV2, deployTimelockPolicy, engineAt } from '../../../scripts/lib/v2-deployment'
import type {
  CoSignerPolicyV2,
  CowSettlementStub,
  E2eToken,
  FreezePolicy,
  FrostChallenge,
  ISafePolicyGuardV2,
  LimitPolicy,
  Permit2Stub,
  PolicyFallbackHandler,
  PolicySignLib,
  QuorumPolicyV2,
  RecipientsPolicy,
  SafenetPolicyV2,
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
  policyContextTail,
  safeTxHash,
  signSafeTx,
} from '../fixtures/safe'

/**
 * WP7 end-to-end world: a real Safe 1.5.0 guarded by the real `SafePolicyGuardV2` (installed as
 * both guard and module guard) with the real policies, PolicySignLib and PolicyFallbackHandler.
 * Every story file builds on this; nothing here is a stub except the CoW settlement / Permit2
 * domains and the USDC-style token.
 */

export const coder = AbiCoder.defaultAbiCoder()

export const HOUR = 3600n
export const DAY = 24n * HOUR
/** Owners' timelock T < recovery's timelock R < maximum freeze F (design doc §2.6). */
export const T = DAY
export const R = 3n * DAY
export const F = 7n * DAY
export const C = 12n * HOUR
/** Configuration delay: at least the owners' timelock (SPEC §5.3). */
export const DELAY = T
/** `EXPIRY ≥ F + C + DELAY` (SPEC §5.4). */
export const EXPIRY = 9n * DAY

export const ANY = ZeroAddress
export const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
export const CallMatch = { ANY: 0, TO: 1, SELECTOR: 2, TO_SELECTOR: 3 } as const
export const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export const Role = { GUARDIAN: 0, LIFTER: 1 } as const
export const Op = { CALL: 0, DELEGATECALL: 1 } as const
export const OP_CALL = 1
export const OP_DELEGATECALL = 2
export const OP_ALL = 3
export const TX_INDEX = 65535n
export const Verdict = { PASS: 0, ALLOW: 1, DENY: 2 } as const
export const GateKind = { ALLOW: 0, DENY: 1, POLICY: 2, RULE: 3 } as const

export const usdc = (n: number | bigint) => BigInt(n) * 10n ** 6n

export const SEL = {
  transfer: id('transfer(address,uint256)').slice(0, 10),
  transferFrom: id('transferFrom(address,address,uint256)').slice(0, 10),
  approve: id('approve(address,uint256)').slice(0, 10),
  swapOwner: id('swapOwner(address,address,address)').slice(0, 10),
  signCowOrder: '0x3d296e04',
  signPermit: '0x51bdfa61',
}

// Safenet (SPEC §8.7): a single-signer FROST group, as WP5's tests.
export const CONSENSUS_CHAIN_ID = 100n
export const CONSENSUS_ADDRESS = '0x1111111111111111111111111111111111111111'
export const GENESIS_EPOCH = 7n
const GROUP_SECRET = 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afen
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// ---------------------------------------------------------------------------------------------
// Scopes, changes and settings
// ---------------------------------------------------------------------------------------------

export type ScopeData = { actor: string; to: string; selector: string; callMatch: number }
export type Change = {
  changeType: number
  scope: ScopeData
  kind: number
  policy: string
  opMask: number
  data: string
}
export type RoleChange = { role: number; account: string; enabled: boolean }

/** `(actor, *)`, `(actor, to.*)`, `(actor, *.selector)` or `(actor, to.selector)`, normalized. */
export function scope(actor: string, to?: string, selector?: string): ScopeData {
  const callMatch =
    to && selector ? CallMatch.TO_SELECTOR : to ? CallMatch.TO : selector ? CallMatch.SELECTOR : CallMatch.ANY
  return { actor, to: to ?? ZeroAddress, selector: selector ?? '0x00000000', callMatch }
}

export const scopeKey = (s: ScopeData) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]))
export const attachmentId = (s: ScopeData, kind: number, policy = ZeroAddress) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [scopeKey(s), kind, policy]))

export const allow = (s: ScopeData, opMask = OP_CALL): Change => ({
  changeType: 0,
  scope: s,
  kind: Kind.ALLOW,
  policy: ZeroAddress,
  opMask,
  data: '0x',
})
export const deny = (s: ScopeData, opMask = OP_ALL): Change => ({ ...allow(s, opMask), kind: Kind.DENY })
export const attach = (s: ScopeData, policy: string, data: string, opMask = OP_ALL): Change => ({
  changeType: 0,
  scope: s,
  kind: Kind.POLICY,
  policy,
  opMask,
  data,
})
export const detach = (s: ScopeData, kind: number, policy = ZeroAddress): Change => ({
  changeType: 1,
  scope: s,
  kind,
  policy,
  opMask: 0,
  data: '0x',
})
export const guardianRole = (account: string, enabled = true): RoleChange => ({
  role: Role.GUARDIAN,
  account,
  enabled,
})
export const lifterRole = (account: string, enabled = true): RoleChange => ({
  role: Role.LIFTER,
  account,
  enabled,
})

export const freezeSettings = (safeWide: boolean, actor: boolean) =>
  coder.encode(['tuple(bool,bool)'], [[safeWide, actor]])
export const timelockSettings = (
  delay: bigint,
  o: { window?: bigint; clearOnFreeze?: boolean; cancellers?: string[] } = {},
) =>
  coder.encode(
    ['tuple(uint32,uint32,bool,address[])'],
    [[delay, o.window ?? 0n, o.clearOnFreeze ?? false, o.cancellers ?? []]],
  )
export const recipientsSettings = (
  o: { recipients?: string[]; spenders?: string[]; maxApproval?: bigint; strict?: boolean } = {},
) =>
  coder.encode(
    ['tuple(address[],address[],uint256,bool)'],
    [[o.recipients ?? [], o.spenders ?? [], o.maxApproval ?? 0n, o.strict ?? false]],
  )
export const limitSettings = (
  limits: { token: string; amount: bigint; period: bigint }[],
  passUnpriced = false,
) =>
  coder.encode(
    ['tuple(tuple(address,uint128,uint64)[],bool)'],
    [[limits.map((l) => [l.token, l.amount, l.period]), passUnpriced]],
  )
export const cosignerSettings = (cosigner: string) => coder.encode(['tuple(address)'], [[cosigner]])

// ---------------------------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------------------------

export type World = Awaited<ReturnType<typeof deployWorld>>

/**
 * Safe 1.5.0 (owners o1, o2, o3; threshold 2; 10 ETH and 100,000 USDC), the engine with
 * `MultiSendCallOnly` and `MultiSend` as trusted batches, every policy, the sign lib and the
 * policy fallback handler. Nothing is installed yet: see {@link install}.
 */
export async function deployWorld(opts: { delay?: bigint; infra?: SafeInfra } = {}) {
  const [
    deployer,
    o1,
    o2,
    o3,
    guardian,
    recovery,
    ops,
    agent,
    vendorA,
    vendorB,
    attacker,
    newOwner1,
    newOwner2,
    outsider,
    sparkOwner,
  ] = await ethers.getSigners()
  const infra = opts.infra ?? (await deploySafeInfra())
  const safe = await deploySafe([o1, o2, o3], 2, { infra })
  const safeAddress = await safe.getAddress()

  const cow = (await ethers.deployContract('CowSettlementStub')) as unknown as CowSettlementStub
  const permit2 = (await ethers.deployContract('Permit2Stub')) as unknown as Permit2Stub
  const signLib = (await ethers.deployContract('PolicySignLib', [cow, permit2])) as unknown as PolicySignLib
  const delay = opts.delay ?? DELAY
  // The guard and its modules, and TimelockPolicy with its queue, as scripts/deploy-v2.ts deploys them.
  const { engine: engineAddress } = await deployEngineV2({
    delay,
    expiry: EXPIRY,
    maxFreeze: F,
    freezeCooldown: C,
    trustedBatches: [await infra.multiSendCallOnly.getAddress(), await infra.multiSend.getAddress()],
    signLib: await signLib.getAddress(),
  })
  const engine = await engineAt(engineAddress)
  const handler = (await ethers.deployContract('PolicyFallbackHandler')) as unknown as PolicyFallbackHandler

  const freeze = (await ethers.deployContract('FreezePolicy')) as unknown as FreezePolicy
  const timelock = (await ethers.getContractAt(
    'TimelockPolicy',
    await deployTimelockPolicy(),
  )) as unknown as TimelockPolicy
  const recipients = (await ethers.deployContract('RecipientsPolicy')) as unknown as RecipientsPolicy
  const limit = (await ethers.deployContract('LimitPolicy')) as unknown as LimitPolicy
  const cosignerPolicy = (await ethers.deployContract('CoSignerPolicyV2')) as unknown as CoSignerPolicyV2
  const quorum = (await ethers.deployContract('QuorumPolicyV2')) as unknown as QuorumPolicyV2
  const groupKey = pointFromScalar(GROUP_SECRET)
  const safenet = (await ethers.deployContract('SafenetPolicyV2', [
    CONSENSUS_CHAIN_ID,
    CONSENSUS_ADDRESS,
    GENESIS_EPOCH,
    groupKey,
  ])) as unknown as SafenetPolicyV2
  const frost = (await ethers.deployContract('FrostChallenge')) as unknown as FrostChallenge

  const token = (await ethers.deployContract('E2eToken')) as unknown as E2eToken
  await token.mint(safeAddress, usdc(100_000))
  await deployer.sendTransaction({ to: safeAddress, value: ethers.parseEther('10') })

  // A raw key: co-signers sign the plain hash (SPEC §8.6), which a JSON-RPC signer cannot.
  const cosigner = new Wallet(keccak256(id('e2e co-signer')))

  return {
    deployer,
    o1,
    o2,
    o3,
    owners: [o1, o2, o3],
    /** Two of three owners: the threshold. */
    quorum2: [o1, o2],
    guardian,
    recovery,
    ops,
    agent,
    vendorA,
    vendorB,
    attacker,
    newOwner1,
    newOwner2,
    outsider,
    sparkOwner,
    cosigner,
    infra,
    safe,
    safeAddress,
    engine,
    engineAddress: await engine.getAddress(),
    signLib,
    signLibAddress: await signLib.getAddress(),
    cow,
    permit2,
    handler,
    freeze,
    timelock,
    recipients,
    limit,
    cosignerPolicy,
    quorum,
    safenet,
    frost,
    token,
    tokenAddress: await token.getAddress(),
  }
}

/**
 * Installs a configuration the way a new Safe adopts V2: `configureImmediately` (allowed while the
 * engine is neither guard), modules enabled, `PolicyFallbackHandler` set, then the engine as module
 * guard and guard (the transaction guard last: from then on every owner transaction is checked,
 * here by the owners' Timelock). Separate owner transactions here; `Install.test.ts` checks the one-batch form.
 */
export async function install(
  w: World,
  changes: Change[],
  roles: RoleChange[] = [],
  opts: { modules?: string[]; fallbackHandler?: string } = {},
) {
  const self = w.safeAddress
  const safeIface = w.safe.interface as Interface
  await execAsOwners(
    w.safe,
    {
      to: w.engineAddress,
      data: w.engine.interface.encodeFunctionData('configureImmediately', [changes, roles]),
    },
    w.quorum2,
  )
  for (const m of opts.modules ?? []) {
    await execAsOwners(
      w.safe,
      { to: self, data: safeIface.encodeFunctionData('enableModule', [m]) },
      w.quorum2,
    )
  }
  const handler = opts.fallbackHandler ?? (await w.handler.getAddress())
  await execAsOwners(
    w.safe,
    { to: self, data: safeIface.encodeFunctionData('setFallbackHandler', [handler]) },
    w.quorum2,
  )
  await execAsOwners(
    w.safe,
    { to: self, data: safeIface.encodeFunctionData('setModuleGuard', [w.engineAddress]) },
    w.quorum2,
  )
  await execAsOwners(
    w.safe,
    { to: self, data: safeIface.encodeFunctionData('setGuard', [w.engineAddress]) },
    w.quorum2,
  )
}

// ---------------------------------------------------------------------------------------------
// The design doc's example organisation (§3 table)
// ---------------------------------------------------------------------------------------------

export const OPS_BUDGET = usdc(5_000)
export const AGENT_BUDGET = usdc(1_000)
export const MONTH = 30n * DAY

/**
 * | Scope                        | Policies                                         |
 * | ---------------------------- | ------------------------------------------------ |
 * | `(Owners, *)`                | Allow + Freeze + Timelock 24h (clears on freeze) |
 * | `(Ops, *)`                   | Limit 5,000 USDC / month + Freeze                |
 * | `(Ops, USDC.transfer)`       | Allow + Recipients: vendor A, vendor B           |
 * | `(Agent, *)`                 | Limit 1,000 USDC / day + Co-signer + Freeze      |
 * | `(Agent, SignLib.signCowOrder)` | Allow (CoW orders, priced by Limit)          |
 * | `(Recovery, *)`              | Timelock 72h (no Freeze: the fire exit)          |
 * | `(Recovery, Safe.swapOwner)` | Allow                                            |
 *
 * The doc's "global Freeze" is placed per actor (SPEC §8.1): a Freeze at `(*, *)` would also stop
 * recovery's owner change, which `OrgChart.test.ts` shows.
 */
export function orgChanges(w: World): Change[] {
  const { safeAddress, tokenAddress, signLibAddress } = w
  const owners = scope(OWNERS)
  const ops = scope(w.ops.address)
  const agent = scope(w.agent.address)
  const recovery = scope(w.recovery.address)
  return [
    allow(owners),
    attach(owners, addr(w.freeze), freezeSettings(true, false)),
    attach(owners, addr(w.timelock), timelockSettings(T, { clearOnFreeze: true })),

    attach(ops, addr(w.limit), limitSettings([{ token: tokenAddress, amount: OPS_BUDGET, period: MONTH }])),
    attach(ops, addr(w.freeze), freezeSettings(true, true)),
    allow(scope(w.ops.address, tokenAddress, SEL.transfer)),
    attach(
      scope(w.ops.address, tokenAddress, SEL.transfer),
      addr(w.recipients),
      recipientsSettings({ recipients: [w.vendorA.address, w.vendorB.address] }),
    ),

    attach(agent, addr(w.limit), limitSettings([{ token: tokenAddress, amount: AGENT_BUDGET, period: DAY }])),
    attach(agent, addr(w.cosignerPolicy), cosignerSettings(w.cosigner.address)),
    attach(agent, addr(w.freeze), freezeSettings(true, true)),
    allow(scope(w.agent.address, signLibAddress, SEL.signCowOrder)),

    attach(recovery, addr(w.timelock), timelockSettings(R)),
    allow(scope(w.recovery.address, safeAddress, SEL.swapOwner)),
  ]
}

export const orgRoles = (w: World): RoleChange[] => [
  guardianRole(w.guardian.address),
  lifterRole(w.recovery.address),
]

/** The organisation installed, with Ops, Agent and Recovery enabled as modules. */
export async function deployOrg() {
  const w = await deployWorld()
  await install(w, orgChanges(w), orgRoles(w), {
    modules: [w.ops.address, w.agent.address, w.recovery.address],
  })
  return w
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

export const addr = (c: BaseContract) => c.target as string

export const call = (
  to: string,
  data: BytesLike = '0x',
  value = 0n,
  operation: number = Op.CALL,
): MetaTx => ({
  to,
  data: hexlify(data),
  value,
  operation,
})

export const tokenTransfer = (w: World, to: string, amount: bigint): MetaTx =>
  call(w.tokenAddress, w.token.interface.encodeFunctionData('transfer', [to, amount]))
export const tokenApprove = (w: World, spender: string, amount: bigint): MetaTx =>
  call(w.tokenAddress, w.token.interface.encodeFunctionData('approve', [spender, amount]))
export const safeCall = (w: World, fn: string, args: unknown[]): MetaTx =>
  call(w.safeAddress, (w.safe.interface as Interface).encodeFunctionData(fn, args))
export const engineCall = (w: World, fn: string, args: unknown[]): MetaTx =>
  call(w.engineAddress, (w.engine.interface as Interface).encodeFunctionData(fn, args))

/** A CoW sell order of `sellAmount` USDC (+ `feeAmount`), valid for an hour. */
export async function cowOrder(w: World, sellAmount: bigint, feeAmount = 0n, receiver = ZeroAddress) {
  return {
    sellToken: w.tokenAddress,
    buyToken: getAddress('0x00000000000000000000000000000000000000ee'),
    receiver,
    sellAmount,
    buyAmount: sellAmount,
    validTo: Number(await time.latest()) + 3600,
    appData: id('e2e'),
    feeAmount,
    kind: id('sell'),
    partiallyFillable: false,
    sellTokenBalance: id('erc20'),
    buyTokenBalance: id('erc20'),
  }
}

/** DELEGATECALL `PolicySignLib.signCowOrder(order)`: the engine matches it as a CALL (SPEC §6.3). */
export const signCowOrderCall = (w: World, order: Awaited<ReturnType<typeof cowOrder>>): MetaTx =>
  call(w.signLibAddress, w.signLib.interface.encodeFunctionData('signCowOrder', [order]), 0n, Op.DELEGATECALL)

/** DELEGATECALL `PolicySignLib.signPermit(token, spender, value, deadline, nonce)`. */
export const signPermitCall = (
  w: World,
  spender: string,
  value: bigint,
  deadline: bigint,
  nonce = 0n,
): MetaTx =>
  call(
    w.signLibAddress,
    w.signLib.interface.encodeFunctionData('signPermit', [w.tokenAddress, spender, value, deadline, nonce]),
    0n,
    Op.DELEGATECALL,
  )

/** `swapOwner` with the right `prevOwner`, read from the Safe's linked list. */
export async function swapOwnerCall(w: World, oldOwner: string, newOwner: string): Promise<MetaTx> {
  const owners = (await w.safe.getOwners()).map((o) => getAddress(o))
  const i = owners.indexOf(getAddress(oldOwner))
  if (i < 0) throw new Error(`${oldOwner} is not an owner`)
  return safeCall(w, 'swapOwner', [i === 0 ? OWNERS : owners[i - 1], oldOwner, newOwner])
}

/** Owners execute `tx` now (signers sorted and packed, optional policy-context tail). */
export async function execOwners(
  w: World,
  tx: SafeTx,
  signers: HardhatEthersSigner[] = w.quorum2,
  tail: BytesLike = '0x',
): Promise<ContractTransactionResponse> {
  return execAsOwners(w.safe, tx, signers, { tail })
}

/**
 * Owners schedule `tx` at the Safe's current nonce (or `nonce`) with the same signatures that will
 * execute it (TimelockPolicy.scheduleOwnerTx, SPEC §8.2). Returns the Safe transaction hash.
 */
export async function scheduleOwners(
  w: World,
  tx: SafeTx,
  signers: HardhatEthersSigner[] = w.quorum2,
  nonce?: bigint,
): Promise<string> {
  const full = await completeTx(w.safe, { ...tx, nonce: nonce ?? tx.nonce })
  const sigs = await signSafeTx(w.safe, full, signers)
  await w.timelock.scheduleOwnerTx(w.engineAddress, w.safeAddress, full, sigs)
  return safeTxHash(w.safe, full)
}

/** Schedule, wait `delay`, execute: the owners' normal flow under their Timelock. */
export async function execOwnersAfter(
  w: World,
  tx: SafeTx,
  delay: bigint = T,
  signers: HardhatEthersSigner[] = w.quorum2,
): Promise<ContractTransactionResponse> {
  await scheduleOwners(w, tx, signers)
  await time.increase(delay)
  return execOwners(w, tx, signers)
}

export const execModule = (w: World, module: HardhatEthersSigner, tx: MetaTx) =>
  execAsModule(w.safe, module, tx)

/** A module schedules its own call (TimelockPolicy.scheduleModuleTx); returns the call hash. */
export async function scheduleModule(w: World, module: HardhatEthersSigner, tx: MetaTx): Promise<string> {
  const args = [
    w.engineAddress,
    w.safeAddress,
    tx.to,
    tx.value ?? 0n,
    tx.data ?? '0x',
    tx.operation ?? Op.CALL,
  ] as const
  const hash = await w.timelock.connect(module).scheduleModuleTx.staticCall(...args)
  await w.timelock.connect(module).scheduleModuleTx(...args)
  return hash
}

/** `moduleCallHash(safe, module, to, value, data, op)`: the module-path identity (SPEC §7). */
export const moduleCallHash = (w: World, module: string, tx: MetaTx) =>
  w.engine.moduleCallHash(
    w.safeAddress,
    module,
    tx.to,
    tx.value ?? 0n,
    tx.data ?? '0x',
    tx.operation ?? Op.CALL,
  )

/** Owners request `changes` + `roles` (configuration path: no policy runs). Returns the root. */
export async function requestConfig(
  w: World,
  changes: Change[],
  roles: RoleChange[] = [],
  signers: HardhatEthersSigner[] = w.quorum2,
): Promise<string> {
  const root = await w.engine.configurationRoot(changes, roles)
  await execOwners(w, engineCall(w, 'requestConfiguration', [root]), signers)
  return root
}

export const applyConfig = (
  w: World,
  changes: Change[],
  roles: RoleChange[] = [],
  signers: HardhatEthersSigner[] = w.quorum2,
) => execOwners(w, engineCall(w, 'applyConfiguration', [changes, roles]), signers)

// ---------------------------------------------------------------------------------------------
// Proofs: co-signatures and Safenet attestations
// ---------------------------------------------------------------------------------------------

/** The co-signer's raw ECDSA signature over `digest` (65 bytes, low s). */
export const cosign = (w: World, digest: string) => w.cosigner.signingKey.sign(digest).serialized

/** `abi.encode(CoSignature[])`: the co-signer policy's owner-path context (SPEC §8.6). */
export const coSignatures = (entries: [string, string][]) =>
  coder.encode(['tuple(address cosigner, bytes signature)[]'], [entries])

type Point = { x: bigint; y: bigint }

function pointFromScalar(scalar: bigint): Point {
  const uncompressed = SigningKey.computePublicKey(zeroPadValue(toBeHex(scalar), 32), false)
  return { x: BigInt(`0x${uncompressed.slice(4, 68)}`), y: BigInt(`0x${uncompressed.slice(68, 132)}`) }
}

const consensusDomain = keccak256(
  coder.encode(
    ['bytes32', 'uint256', 'address'],
    [id('EIP712Domain(uint256 chainId,address verifyingContract)'), CONSENSUS_CHAIN_ID, CONSENSUS_ADDRESS],
  ),
)

/**
 * A real Safenet attestation (V1's 256-byte encoding) over `safeTxHash`: the FROST group of
 * {@link GROUP_SECRET} signs `TransactionProposal(epoch, oracle, oracleData, safeTxHash)`. One
 * participant makes FROST a Schnorr signature, so it can be built in TS (as WP5's tests do).
 */
export async function attest(w: World, safeTxHash_: string): Promise<string> {
  const oracle = Wallet.createRandom().address
  const oracleDataHash = id('oracle-data')
  const message = keccak256(
    concat([
      '0x1901',
      consensusDomain,
      keccak256(
        coder.encode(
          ['bytes32', 'uint64', 'address', 'bytes32', 'bytes32'],
          [
            id('TransactionProposal(uint64 epoch,address oracle,bytes oracleData,bytes32 safeTxHash)'),
            GENESIS_EPOCH,
            oracle,
            oracleDataHash,
            safeTxHash_,
          ],
        ),
      ),
    ]),
  )
  const groupKey = pointFromScalar(GROUP_SECRET)
  const nonce = BigInt(hexlify(ethers.randomBytes(32))) % SECP_N
  const r = pointFromScalar(nonce)
  const c = await w.frost.challenge(r, groupKey, message)
  const signature = { r, z: (nonce + c * GROUP_SECRET) % SECP_N }
  return coder.encode(
    [
      'uint64',
      'address',
      'bytes32',
      'tuple(uint256 x, uint256 y)',
      'tuple(tuple(uint256 x, uint256 y) r, uint256 z)',
    ],
    [GENESIS_EPOCH, oracle, oracleDataHash, groupKey, signature],
  )
}

export { policyContextTail }

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

export function revertDataOf(e: unknown): string | undefined {
  const err = e as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } }
  for (const d of [err?.data, err?.info?.error?.data, err?.error?.data]) {
    if (typeof d === 'string' && d.startsWith('0x')) return d
    if (d && typeof (d as { data?: unknown }).data === 'string') return (d as { data: string }).data
  }
  return undefined
}

async function revertOf(action: Promise<unknown>): Promise<string> {
  try {
    await action
  } catch (e) {
    const data = revertDataOf(e)
    if (data === undefined) throw e
    return data
  }
  expect.fail('expected a revert, but the call succeeded')
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string' && v.startsWith('0x')) return v.toLowerCase()
  return v
}

/** Asserts a revert with the engine's (or any contract's) error `name`, and `args` if given. */
export async function expectError(
  action: Promise<unknown>,
  contract: { interface: Interface },
  name: string,
  args?: unknown[],
): Promise<void> {
  const data = await revertOf(action)
  const parsed = contract.interface.parseError(data)
  expect(parsed?.name, `revert data ${data}`).to.equal(name)
  if (args) expect(normalize([...parsed!.args])).to.deep.equal(normalize(args))
}

/**
 * Asserts the engine denied with `PolicyDenied(callIndex, policy, reason)` and that `reason`
 * decodes to the policy's `name` (with `args`, if given). `callIndex` defaults to "any".
 */
export async function expectPolicyDenied(
  action: Promise<unknown>,
  engine: ISafePolicyGuardV2,
  policy: BaseContract,
  name: string,
  args?: unknown[],
  callIndex?: bigint,
): Promise<void> {
  const data = await revertOf(action)
  const outer = engine.interface.parseError(data)
  expect(outer?.name, `revert data ${data}`).to.equal('PolicyDenied')
  expect(getAddress(outer!.args.policy)).to.equal(getAddress(policy.target as string))
  if (callIndex !== undefined) expect(outer!.args.callIndex).to.equal(callIndex)
  const inner = policy.interface.parseError(outer!.args.reason)
  expect(inner?.name, `reason ${outer!.args.reason}`).to.equal(name)
  if (args) expect(normalize([...inner!.args])).to.deep.equal(normalize(args))
}

/** Asserts a Safe `GSxxx` revert (`Error(string)`). */
export async function expectSafeError(action: Promise<unknown>, code: string): Promise<void> {
  const data = await revertOf(action)
  expect(data.slice(0, 10)).to.equal('0x08c379a0')
  expect(coder.decode(['string'], '0x' + data.slice(10))[0]).to.equal(code)
}

/** Owner-style eth_sign signatures over a raw hash (`v + 4`), sorted by signer: Timelock cancels. */
export async function ethSign(hash: string, signers: HardhatEthersSigner[]): Promise<string> {
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const sigs = await Promise.all(
    sorted.map(async (s) => {
      const b = getBytes(await s.signMessage(getBytes(hash)))
      b[64] += 4
      return b
    }),
  )
  return hexlify(concat(sigs))
}
