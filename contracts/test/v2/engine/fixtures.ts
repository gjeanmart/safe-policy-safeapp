import { setBalance } from '@nomicfoundation/hardhat-network-helpers'
import {
  AbiCoder,
  type BytesLike,
  type ContractTransactionResponse,
  ZeroAddress,
  concat,
  getAddress,
  keccak256,
  solidityPacked,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type {
  EngineMultiSend,
  EngineTarget,
  MockPolicyV2,
  MockSafeV2,
  SafePolicyGuardV2,
} from '../../../typechain-types'
import { expectRevert as baseExpectRevert } from '../helpers'

/** Shared setup for the V2 engine unit tests (MockSafeV2 + MockPolicyV2). */

export const coder = AbiCoder.defaultAbiCoder()
export const ANY = ZeroAddress
export const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
export const CallMatch = { ANY: 0, TO: 1, SELECTOR: 2, TO_SELECTOR: 3 } as const
export const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export const Level = { CALL: 0, TRANSACTION: 1 } as const
export const Op = { CALL: 0, DELEGATECALL: 1 } as const
export const Verdict = { PASS: 0, ALLOW: 1, DENY: 2 } as const
export const GateKind = { ALLOW: 0, DENY: 1, POLICY: 2, RULE: 3 } as const
export const Behaviour = {
  PASS: 0,
  REVERT: 1,
  WRONG_MAGIC: 2,
  MALFORMED: 3,
  BURN_GAS: 4,
  WRONG_LEVEL_MAGIC: 5,
} as const
export const TX_INDEX = 65535
export const NO_LEVEL = 255
export const CONTEXT_TYPE_HASH = ethers.id('SafePolicyGuardV2.PolicyContext.v1')

export const TIMING = { delay: 100n, expiry: 2000n, maxFreeze: 1000n, cooldown: 200n }

export const SEL = {
  transfer: ethers.id('transfer(address,uint256)').slice(0, 10),
  approve: ethers.id('approve(address,uint256)').slice(0, 10),
  ping: '0x12345678',
  empty: '0x00000000',
}

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

/** Builds a normalized scope: the parts `callMatch` leaves open are zero. */
export function scope(
  actor: string,
  callMatch: number = CallMatch.ANY,
  to = ZeroAddress,
  selector = SEL.empty,
): ScopeData {
  const namesTo = callMatch === CallMatch.TO || callMatch === CallMatch.TO_SELECTOR
  const namesSel = callMatch === CallMatch.SELECTOR || callMatch === CallMatch.TO_SELECTOR
  return { actor, to: namesTo ? to : ZeroAddress, selector: namesSel ? selector : SEL.empty, callMatch }
}

export const scopeKey = (s: ScopeData) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]))
export const attachmentId = (s: ScopeData, kind: number, policy = ZeroAddress) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [scopeKey(s), kind, policy]))
export const levelOf = (s: ScopeData) => (s.actor === ANY ? 0 : 4) + s.callMatch

export const allow = (s: ScopeData, opMask = 0): Change => ({
  changeType: 0,
  scope: s,
  kind: Kind.ALLOW,
  policy: ZeroAddress,
  opMask,
  data: '0x',
})
export const deny = (s: ScopeData, opMask = 0): Change => ({ ...allow(s, opMask), kind: Kind.DENY })
export const settings = (behaviour: number, delayFloor = 0n) =>
  coder.encode(['uint8', 'uint256'], [behaviour, delayFloor])
export const policy = (
  s: ScopeData,
  p: string,
  behaviour: number = Behaviour.PASS,
  opMask = 0,
  floor = 0n,
): Change => ({
  changeType: 0,
  scope: s,
  kind: Kind.POLICY,
  policy: p,
  opMask,
  data: settings(behaviour, floor),
})
export const detach = (s: ScopeData, kind: number, p = ZeroAddress): Change => ({
  changeType: 1,
  scope: s,
  kind,
  policy: p,
  opMask: 0,
  data: '0x',
})

