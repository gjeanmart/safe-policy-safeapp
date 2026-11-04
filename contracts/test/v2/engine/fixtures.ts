import { setBalance } from '@nomicfoundation/hardhat-network-helpers'
import {
  AbiCoder,
  type ContractTransactionResponse,
  type Signer,
  ZeroAddress,
  concat,
  getAddress,
  id,
  keccak256,
  solidityPacked,
} from 'ethers'
import { ethers } from 'hardhat'
import type {
  EngineMockPolicy,
  EngineMultiSend,
  EngineTarget,
  IPolicyGuard,
  MockSafeV2,
  PolicyGuard,
} from '../../../typechain-types'
import { expectRevert as baseExpectRevert } from '../helpers'

/** Shared setup for the rev 3 engine unit tests (MockSafeV2 + EngineMockPolicy). */

export const coder = AbiCoder.defaultAbiCoder()
export const ANY = ZeroAddress
export const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
export const CallMatch = { ANY: 0, CONTRACT: 1, FUNCTION: 2 } as const
export const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export const Op = { CALL: 0, DELEGATECALL: 1 } as const
export const Mask = { CALL: 1, DELEGATECALL: 2, ALL: 3 } as const
export const Behaviour = {
  PASS: 0,
  REVERT: 1,
  WRONG_MAGIC: 2,
  MALFORMED: 3,
  LONG_REVERT: 4,
  CALLBACK: 5,
  CONFIG_REVERT: 6,
  LONG_MAGIC: 7,
  CONFIG_PROBE: 8,
} as const

export const SEL = {
  ping: '0x12345678',
  pong: '0x87654321',
  fail: '0xbaadf00d',
  empty: '0x00000000',
  configure: id('configure((bool,(address,address,bytes4,uint8),uint8,address,uint8,bytes)[])').slice(0, 10),
}

export type Scope = { actor: string; to: string; selector: string; callMatch: number }
export type Change = {
  detach: boolean
  scope: Scope
  kind: number
  policy: string
  opMask: number
  settings: string
}

/** A normalized scope: the parts `callMatch` leaves open are zero. */
export function scope(
  actor: string,
  callMatch: number = CallMatch.ANY,
  to = ZeroAddress,
  selector = SEL.empty,
): Scope {
  return {
    actor,
    to: callMatch === CallMatch.ANY ? ZeroAddress : to,
    selector: callMatch === CallMatch.FUNCTION ? selector : SEL.empty,
    callMatch,
  }
}

/** The 6 scopes a call `(actor, to, selector)` is looked up at, in level order. */
export const lattice = (actor: string, to: string, selector: string): Scope[] => [
  scope(ANY),
  scope(ANY, CallMatch.CONTRACT, to),
  scope(ANY, CallMatch.FUNCTION, to, selector),
  scope(actor),
  scope(actor, CallMatch.CONTRACT, to),
  scope(actor, CallMatch.FUNCTION, to, selector),
]

export const scopeKey = (s: Scope) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]))
export const attachmentId = (s: Scope, kind: number, policy = ZeroAddress) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [scopeKey(s), kind, policy]))
export const levelOf = (s: Scope) => (s.actor === ANY ? 0 : 3) + s.callMatch

export const settings = (behaviour: number = Behaviour.PASS, callback = '0x') =>
  coder.encode(['uint8', 'bytes'], [behaviour, callback])