export type Tx = { op: number; to: string; value: bigint; data: string }
export const multiSendData = (txs: Tx[]) =>
  concat([
    '0x8d80ff0a',
    coder.encode(
      ['bytes'],
      [
        concat(
          txs.map((t) =>
            solidityPacked(
              ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
              [t.op, t.to, t.value, (t.data.length - 2) / 2, t.data],
            ),
          ),
        ),
      ],
    ),
  ])

/** `abi.encode(PolicyContext[])` wrapped in a SignatureExtension envelope after `ownerSigs`. */
export function withContext(entries: { policy: string; data: string }[], ownerSigs = '0x'): string {
  const payload = coder.encode(
    ['tuple(address policy, bytes data)[]'],
    [entries.map((e) => [e.policy, e.data])],
  )
  return envelope(payload, ownerSigs)
}

export function envelope(payload: BytesLike, ownerSigs: BytesLike = '0x'): string {
  const len = ethers.dataLength(payload)
  return concat([ownerSigs, payload, zeroPadValue(toBeHex(len), 32), CONTEXT_TYPE_HASH])
}

export async function deployEngine(
  opts: {
    delay?: bigint
    expiry?: bigint
    maxFreeze?: bigint
    cooldown?: bigint
    batches?: string[]
    signLib?: string
  } = {},
) {
  const multiSend = (await ethers.deployContract('EngineMultiSend')) as unknown as EngineMultiSend
  const signLib = opts.signLib ?? ethers.Wallet.createRandom().address
  const engine = (await ethers.deployContract('SafePolicyGuardV2', [
    opts.delay ?? TIMING.delay,
    opts.expiry ?? TIMING.expiry,
    opts.maxFreeze ?? TIMING.maxFreeze,
    opts.cooldown ?? TIMING.cooldown,
    opts.batches ?? [await multiSend.getAddress()],
    signLib,
  ])) as unknown as SafePolicyGuardV2
  return { engine, multiSend, signLib }
}

/** A MockSafeV2 with the impersonated signer that acts as the Safe itself (for direct config calls). */
export async function deploySafe() {
  const safe = (await ethers.deployContract('MockSafeV2')) as unknown as MockSafeV2
  const address = await safe.getAddress()
  await setBalance(address, 10n ** 20n)
  const asSafe = await ethers.getImpersonatedSigner(address)
  return { safe, address, asSafe }
}

export async function execOwner(
  safe: MockSafeV2,
  to: string,
  data: string = '0x',
  op: number = Op.CALL,
  value = 0n,
  signatures = '0x',
): Promise<ContractTransactionResponse> {
  return safe.execTransaction(to, value, data, op, 0, 0, 0, ZeroAddress, ZeroAddress, signatures, {
    gasLimit: 15_000_000,
  })
}

export async function execModule(
  safe: MockSafeV2,
  module: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  to: string,
  data: string = '0x',
  op: number = Op.CALL,
  value = 0n,
): Promise<ContractTransactionResponse> {
  return safe.connect(module).execTransactionFromModule(to, value, data, op, { gasLimit: 15_000_000 })
}

/**
 * The standard fixture: engine, a Safe configured immediately with `changes`, then the engine
 * installed as guard and module guard, `module` enabled, and two targets.
 */