export const allow = (s: Scope, opMask = 0): Change => ({
  detach: false,
  scope: s,
  kind: Kind.ALLOW,
  policy: ZeroAddress,
  opMask,
  settings: '0x',
})
export const deny = (s: Scope, opMask = 0): Change => ({ ...allow(s, opMask), kind: Kind.DENY })
export const policy = (
  s: Scope,
  p: string,
  behaviour: number = Behaviour.PASS,
  opMask = 0,
  callback = '0x',
): Change => ({
  detach: false,
  scope: s,
  kind: Kind.POLICY,
  policy: p,
  opMask,
  settings: settings(behaviour, callback),
})
export const detach = (s: Scope, kind: number, p = ZeroAddress): Change => ({
  detach: true,
  scope: s,
  kind,
  policy: p,
  opMask: 0,
  settings: '0x',
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

/** The engine (`PolicyGuardConfig`, then `PolicyGuard` pointing at it), typed as `IPolicyGuard`. */
export async function deployEngine(batches?: string[]) {
  const multiSend = (await ethers.deployContract('EngineMultiSend')) as unknown as EngineMultiSend
  const config = await ethers.deployContract('PolicyGuardConfig')
  const guard = (await ethers.deployContract('PolicyGuard', [
    batches ?? [await multiSend.getAddress()],
    await config.getAddress(),
  ])) as unknown as PolicyGuard
  const engine = (await ethers.getContractAt(
    'IPolicyGuard',
    await guard.getAddress(),
  )) as unknown as IPolicyGuard
  return { engine, guard, config, multiSend }
}

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
  gas: { safeTxGas?: bigint; baseGas?: bigint; gasPrice?: bigint; refundReceiver?: string } = {},
): Promise<ContractTransactionResponse> {
  return safe.execTransaction(
    to,
    value,
    data,
    op,
    gas.safeTxGas ?? 0n,
    gas.baseGas ?? 0n,
    gas.gasPrice ?? 0n,
    ZeroAddress,
    gas.refundReceiver ?? ZeroAddress,
    '0x',
    { gasLimit: 15_000_000 },
  )
}

export async function execModule(
  safe: MockSafeV2,
  module: Signer,
  to: string,
  data: string = '0x',
  op: number = Op.CALL,
  value = 0n,
): Promise<ContractTransactionResponse> {
  return safe.connect(module).execTransactionFromModule(to, value, data, op, { gasLimit: 15_000_000 })
}

/**
 * The standard fixture: the engine, a MockSafeV2 configured with `changes` (unguarded, as the
 * install batch does), then the engine installed as guard and module guard, `module` enabled,
 * two targets and two mock policies.
 */
export async function setup(
  changesOrFn: Change[] | ((ctx: Fixture) => Change[]) = [],
): Promise<Fixture & { engine: IPolicyGuard }> {
  const [deployer, module, other] = await ethers.getSigners()
  const { engine, guard, config, multiSend } = await deployEngine()
  const engineAddr = await engine.getAddress()
  const { safe, address: safeAddr, asSafe } = await deploySafe()
  const target = (await ethers.deployContract('EngineTarget')) as unknown as EngineTarget
  const target2 = (await ethers.deployContract('EngineTarget')) as unknown as EngineTarget
  const policyA = (await ethers.deployContract('EngineMockPolicy')) as unknown as EngineMockPolicy
  const policyB = (await ethers.deployContract('EngineMockPolicy')) as unknown as EngineMockPolicy
  const f: Fixture = {
    engine,
    engineAddr,
    guard,
    configAddr: await config.getAddress(),
    multiSend,
    multiSendAddr: await multiSend.getAddress(),
    safe,
    safeAddr,
    asSafe,
    target,
    targetAddr: await target.getAddress(),
    target2Addr: await target2.getAddress(),
    policyA,
    policyAAddr: await policyA.getAddress(),
    policyB,
    policyBAddr: await policyB.getAddress(),
    deployer,
    module,
    other,
  }
  const changes = typeof changesOrFn === 'function' ? changesOrFn(f) : changesOrFn
  for (let i = 0; i < changes.length; i += 24) {
    await engine.connect(asSafe).configure(changes.slice(i, i + 24), { gasLimit: 16_000_000 })
  }
  await execOwner(safe, safeAddr, safe.interface.encodeFunctionData('enableModule', [module.address]))
  await execOwner(safe, safeAddr, safe.interface.encodeFunctionData('setModuleGuard', [engineAddr]))
  await execOwner(safe, safeAddr, safe.interface.encodeFunctionData('setGuard', [engineAddr]))
  return f
}

export type Fixture = {
  engine: IPolicyGuard
  engineAddr: string
  guard: PolicyGuard
  configAddr: string
  multiSend: EngineMultiSend
  multiSendAddr: string
  safe: MockSafeV2
  safeAddr: string
  asSafe: Signer
  target: EngineTarget
  targetAddr: string
  target2Addr: string
  policyA: EngineMockPolicy
  policyAAddr: string
  policyB: EngineMockPolicy
  policyBAddr: string
  deployer: Signer & { address: string }
  module: Signer & { address: string }
  other: Signer & { address: string }
}

/** `engine.configure(changes)` as an owner transaction of the guarded Safe. */
export function execConfigure(f: Fixture, changes: Change[], op: number = Op.CALL, value = 0n) {
  return execOwner(
    f.safe,
    f.engineAddr,
    f.engine.interface.encodeFunctionData('configure', [changes]),
    op,
    value,
  )
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

/** Records an error asserted by other means (e.g. inside `matches`' `engineError`). */
export const cover = (name: string) => coveredErrors.add(name)

/** The `Checked` events of the mock policies in `tx`, in log order, decoded. */
export async function checksIn(tx: ContractTransactionResponse, policies: EngineMockPolicy[]) {
  const receipt = await tx.wait()
  const byAddress = new Map<string, EngineMockPolicy>()
  for (const p of policies) byAddress.set((await p.getAddress()).toLowerCase(), p)
  const out: {
    policy: string
    ctx: { safe: string; actor: string; txHash: string }
    calls: { to: string; value: bigint; data: string; operation: number }[]
    matches: { callIndex: number; level: number; attachmentId: string }[]
  }[] = []
  for (const log of receipt!.logs) {
    const p = byAddress.get(log.address.toLowerCase())
    if (!p) continue
    const parsed = p.interface.parseLog(log)
    if (parsed?.name !== 'Checked') continue
    const [, ctx, calls, matches] = parsed.args
    out.push({
      policy: getAddress(log.address),
      ctx: { safe: ctx[0], actor: ctx[1], txHash: ctx[2] },
      calls: calls.map((c: unknown[]) => ({
        to: c[0] as string,
        value: c[1] as bigint,
        data: c[2] as string,
        operation: Number(c[3]),
      })),
      matches: matches.map((m: unknown[]) => ({
        callIndex: Number(m[0]),
        level: Number(m[1]),
        attachmentId: m[2] as string,
      })),
    })
  }
  return out
}