export async function setup(
  changesOrFn: Change[] | ((ctx: { targetAddr: string; module: string }) => Change[]) = [],
  roles: RoleChange[] = [],
  engineOpts = {},
) {
  const signers = await ethers.getSigners()
  const [deployer, module, other, guardian, lifter] = signers
  const { engine, multiSend, signLib } = await deployEngine(engineOpts)
  const engineAddr = await engine.getAddress()
  const { safe, address: safeAddr, asSafe } = await deploySafe()
  const target = (await ethers.deployContract('EngineTarget')) as unknown as EngineTarget
  const target2 = (await ethers.deployContract('EngineTarget')) as unknown as EngineTarget
  const callPolicy = (await ethers.deployContract('MockPolicyV2', [Level.CALL])) as unknown as MockPolicyV2
  const txPolicy = (await ethers.deployContract('MockPolicyV2', [
    Level.TRANSACTION,
  ])) as unknown as MockPolicyV2
  const changes =
    typeof changesOrFn === 'function'
      ? changesOrFn({ targetAddr: await target.getAddress(), module: module.address })
      : changesOrFn
  // Chunked: the per-transaction gas cap (16.7M) is below what the worst-case gas fixture needs.
  for (let i = 0; i < Math.max(changes.length, 1); i += 24) {
    const chunk = changes.slice(i, i + 24)
    const chunkRoles = i === 0 ? roles : []
    if (chunk.length || chunkRoles.length) {
      await engine.connect(asSafe).configureImmediately(chunk, chunkRoles, { gasLimit: 16_000_000 })
    }
  }
  await execOwner(safe, safeAddr, safe.interface.encodeFunctionData('enableModule', [module.address]))
  await execOwner(safe, safeAddr, safe.interface.encodeFunctionData('setModuleGuard', [engineAddr]))
  await execOwner(safe, safeAddr, safe.interface.encodeFunctionData('setGuard', [engineAddr]))
  return {
    engine,
    engineAddr,
    multiSend,
    multiSendAddr: await multiSend.getAddress(),
    signLib,
    safe,
    safeAddr,
    asSafe,
    target,
    targetAddr: await target.getAddress(),
    target2Addr: await target2.getAddress(),
    callPolicy,
    callPolicyAddr: await callPolicy.getAddress(),
    txPolicy,
    txPolicyAddr: await txPolicy.getAddress(),
    deployer,
    module,
    other,
    guardian,
    lifter,
  }
}

/** Every error name asserted through {expectRevert}; checked by the coverage test. */
export const coveredErrors = new Set<string>()

export async function expectRevert(
  action: Promise<unknown> | (() => Promise<unknown>),
  contract: Parameters<typeof baseExpectRevert>[1],
  errorName: string,
  args?: unknown[],
): Promise<void> {
  await baseExpectRevert(action, contract, errorName, args)
  coveredErrors.add(errorName)
}

/** Calls `preview` and returns the decoded gates (it always reverts with `Preview`). */
export async function previewGates(
  engine: SafePolicyGuardV2,
  safe: string,
  actor: string,
  to: string,
  data = '0x',
  op: number = Op.CALL,
  value = 0n,
) {
  let revertData: string | undefined
  try {
    await engine.preview.staticCall(safe, actor, to, value, data, op, { gasLimit: 15_000_000 })
  } catch (e) {
    const err = e as { data?: string }
    revertData = err.data
  }
  if (!revertData) throw new Error('preview did not revert with data')
  const parsed = engine.interface.parseError(revertData)
  if (parsed?.name !== 'Preview') throw new Error(`expected Preview, got ${parsed?.name}`)
  coveredErrors.add('Preview')
  const gates = (parsed.args[0] as unknown[]).map((g) => {
    const [callIndex, scopeLevel, kind, attachmentId_, policy_, verdict, reason] = g as [
      bigint,
      bigint,
      bigint,
      string,
      string,
      bigint,
      string,
    ]
    return {
      callIndex: Number(callIndex),
      scopeLevel: Number(scopeLevel),
      kind: Number(kind),
      attachmentId: attachmentId_,
      policy: policy_,
      verdict: Number(verdict),
      reason,
      reasonName: reason === '0x' ? '' : (engine.interface.parseError(reason)?.name ?? reason),
    }
  })
  for (const g of gates) if (g.reasonName && !g.reasonName.startsWith('0x')) coveredErrors.add(g.reasonName)
  return gates
}
