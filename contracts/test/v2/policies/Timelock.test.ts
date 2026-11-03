import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import {
  AbiCoder,
  Interface,
  TypedDataEncoder,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  parseEther,
  toBeHex,
  zeroPadValue,
  type ContractTransactionResponse,
} from 'ethers'
import { ethers } from 'hardhat'
import type { TimelockMockSafe } from '../../../typechain-types'
import { eventsOf, expectEvent, expectRevert, revertData } from '../helpers'

/**
 * TimelockPolicy (SPEC.md §5.1) against TimelockEngineStub, which calls the policy as the rev 3
 * engine does (`configure`, one `check` per transaction, `matches`, `getAttachment`), and
 * TimelockMockSafe (EIP-712 transaction hash, nonce, `checkNSignatures`, guard hooks).
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CallMatch = { ANY: 0, CONTRACT: 1, FUNCTION: 2 } as const
const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
const Op = { CALL: 0, DELEGATECALL: 1 } as const
const OP_CALL = 1
const OP_DELEGATECALL = 2
const HOUR = 3600
const DAY = 24 * HOUR
const T = DAY // owners' timelock
const R = 3 * DAY // recovery's timelock
const F = 7 * DAY // MAX_FREEZE
const C = 12 * HOUR // COOLDOWN

type Scope = { actor: string; to: string; selector: string; callMatch: number }
type Settings = {
  delay: number
  window: number
  guardians: string[]
  lifters: string[]
  cancellers: string[]
}
type SafeCall = { to: string; value: bigint; data: string; operation: number }

const scope = (actor: string, to = ZeroAddress, selector = '0x00000000', callMatch?: number): Scope => ({
  actor,
  to,
  selector,
  callMatch:
    callMatch ??
    (to === ZeroAddress
      ? CallMatch.ANY
      : selector === '0x00000000'
        ? CallMatch.CONTRACT
        : CallMatch.FUNCTION),
})
const scopeKey = (s: Scope) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]))
const attachmentId = (s: Scope, kind: number, policy: string) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [scopeKey(s), kind, policy]))
const SETTINGS_TYPE = ['tuple(uint32,uint32,address[],address[],address[])']
const encode = (s: Settings) =>
  coder.encode(SETTINGS_TYPE, [[s.delay, s.window, s.guardians, s.lifters, s.cancellers]])
const tl = (delay: number, more: Partial<Settings> = {}): string =>
  encode({ delay, window: 0, guardians: [], lifters: [], cancellers: [], ...more })

const call = (to: string, data = '0x', value = 0n, operation: number = Op.CALL): SafeCall => ({
  to,
  value,
  data,
  operation,
})

const addr = (i: number) => getAddress(`0x${i.toString(16).padStart(40, '0')}`)

/** Safe-style packed signatures (eth_sign, v + 4), sorted by owner. */
async function sign(hash: string, signers: HardhatEthersSigner[]): Promise<string> {
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

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string' && v.startsWith('0x')) return v.toLowerCase()
  return v
}

/** XOR of the selectors of `iface`'s functions not in `exclude` (an ERC-165 interface id). */
function interfaceId(iface: Interface, exclude: Interface[] = []): string {
  const skip = new Set(
    exclude.flatMap((e) => e.fragments.filter((f) => f.type === 'function').map((f) => f.format())),
  )
  let id = 0n
  iface.forEachFunction((f) => {
    if (!skip.has(f.format())) id ^= BigInt(f.selector)
  })
  return toBeHex(id, 4)
}

async function deploy() {
  const signers = await ethers.getSigners()
  const [, o1, o2, o3, guardian, lifter, recovery, ops, canceller, n1, n2, outsider] = signers
  const stub = await ethers.deployContract('TimelockEngineStub')
  // Deployed on its own: a child create in the policy constructor would exceed the 2^24 gas cap.
  const queue = await ethers.deployContract('TimelockPolicyQueue')
  const freezer = await ethers.deployContract('TimelockPolicyFreeze', [F, C])
  const timelock = await ethers.deployContract('TimelockPolicy', [
    F,
    C,
    await queue.getAddress(),
    await freezer.getAddress(),
  ])
  const safe = await ethers.deployContract('TimelockMockSafe', [
    [o1.address, o2.address, o3.address],
    2,
    await stub.getAddress(),
    [recovery.address, ops.address],
  ])
  await signers[0].sendTransaction({ to: await safe.getAddress(), value: parseEther('10') })
  const target = getAddress('0x000000000000000000000000000000000000d1a1')
  return {
    o1,
    o2,
    o3,
    guardian,
    lifter,
    recovery,
    ops,
    canceller,
    n1,
    n2,
    outsider,
    stub,
    timelock,
    safe,
    target,
    engine: await stub.getAddress(),
    safeAddress: await safe.getAddress(),
    policy: await timelock.getAddress(),
  }
}

type Fx = Awaited<ReturnType<typeof deploy>>

const change = (s: Scope, kind: number, policy: string, settings = '0x', opMask = 0, detach = false) => ({
  detach,
  scope: s,
  kind,
  policy,
  opMask,
  settings,
})

/** Attaches the Timelock at `s` (stub setup, instant); returns the attachment id. */
async function attach(fx: Fx, s: Scope, settings: string, opMask = 0) {
  await fx.stub.configureFor(fx.safeAddress, [change(s, Kind.POLICY, fx.policy, settings, opMask)])
  return attachmentId(s, Kind.POLICY, fx.policy)
}

async function allow(fx: Fx, s: Scope) {
  await fx.stub.configureFor(fx.safeAddress, [change(s, Kind.ALLOW, ZeroAddress)])
  return attachmentId(s, Kind.ALLOW, ZeroAddress)
}

/** The engine's `configure` calldata, for owner-path configuration transactions. */
const configureData = (fx: Fx, changes: ReturnType<typeof change>[]) =>
  fx.stub.interface.encodeFunctionData('configure', [changes])

const safeTx = (c: SafeCall, nonce: bigint) => ({
  ...c,
  safeTxGas: 0,
  baseGas: 0,
  gasPrice: 0,
  gasToken: ZeroAddress,
  refundReceiver: ZeroAddress,
  nonce,
})

const safeTxHash = (safe: TimelockMockSafe, c: SafeCall, nonce: bigint) =>
  safe.getTransactionHash(c.to, c.value, c.data, c.operation, 0, 0, 0, ZeroAddress, ZeroAddress, nonce)

/** Owners schedule `c` at `nonce` (default: the Safe's next nonce), signed by `signers`. */
async function scheduleOwner(fx: Fx, c: SafeCall, signers: HardhatEthersSigner[], nonce?: bigint) {
  const n = nonce ?? (await fx.safe.nonce())
  const hash = await safeTxHash(fx.safe, c, n)
  const tx = await fx.timelock.schedule(fx.engine, fx.safeAddress, safeTx(c, n), await sign(hash, signers))
  return { hash, tx }
}

/** Owners execute `c` at the Safe's current nonce. */
async function execOwner(fx: Fx, c: SafeCall, signers: HardhatEthersSigner[]) {
  const hash = await safeTxHash(fx.safe, c, await fx.safe.nonce())
  return fx.safe.execTransaction(c.to, c.value, c.data, c.operation, await sign(hash, signers))
}

async function scheduleModule(fx: Fx, module: HardhatEthersSigner, c: SafeCall) {
  const timelock = fx.timelock.connect(module)
  const hash = await timelock.scheduleModuleTx.staticCall(
    fx.engine,
    fx.safeAddress,
    c.to,
    c.value,
    c.data,
    c.operation,
  )
  const tx = await timelock.scheduleModuleTx(fx.engine, fx.safeAddress, c.to, c.value, c.data, c.operation)
  return { hash, tx }
}

const execModule = (fx: Fx, module: HardhatEthersSigner, c: SafeCall) =>
  fx.safe.connect(module).execTransactionFromModule(c.to, c.value, c.data, c.operation)

const moduleCallHash = (fx: Fx, module: string, c: SafeCall) =>
  keccak256(
    coder.encode(
      ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
      [fx.safeAddress, module, c.to, c.value, c.data, c.operation],
    ),
  )

const scheduleOf = (fx: Fx, hash: string) => fx.timelock.getSchedule(fx.engine, fx.safeAddress, hash)

async function timestampOf(tx: ContractTransactionResponse): Promise<number> {
  const receipt = await tx.wait()
  return (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp
}

/** Sets the next block's timestamp to `at`. */
const at = (ts: number) => time.setNextBlockTimestamp(ts)

/**
 * Asserts the action reverted with the stub's `outer` error (PolicyDenied / PolicyConfigurationFailed)
 * naming the Timelock, whose `reason` decodes to `errorName` (with `args`, if given).
 */
async function expectPolicyError(
  action: Promise<unknown>,
  fx: Fx,
  errorName: string,
  args?: unknown[],
  outer = 'PolicyDenied',
): Promise<void> {
  let data: string | undefined
  try {
    await action
  } catch (e) {
    data = revertData(e)
    if (data === undefined) throw e
  }
  if (data === undefined) expect.fail(`expected ${outer}(${errorName}), but the call succeeded`)
  const parsed = fx.stub.interface.parseError(data)
  expect(parsed?.name, `revert data ${data}`).to.equal(outer)
  expect(parsed!.args.policy).to.equal(fx.policy)
  const inner = fx.timelock.interface.parseError(parsed!.args.reason)
  expect(inner?.name, `reason ${parsed!.args.reason}`).to.equal(errorName)
  if (args) expect(normalize([...inner!.args])).to.deep.equal(normalize(args))
}

const expectConfigError = (action: Promise<unknown>, fx: Fx, errorName: string, args: unknown[] = []) =>
  expectPolicyError(action, fx, errorName, args, 'PolicyConfigurationFailed')

/** The standard org: owners' Timelock T (guardian G, recovery as lifter), recovery R, recovery's swapOwner Allow. */
async function org(fx: Fx) {
  const owners = await attach(
    fx,
    scope(OWNERS),
    tl(T, { guardians: [fx.guardian.address], lifters: [fx.recovery.address] }),
  )
  const recovery = await attach(fx, scope(fx.recovery.address), tl(R, { window: 7 * DAY }))
  const swapOwner = fx.safe.interface.getFunction('swapOwner').selector
  const recoveryAllow = await allow(fx, scope(fx.recovery.address, fx.safeAddress, swapOwner))
  return { owners, recovery, recoveryAllow, swapOwner }
}

const swapOwnerCall = (fx: Fx, oldOwner: string, newOwner: string) =>
  call(fx.safeAddress, fx.safe.interface.encodeFunctionData('swapOwner', [ZeroAddress, oldOwner, newOwner]))

describe('TimelockPolicy (rev 4)', () => {
  describe('settings and configuration', () => {
    it('stores the settings and configuredAt per (engine, safe, attachment), and encodes like abi.encode', async () => {
      const fx = await loadFixture(deploy)
      const settings = {
        delay: T,
        window: HOUR,
        guardians: [fx.guardian.address],
        lifters: [fx.lifter.address],
        cancellers: [fx.canceller.address],
      }
      const id = await attach(fx, scope(OWNERS), encode(settings))
      const stored = await fx.timelock.getSettings(fx.engine, fx.safeAddress, id)
      expect(
        normalize([
          stored.delay,
          stored.window,
          [...stored.guardians],
          [...stored.lifters],
          [...stored.cancellers],
        ]),
      ).to.deep.equal(normalize([T, HOUR, settings.guardians, settings.lifters, settings.cancellers]))
      expect(await fx.timelock.configuredAt(fx.engine, fx.safeAddress, id)).to.equal(
        BigInt(await time.latest()),
      )
      expect(await fx.timelock.encodeSettings(settings)).to.equal(encode(settings))
      // Namespaced by the engine (msg.sender of configure).
      expect((await fx.timelock.getSettings(fx.outsider.address, fx.safeAddress, id)).delay).to.equal(0n)
      expect(await fx.timelock.configuredAt(fx.outsider.address, fx.safeAddress, id)).to.equal(0n)
      expect(await fx.timelock.MAX_FREEZE()).to.equal(BigInt(F))
      expect(await fx.timelock.COOLDOWN()).to.equal(BigInt(C))
    })

    it('reports IPolicy, IERC165 and ITimelockPolicy through ERC-165', async () => {
      const { timelock } = await loadFixture(deploy)
      const ierc165 = new Interface(['function supportsInterface(bytes4) view returns (bool)'])
      const ipolicy = (await ethers.getContractAt('contracts/v2/interfaces/IPolicy.sol:IPolicy', ZeroAddress))
        .interface
      const itimelock = (await ethers.getContractAt('ITimelockPolicy', ZeroAddress)).interface
      expect(await timelock.supportsInterface(interfaceId(ierc165))).to.equal(true)
      expect(await timelock.supportsInterface(interfaceId(ipolicy, [ierc165]))).to.equal(true)
      expect(await timelock.supportsInterface(interfaceId(itimelock, [ipolicy]))).to.equal(true)
      expect(await timelock.supportsInterface('0xffffffff')).to.equal(false)
    })

    it('rejects zero, duplicate and Safe members, lists over 8, and guardians or lifters at actor ANY (InvalidSettings)', async () => {
      const fx = await loadFixture(deploy)
      const nine = Array.from({ length: 9 }, (_, i) => addr(i + 100))
      const g = fx.guardian.address
      const bad: [Scope, string][] = []
      for (const role of ['guardians', 'lifters', 'cancellers'] as const) {
        bad.push([scope(fx.ops.address), tl(0, { [role]: [ZeroAddress] })])
        bad.push([scope(fx.ops.address), tl(0, { [role]: [g, g] })])
        bad.push([scope(fx.ops.address), tl(0, { [role]: [g, fx.safeAddress] })])
        bad.push([scope(fx.ops.address), tl(0, { [role]: nine })])
      }
      bad.push([scope(ANY, fx.target), tl(0, { guardians: [g] })])
      bad.push([scope(ANY, fx.target), tl(0, { lifters: [g] })])
      for (const [s, data] of bad) {
        await expectConfigError(
          fx.stub.configureFor(fx.safeAddress, [change(s, Kind.POLICY, fx.policy, data)]),
          fx,
          'InvalidSettings',
        )
      }
      // Exactly 8 per list is fine; cancellers at ANY are fine.
      const eight = nine.slice(0, 8)
      await attach(fx, scope(fx.ops.address), tl(0, { guardians: eight, lifters: eight, cancellers: eight }))
      await attach(fx, scope(ANY, fx.target), tl(0, { cancellers: [g] }))
    })

    it('rejects undecodable settings', async () => {
      const fx = await loadFixture(deploy)
      let data: string | undefined
      try {
        await fx.stub.configureFor(fx.safeAddress, [
          change(scope(fx.ops.address), Kind.POLICY, fx.policy, '0x1234'),
        ])
      } catch (e) {
        data = revertData(e)
      }
      expect(fx.stub.interface.parseError(data!)?.name).to.equal('PolicyConfigurationFailed')
    })

    describe('covering rule (TimelockNotCoveringConfiguration, checked by validate on the final configuration)', () => {
      const sel = (signature: string) => ethers.id(signature).slice(0, 10)
      const SAFE_ADMIN = [
        sel('setGuard(address)'),
        sel('setModuleGuard(address)'),
        sel('enableModule(address)'),
        sel('disableModule(address,address)'),
        sel('setFallbackHandler(address)'),
      ]
      const configureSel = (fx: Fx) => fx.stub.interface.getFunction('configure').selector
      const policyChange = (fx: Fx, s: Scope, settings: string, opMask = 0) =>
        change(s, Kind.POLICY, fx.policy, settings, opMask)
      const detachChange = (fx: Fx, s: Scope) => change(s, Kind.POLICY, fx.policy, '0x', 0, true)
      const configure = (fx: Fx, changes: ReturnType<typeof change>[]) =>
        fx.stub.configureFor(fx.safeAddress, changes)
      /** The three route covers of the "Admin delay" template, at delay `d`. */
      const adminDelay = (fx: Fx, d: number) => [
        policyChange(fx, scope(OWNERS, fx.safeAddress), tl(d)),
        policyChange(fx, scope(OWNERS, fx.engine, configureSel(fx)), tl(d)),
        policyChange(fx, scope(OWNERS), tl(d), OP_DELEGATECALL),
      ]
      /** The seven routes as exact covers, in the order the rule checks them. */
      const exactRoutes = (fx: Fx, d: number) => [
        policyChange(fx, scope(OWNERS), tl(d), OP_DELEGATECALL),
        policyChange(fx, scope(OWNERS, fx.engine, configureSel(fx)), tl(d)),
        ...SAFE_ADMIN.map((f) => policyChange(fx, scope(OWNERS, fx.safeAddress, f), tl(d))),
      ]
      const routeArgs = (fx: Fx, i: number, d: number) =>
        i === 0
          ? [ZeroAddress, '0x00000000', OP_DELEGATECALL, d]
          : i === 1
            ? [fx.engine, configureSel(fx), OP_CALL, d]
            : [fx.safeAddress, SAFE_ADMIN[i - 2], OP_CALL, d]

      it('names each of the seven routes left uncovered, with its operation and D', async () => {
        const fx = await loadFixture(deploy)
        const narrow = policyChange(fx, scope(OWNERS, fx.target), tl(T))
        for (let i = 0; i < 7; i++) {
          const routes = exactRoutes(fx, T).filter((_, j) => j !== i)
          await expectConfigError(
            configure(fx, [narrow, ...routes]),
            fx,
            'TimelockNotCoveringConfiguration',
            routeArgs(fx, i, T),
          )
        }
        await configure(fx, [narrow, ...exactRoutes(fx, T)])
        // Nothing covered at all: the first route checked is any DELEGATECALL.
        const fx2 = await loadFixture(deploy)
        await expectConfigError(
          configure(fx2, [policyChange(fx2, scope(OWNERS, fx2.target), tl(T))]),
          fx2,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx2, 0, T),
        )
      })

      it('accepts (Owners, *), (ANY, *), (Owners, Safe.*) + (Owners, engine.*) + DELEGATECALL, and self-cover', async () => {
        for (const covers of [
          (fx: Fx) => [policyChange(fx, scope(OWNERS), tl(T))],
          (fx: Fx) => [policyChange(fx, scope(ANY), tl(T))],
          (fx: Fx) => adminDelay(fx, T),
          (fx: Fx) => [
            policyChange(fx, scope(ANY, fx.safeAddress), tl(T)),
            policyChange(fx, scope(OWNERS, fx.engine), tl(T)),
            policyChange(fx, scope(ANY), tl(T), OP_DELEGATECALL),
          ],
        ]) {
          const fx = await loadFixture(deploy)
          await configure(fx, [
            policyChange(fx, scope(OWNERS, fx.target, '0xabcdef01'), tl(T)),
            ...covers(fx),
          ])
        }
        // An actor-wide delay covers itself: CALL and DELEGATECALL in one attachment.
        const fx = await loadFixture(deploy)
        await attach(fx, scope(OWNERS), tl(T))
      })

      it('a DELEGATECALL-only cover does not cover the CALL routes, nor a CALL-only one any DELEGATECALL', async () => {
        const fx = await loadFixture(deploy)
        await expectConfigError(
          configure(fx, [policyChange(fx, scope(OWNERS), tl(T), OP_DELEGATECALL)]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 1, T),
        )
        await expectConfigError(
          configure(fx, [policyChange(fx, scope(OWNERS), tl(T), OP_CALL)]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        // A route-level DELEGATECALL cover (Safe.*) does not count for E7: only (*, *) does.
        await expectConfigError(
          configure(fx, [
            policyChange(fx, scope(OWNERS, fx.safeAddress), tl(T), OP_CALL | OP_DELEGATECALL),
            policyChange(fx, scope(OWNERS, fx.engine), tl(T)),
          ]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
      })

      it('needs every route delayed at least D, the longest owner-path delay (a shorter cover fails)', async () => {
        const fx = await loadFixture(deploy)
        await expectConfigError(
          configure(fx, [policyChange(fx, scope(OWNERS, fx.target), tl(T)), ...adminDelay(fx, T - 1)]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        // A route cover longer than the rest raises D for every other route.
        await expectConfigError(
          configure(fx, [...adminDelay(fx, T), policyChange(fx, scope(OWNERS, fx.engine), tl(2 * T))]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, 2 * T),
        )
      })

      it('counts a delay at actor ANY toward D; covers at Owners or ANY both satisfy it', async () => {
        const fx = await loadFixture(deploy)
        await expectConfigError(
          configure(fx, [policyChange(fx, scope(ANY, fx.target), tl(T))]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        await configure(fx, [policyChange(fx, scope(ANY, fx.target), tl(T)), ...adminDelay(fx, T)])
      })

      it('ignores a cover of another Timelock deployment, kill switches, and module actors', async () => {
        const fx = await loadFixture(deploy)
        const queue = await ethers.deployContract('TimelockPolicyQueue')
        const freezer = await ethers.deployContract('TimelockPolicyFreeze', [F, C])
        const other = await ethers.deployContract('TimelockPolicy', [
          F,
          C,
          await queue.getAddress(),
          await freezer.getAddress(),
        ])
        await configure(fx, [change(scope(OWNERS), Kind.POLICY, await other.getAddress(), tl(T))])
        await expectConfigError(
          configure(fx, [policyChange(fx, scope(OWNERS, fx.target), tl(T))]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        // D = 0: a kill switch needs no cover; a module actor's delay is not on the owner path.
        await attach(fx, scope(OWNERS, fx.target), tl(0))
        await attach(fx, scope(fx.ops.address), tl(R))
      })

      it('judges the final configuration: order is free, lowering or detaching a cover alone is refused', async () => {
        const fx = await loadFixture(deploy)
        const narrowScope = scope(OWNERS, fx.target)
        // Review A3a: cover, narrow, detach the cover, in one batch.
        await expectConfigError(
          configure(fx, [
            policyChange(fx, scope(OWNERS), tl(T)),
            policyChange(fx, narrowScope, tl(T)),
            detachChange(fx, scope(OWNERS)),
          ]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        // The narrow delay first, its cover second: fine.
        await configure(fx, [policyChange(fx, narrowScope, tl(T)), policyChange(fx, scope(OWNERS), tl(T))])
        // Review A3b: lowering the cover by an update, or detaching it, is refused.
        await expectConfigError(
          configure(fx, [policyChange(fx, scope(OWNERS), tl(HOUR))]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        await expectConfigError(
          configure(fx, [detachChange(fx, scope(OWNERS))]),
          fx,
          'TimelockNotCoveringConfiguration',
          routeArgs(fx, 0, T),
        )
        // Lowering both together, or detaching both, passes.
        await configure(fx, [
          policyChange(fx, scope(OWNERS), tl(HOUR)),
          policyChange(fx, narrowScope, tl(HOUR)),
        ])
        await configure(fx, [detachChange(fx, narrowScope), detachChange(fx, scope(OWNERS))])
      })
    })
  })

  describe('module path', () => {
    it('schedules, denies too early, executes once matured, and never twice', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(fx.ops.address), tl(T))
      await allow(fx, scope(fx.ops.address))
      const c = call(fx.target, '0xabcdef01', 5n)
      const { hash, tx } = await scheduleModule(fx, fx.ops, c)
      expect(hash).to.equal(moduleCallHash(fx, fx.ops.address, c))
      const scheduledAt = await timestampOf(tx)
      await expectEvent(tx, fx.timelock, 'Scheduled', [
        fx.engine,
        fx.safeAddress,
        hash,
        fx.ops.address,
        c.to,
        c.value,
        c.data,
        c.operation,
        0,
        scheduledAt + T,
        false,
      ])
      const s = await scheduleOf(fx, hash)
      expect(normalize([s.actor, s.scheduledAt, s.isConfiguration, [...s.attachmentIds]])).to.deep.equal(
        normalize([fx.ops.address, scheduledAt, false, [id]]),
      )
      await at(scheduledAt + T - 1)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'NotReady', [hash, scheduledAt + T])
      await at(scheduledAt + T)
      const exec = await execModule(fx, fx.ops, c)
      await expectEvent(exec, fx.timelock, 'Executed', [fx.engine, fx.safeAddress, hash])
      expect((await scheduleOf(fx, hash)).scheduledAt).to.equal(0n)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'NotScheduled', [hash])
    })

    it('reverts NoTimelock when no Timelock attachment matches the call for that actor', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T))
      await attach(fx, scope(fx.ops.address, fx.target), tl(T), OP_DELEGATECALL)
      const hash = moduleCallHash(fx, fx.ops.address, call(fx.target))
      // (Owners, *) is another actor; (Ops, target.*) is DELEGATECALL only.
      await expectRevert(scheduleModule(fx, fx.ops, call(fx.target)), fx.timelock, 'NoTimelock', [hash])
    })

    it('reverts NotScheduled for a schedule made by another actor', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(fx.ops.address), tl(T))
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      await time.increase(T)
      const ctx = { safe: fx.safeAddress, actor: fx.recovery.address, txHash: hash }
      await expectRevert(
        fx.stub.callCheck(fx.policy, ctx, [call(fx.target)], [{ callIndex: 0, level: 3, attachmentId: id }]),
        fx.timelock,
        'NotScheduled',
        [hash],
      )
    })

    it('rejects a live schedule (AlreadyScheduled) and replaces an expired one', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(T, { window: HOUR }))
      await allow(fx, scope(fx.ops.address))
      const c = call(fx.target)
      const { hash, tx } = await scheduleModule(fx, fx.ops, c)
      const first = await timestampOf(tx)
      await expectRevert(scheduleModule(fx, fx.ops, c), fx.timelock, 'AlreadyScheduled', [hash])
      await at(first + T + HOUR)
      await expectRevert(scheduleModule(fx, fx.ops, c), fx.timelock, 'AlreadyScheduled', [hash])
      await at(first + T + HOUR + 1)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'ScheduleExpired', [hash, first + T + HOUR])
      const again = await scheduleModule(fx, fx.ops, c)
      const second = await timestampOf(again.tx)
      expect((await scheduleOf(fx, hash)).scheduledAt).to.equal(BigInt(second))
      await at(second + T)
      await execModule(fx, fx.ops, c)
    })

    it('lets the module cancel its own schedule, and no other module', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(T))
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      await expectRevert(
        fx.timelock.connect(fx.recovery).cancel(fx.engine, fx.safeAddress, hash),
        fx.timelock,
        'NotCanceller',
        [fx.recovery.address],
      )
      const tx = await fx.timelock.connect(fx.ops).cancel(fx.engine, fx.safeAddress, hash)
      await expectEvent(tx, fx.timelock, 'Cancelled', [fx.engine, fx.safeAddress, hash, fx.ops.address])
      expect((await scheduleOf(fx, hash)).scheduledAt).to.equal(0n)
      await expectRevert(
        fx.timelock.connect(fx.ops).cancel(fx.engine, fx.safeAddress, hash),
        fx.timelock,
        'NotScheduled',
        [hash],
      )
      // A module hash has no nonce and is not retired: the module may schedule its call again.
      expect(await fx.timelock.isCancelled(fx.engine, fx.safeAddress, hash)).to.equal(false)
      expect((await scheduleModule(fx, fx.ops, call(fx.target))).hash).to.equal(hash)
    })

    it('flags a top-level CALL to engine.configure as a configuration schedule, and nothing else', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(T))
      const data = configureData(fx, [])
      const config = await scheduleModule(fx, fx.ops, call(fx.engine, data))
      expect((await scheduleOf(fx, config.hash)).isConfiguration).to.equal(true)
      const delegate = await scheduleModule(fx, fx.ops, call(fx.engine, data, 0n, Op.DELEGATECALL))
      expect((await scheduleOf(fx, delegate.hash)).isConfiguration).to.equal(false)
      const elsewhere = await scheduleModule(fx, fx.ops, call(fx.target, data))
      expect((await scheduleOf(fx, elsewhere.hash)).isConfiguration).to.equal(false)
      const short = await scheduleModule(fx, fx.ops, call(fx.engine, '0x1234'))
      expect((await scheduleOf(fx, short.hash)).isConfiguration).to.equal(false)
    })
  })

  describe('owner path', () => {
    it('schedules a future nonce with the owners signatures; it runs only at that nonce, once', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T))
      const c = call(fx.target, '0x', parseEther('1'))
      const nonce = (await fx.safe.nonce()) + 1n
      const { hash, tx } = await scheduleOwner(fx, c, [fx.o1, fx.o2], nonce)
      const scheduledAt = await timestampOf(tx)
      await expectEvent(tx, fx.timelock, 'Scheduled', [
        fx.engine,
        fx.safeAddress,
        hash,
        OWNERS,
        c.to,
        c.value,
        c.data,
        c.operation,
        nonce,
        scheduledAt + T,
        false,
      ])
      await time.increase(T)
      // At nonce 0 the hash differs: not scheduled.
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx, 'NotScheduled', [
        await safeTxHash(fx.safe, c, nonce - 1n),
      ])
      const filler = call(fx.target, '0x01')
      await scheduleOwner(fx, filler, [fx.o1, fx.o2])
      await time.increase(T)
      await execOwner(fx, filler, [fx.o1, fx.o2])
      await execOwner(fx, c, [fx.o1, fx.o2])
      expect(await ethers.provider.getBalance(fx.target)).to.equal(parseEther('1'))
    })

    it('rejects non-zero gas fields, a stale nonce and bad signatures', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T))
      const c = call(fx.target)
      const sigs = await sign(await safeTxHash(fx.safe, c, 0n), [fx.o1, fx.o2])
      for (const gas of [{ safeTxGas: 1 }, { gasPrice: 1 }]) {
        await expectRevert(
          fx.timelock.schedule(fx.engine, fx.safeAddress, { ...safeTx(c, 0n), ...gas }, sigs),
          fx.timelock,
          'GasFieldsNotZero',
        )
      }
      // Use nonce 0 with no Timelock attached, then re-attach it.
      await fx.stub.configureFor(fx.safeAddress, [
        change(scope(OWNERS), Kind.POLICY, fx.policy, '0x', 0, true),
      ])
      await execOwner(fx, call(fx.target, '0x02'), [fx.o1, fx.o2])
      await attach(fx, scope(OWNERS), tl(T))
      await expectRevert(
        fx.timelock.schedule(fx.engine, fx.safeAddress, safeTx(c, 0n), sigs),
        fx.timelock,
        'StaleNonce',
        [0, 1],
      )
      const oneSig = await sign(await safeTxHash(fx.safe, c, 1n), [fx.o1])
      await expectRevert(
        fx.timelock.schedule(fx.engine, fx.safeAddress, safeTx(c, 1n), oneSig),
        fx.safe,
        'InvalidSignatures',
      )
      const outsiderSigs = await sign(await safeTxHash(fx.safe, c, 1n), [fx.o1, fx.outsider])
      await expectRevert(
        fx.timelock.schedule(fx.engine, fx.safeAddress, safeTx(c, 1n), outsiderSigs),
        fx.safe,
        'InvalidSignatures',
      )
    })

    it('accepts the relaying owner as one signer (v = 1, checkNSignatures executor = msg.sender)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T))
      const c = call(fx.target)
      const hash = await safeTxHash(fx.safe, c, 0n)
      const approved = concat([zeroPadValue(fx.o1.address, 32), zeroPadValue('0x', 32), '0x01'])
      const ecdsa = await sign(hash, [fx.o2])
      const sigs =
        BigInt(fx.o1.address) < BigInt(fx.o2.address) ? concat([approved, ecdsa]) : concat([ecdsa, approved])
      await expectRevert(
        fx.timelock.connect(fx.o3).schedule(fx.engine, fx.safeAddress, safeTx(c, 0n), sigs),
        fx.safe,
        'InvalidSignatures',
      )
      await fx.timelock.connect(fx.o1).schedule(fx.engine, fx.safeAddress, safeTx(c, 0n), sigs)
      expect((await scheduleOf(fx, hash)).actor).to.equal(OWNERS)
    })

    it('reverts NoTimelock on the owner path when only other actors are timelocked', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(T))
      const c = call(fx.target)
      await expectRevert(scheduleOwner(fx, c, [fx.o1, fx.o2]), fx.timelock, 'NoTimelock', [
        await safeTxHash(fx.safe, c, 0n),
      ])
    })

    it('measures the check gas for one matched id', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T, { guardians: [fx.guardian.address] }))
      const c = call(fx.target)
      await scheduleOwner(fx, c, [fx.o1, fx.o2])
      await time.increase(T)
      const tx = await execOwner(fx, c, [fx.o1, fx.o2])
      const [log] = await eventsOf(tx, fx.stub, 'PolicyChecked')
      const gas = Number(log.args.gasUsed)
      console.log(
        `      TimelockPolicy.check, one matched id, schedule consumed: ${gas} gas (before refunds)`,
      )
      expect(gas).to.be.lessThan(30_000)
    })
  })

  describe('merge rules', () => {
    it('takes the longest delay, the shortest non-zero window, and runs from the latest configuration', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(T, { window: 2 * HOUR }))
      const narrow = await attach(fx, scope(fx.ops.address, fx.target), tl(2 * T, { window: HOUR }))
      await attach(fx, scope(ANY, fx.target), tl(0)) // delay 0, window 0: changes nothing
      await allow(fx, scope(fx.ops.address))
      const c = call(fx.target)
      const { hash, tx } = await scheduleModule(fx, fx.ops, c)
      const scheduledAt = await timestampOf(tx)
      expect((await scheduleOf(fx, hash)).attachmentIds.length).to.equal(3)
      await at(scheduledAt + T)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'NotReady', [hash, scheduledAt + 2 * T])
      // Re-configuring restarts the wait for schedules made before.
      await at(scheduledAt + T + 10)
      await attach(fx, scope(fx.ops.address, fx.target), tl(2 * T, { window: HOUR }))
      const reconfigured = scheduledAt + T + 10
      expect(await fx.timelock.configuredAt(fx.engine, fx.safeAddress, narrow)).to.equal(BigInt(reconfigured))
      await at(scheduledAt + 2 * T)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'NotReady', [hash, reconfigured + 2 * T])
      await at(reconfigured + 2 * T + HOUR + 1)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'ScheduleExpired', [
        hash,
        reconfigured + 2 * T + HOUR,
      ])
    })

    it('ignores the window of a kill switch (delay 0): it never expires the schedule of a delayed one (rev 3 review fable P3)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(0, { window: 60, guardians: [fx.guardian.address] }))
      await attach(fx, scope(fx.ops.address, fx.target), tl(HOUR))
      await allow(fx, scope(fx.ops.address))
      const c = call(fx.target)
      const { hash, tx } = await scheduleModule(fx, fx.ops, c)
      await at((await timestampOf(tx)) + HOUR + 61)
      const exec = await execModule(fx, fx.ops, c)
      await expectEvent(exec, fx.timelock, 'Executed', [fx.engine, fx.safeAddress, hash])
    })

    it('passes a delay-0 attachment without a schedule (kill switch only)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), tl(0, { guardians: [fx.guardian.address] }))
      await allow(fx, scope(fx.ops.address))
      const c = call(fx.target)
      const tx = await execModule(fx, fx.ops, c)
      expect((await eventsOf(tx, fx.timelock, 'Executed')).length).to.equal(0)
    })

    it('handles every match of a batch, duplicates included, and consumes once', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(fx.ops.address), tl(T))
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      await time.increase(T)
      const ctx = { safe: fx.safeAddress, actor: fx.ops.address, txHash: hash }
      const calls = [call(fx.target), call(fx.target, '0x01')]
      const matches = [
        { callIndex: 0, level: 3, attachmentId: id },
        { callIndex: 1, level: 3, attachmentId: id },
      ]
      expect(await fx.stub.callCheck.staticCall(fx.policy, ctx, calls, matches)).to.equal(
        fx.timelock.interface.getFunction('check').selector,
      )
      await fx.stub.callCheck(fx.policy, ctx, calls, matches)
      await expectRevert(fx.stub.callCheck(fx.policy, ctx, calls, matches), fx.timelock, 'NotScheduled', [
        hash,
      ])
      await expectRevert(fx.stub.callCheck(fx.policy, ctx, calls, []), fx.timelock, 'NoMatches')
    })
  })

  describe('freeze and lift', () => {
    it('freezes for MAX_FREEZE, denies even at delay 0, skips while frozen or cooling, and can freeze again after', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(fx.ops.address), tl(0, { guardians: [fx.guardian.address] }))
      await allow(fx, scope(fx.ops.address))
      const c = call(fx.target)
      const tx = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      const t0 = await timestampOf(tx)
      await expectEvent(tx, fx.timelock, 'Frozen', [
        fx.engine,
        fx.safeAddress,
        id,
        fx.guardian.address,
        t0 + F,
      ])
      expect(normalize([...(await fx.timelock.freezeState(fx.engine, fx.safeAddress, id))])).to.deep.equal(
        normalize([t0 + F, t0 + F + C]),
      )
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'AttachmentFrozen', [id, t0 + F])
      // No extension while frozen.
      const skip = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await expectEvent(skip, fx.timelock, 'FreezeSkipped', [
        fx.engine,
        fx.safeAddress,
        id,
        fx.guardian.address,
        t0 + F,
      ])
      await at(t0 + F - 1)
      await expectPolicyError(execModule(fx, fx.ops, c), fx, 'AttachmentFrozen', [id, t0 + F])
      // The freeze ends on its own after F; no new freeze during the cooldown.
      await at(t0 + F)
      await execModule(fx, fx.ops, c)
      const cooling = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await expectEvent(cooling, fx.timelock, 'FreezeSkipped', [
        fx.engine,
        fx.safeAddress,
        id,
        fx.guardian.address,
        t0 + F + C,
      ])
      await at(t0 + F + C)
      const again = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await expectEvent(again, fx.timelock, 'Frozen', [
        fx.engine,
        fx.safeAddress,
        id,
        fx.guardian.address,
        t0 + 2 * F + C,
      ])
    })

    it('freezes several ids in one call, skipping the frozen ones', async () => {
      const fx = await loadFixture(deploy)
      const g = { guardians: [fx.guardian.address] }
      const a = await attach(fx, scope(fx.ops.address), tl(0, g))
      const b = await attach(fx, scope(fx.recovery.address, fx.target), tl(0, g))
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [a])
      const tx = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [a, b])
      expect(
        (await eventsOf(tx, fx.timelock, 'FreezeSkipped')).map((l) => l.args.attachmentId),
      ).to.deep.equal([a])
      expect((await eventsOf(tx, fx.timelock, 'Frozen')).map((l) => l.args.attachmentId)).to.deep.equal([b])
    })

    it('reverts NotGuardian for a non-guardian, a lifter, any id not guarded, and a detached attachment', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(
        fx,
        scope(fx.ops.address),
        tl(0, { guardians: [fx.guardian.address], lifters: [fx.lifter.address] }),
      )
      const other = await attach(fx, scope(fx.recovery.address), tl(0))
      for (const who of [fx.outsider, fx.lifter]) {
        await expectRevert(
          fx.timelock.connect(who).freeze(fx.engine, fx.safeAddress, [id]),
          fx.timelock,
          'NotGuardian',
          [id],
        )
      }
      await expectRevert(
        fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id, other]),
        fx.timelock,
        'NotGuardian',
        [other],
      )
      await fx.stub.configureFor(fx.safeAddress, [
        change(scope(fx.ops.address), Kind.POLICY, fx.policy, '0x', 0, true),
      ])
      await expectRevert(
        fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id]),
        fx.timelock,
        'NotGuardian',
        [id],
      )
    })

    it('lifts by a guardian or a lifter, starting the cooldown at once', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(
        fx,
        scope(fx.ops.address),
        tl(0, { guardians: [fx.guardian.address], lifters: [fx.lifter.address] }),
      )
      await expectRevert(
        fx.timelock.connect(fx.lifter).lift(fx.engine, fx.safeAddress, id),
        fx.timelock,
        'NotFrozen',
        [id],
      )
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await expectRevert(
        fx.timelock.connect(fx.outsider).lift(fx.engine, fx.safeAddress, id),
        fx.timelock,
        'NotGuardianOrLifter',
        [id],
      )
      const tx = await fx.timelock.connect(fx.lifter).lift(fx.engine, fx.safeAddress, id)
      const t = await timestampOf(tx)
      await expectEvent(tx, fx.timelock, 'Lifted', [fx.engine, fx.safeAddress, id, fx.lifter.address, t + C])
      expect(normalize([...(await fx.timelock.freezeState(fx.engine, fx.safeAddress, id))])).to.deep.equal(
        normalize([t, t + C]),
      )
      await expectRevert(
        fx.timelock.connect(fx.guardian).lift(fx.engine, fx.safeAddress, id),
        fx.timelock,
        'NotFrozen',
        [id],
      )
      // The guardian lifts too.
      await at(t + C)
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await fx.timelock.connect(fx.guardian).lift(fx.engine, fx.safeAddress, id)
    })

    it('bounds one actor per Safe: its second id joins the window whoever freezes it, then the actor cools down (review A4)', async () => {
      const fx = await loadFixture(deploy)
      const a = await attach(fx, scope(fx.ops.address), tl(0, { guardians: [fx.guardian.address] }))
      const b = await attach(fx, scope(fx.ops.address, fx.target), tl(0, { guardians: [fx.n1.address] }))
      const other = await attach(
        fx,
        scope(fx.recovery.address, fx.target),
        tl(0, { guardians: [fx.n1.address] }),
      )
      const window = async (actor = fx.ops.address) =>
        normalize([...(await fx.timelock.actorWindow(fx.engine, fx.safeAddress, actor))])
      expect(await window()).to.deep.equal(normalize([0, 0, 0]))
      const t0 = await timestampOf(
        await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [a]),
      )
      expect(await window()).to.deep.equal(normalize([t0 + F, t0 + F + C, 1]))
      // Just before A thaws, another guardian freezes B: it joins the actor's window, no fresh F.
      await at(t0 + F - 60)
      await expectEvent(
        await fx.timelock.connect(fx.n1).freeze(fx.engine, fx.safeAddress, [b]),
        fx.timelock,
        'Frozen',
        [fx.engine, fx.safeAddress, b, fx.n1.address, t0 + F],
      )
      expect(await window()).to.deep.equal(normalize([t0 + F, t0 + F + C, 2]))
      // At the window end both thaw, and nothing of the actor can be frozen for C, by anyone.
      await at(t0 + F)
      const cooling = await fx.timelock.connect(fx.n1).freeze(fx.engine, fx.safeAddress, [b, other])
      expect(
        (await eventsOf(cooling, fx.timelock, 'FreezeSkipped')).map((l) => Number(l.args.until)),
      ).to.deep.equal([t0 + F + C])
      // Another actor has its own window.
      await expectEvent(cooling, fx.timelock, 'Frozen', [
        fx.engine,
        fx.safeAddress,
        other,
        fx.n1.address,
        t0 + 2 * F,
      ])
      expect(await window(fx.recovery.address)).to.deep.equal(normalize([t0 + 2 * F, t0 + 2 * F + C, 1]))
      // After C, a new window.
      await at(t0 + F + C)
      await expectEvent(
        await fx.timelock.connect(fx.n1).freeze(fx.engine, fx.safeAddress, [b]),
        fx.timelock,
        'Frozen',
        [fx.engine, fx.safeAddress, b, fx.n1.address, t0 + 2 * F + C],
      )
    })

    it('a lift that leaves the actor nothing frozen closes its window; a lifted id cannot be re-frozen in it', async () => {
      const fx = await loadFixture(deploy)
      const roles = { guardians: [fx.guardian.address], lifters: [fx.lifter.address] }
      const a = await attach(fx, scope(fx.ops.address), tl(0, roles))
      const b = await attach(fx, scope(fx.recovery.address, fx.target), tl(0, roles))
      const c = await attach(fx, scope(fx.ops.address, fx.target), tl(0, roles))
      const d = await attach(fx, scope(fx.ops.address, fx.target, '0xabcdef01'), tl(0, roles))
      const freeze = (ids: string[]) =>
        fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, ids)
      const lift = (id: string) => fx.timelock.connect(fx.lifter).lift(fx.engine, fx.safeAddress, id)
      const window = async (actor = fx.ops.address) =>
        normalize([...(await fx.timelock.actorWindow(fx.engine, fx.safeAddress, actor))])
      const t0 = await timestampOf(await freeze([a, b, c]))
      const t1 = await timestampOf(await lift(a))
      expect(await window()).to.deep.equal(normalize([t0 + F, t0 + F + C, 1]))
      // The lifted id cools down on its own; another id of the actor still joins the open window.
      const tx = await freeze([a, d])
      expect(
        (await eventsOf(tx, fx.timelock, 'FreezeSkipped')).map((l) => Number(l.args.until)),
      ).to.deep.equal([t1 + C])
      await expectEvent(tx, fx.timelock, 'Frozen', [
        fx.engine,
        fx.safeAddress,
        d,
        fx.guardian.address,
        t0 + F,
      ])
      await lift(c)
      const t3 = await timestampOf(await lift(d))
      // Nothing of the actor frozen: its cooldown starts now, not at t0 + F.
      expect(await window()).to.deep.equal(normalize([t3, t3 + C, 0]))
      await expectEvent(await freeze([c]), fx.timelock, 'FreezeSkipped', [
        fx.engine,
        fx.safeAddress,
        c,
        fx.guardian.address,
        t3 + C,
      ])
      // The other actor's freeze is untouched.
      expect(await window(fx.recovery.address)).to.deep.equal(normalize([t0 + F, t0 + F + C, 1]))
      expect((await fx.timelock.freezeState(fx.engine, fx.safeAddress, b))[0]).to.equal(BigInt(t0 + F))
    })

    it('never extends a frozen id, whoever freezes it again; another actor opens its own window', async () => {
      const fx = await loadFixture(deploy)
      const a = await attach(
        fx,
        scope(fx.ops.address),
        tl(0, { guardians: [fx.guardian.address, fx.n1.address] }),
      )
      const b = await attach(fx, scope(fx.recovery.address, fx.target), tl(0, { guardians: [fx.n1.address] }))
      const t0 = await timestampOf(
        await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [a]),
      )
      await at(t0 + DAY)
      const tx = await fx.timelock.connect(fx.n1).freeze(fx.engine, fx.safeAddress, [a, b])
      await expectEvent(tx, fx.timelock, 'FreezeSkipped', [
        fx.engine,
        fx.safeAddress,
        a,
        fx.n1.address,
        t0 + F,
      ])
      await expectEvent(tx, fx.timelock, 'Frozen', [
        fx.engine,
        fx.safeAddress,
        b,
        fx.n1.address,
        t0 + DAY + F,
      ])
    })

    it('refuses a lift of a detached attachment (NotGuardianOrLifter): its stale roles count for nothing', async () => {
      const fx = await loadFixture(deploy)
      const roles = { guardians: [fx.guardian.address], lifters: [fx.lifter.address] }
      const id = await attach(fx, scope(fx.ops.address), tl(0, roles))
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await fx.stub.configureFor(fx.safeAddress, [
        change(scope(fx.ops.address), Kind.POLICY, fx.policy, '0x', 0, true),
      ])
      for (const who of [fx.guardian, fx.lifter])
        await expectRevert(
          fx.timelock.connect(who).lift(fx.engine, fx.safeAddress, id),
          fx.timelock,
          'NotGuardianOrLifter',
          [id],
        )
      // The actor's window is untouched.
      expect((await fx.timelock.actorWindow(fx.engine, fx.safeAddress, fx.ops.address))[2]).to.equal(1n)
    })

    it('keeps the freeze state across detach and re-attach of the same id (rev 3 review fable P5, by design)', async () => {
      const fx = await loadFixture(deploy)
      const s = scope(fx.ops.address)
      const settings = tl(0, { guardians: [fx.guardian.address], lifters: [fx.lifter.address] })
      const id = await attach(fx, s, settings)
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      const frozen = [...(await fx.timelock.freezeState(fx.engine, fx.safeAddress, id))]
      await fx.stub.configureFor(fx.safeAddress, [change(s, Kind.POLICY, fx.policy, '0x', 0, true)])
      await attach(fx, s, settings)
      // A re-attach never shortens a freeze...
      expect([...(await fx.timelock.freezeState(fx.engine, fx.safeAddress, id))]).to.deep.equal(frozen)
      const t = await timestampOf(await fx.timelock.connect(fx.lifter).lift(fx.engine, fx.safeAddress, id))
      await fx.stub.configureFor(fx.safeAddress, [change(s, Kind.POLICY, fx.policy, '0x', 0, true)])
      await attach(fx, s, settings)
      // ...nor a cooldown: the guardian's next freeze is still skipped until t + C.
      await expectEvent(
        await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id]),
        fx.timelock,
        'FreezeSkipped',
        [fx.engine, fx.safeAddress, id, fx.guardian.address, t + C],
      )
    })

    it('keeps the freeze state when the attachment is re-configured', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(fx.ops.address), tl(0, { guardians: [fx.guardian.address] }))
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      const before = [...(await fx.timelock.freezeState(fx.engine, fx.safeAddress, id))]
      await attach(fx, scope(fx.ops.address), tl(HOUR))
      expect([...(await fx.timelock.freezeState(fx.engine, fx.safeAddress, id))]).to.deep.equal(before)
      await allow(fx, scope(fx.ops.address))
      await expectPolicyError(execModule(fx, fx.ops, call(fx.target)), fx, 'AttachmentFrozen', [
        id,
        before[0],
      ])
    })
  })

  describe('void rule', () => {
    it('voids schedules made before a freeze of a matched id ended, and lets them be replaced', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(fx.ops.address), tl(T, { guardians: [fx.guardian.address] }))
      await allow(fx, scope(fx.ops.address))
      const before = call(fx.target, '0x01')
      const during = call(fx.target, '0x02')
      const { hash: hBefore } = await scheduleModule(fx, fx.ops, before)
      const tx = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      const t0 = await timestampOf(tx)
      const { hash: hDuring } = await scheduleModule(fx, fx.ops, during)
      await at(t0 + F)
      await expectPolicyError(execModule(fx, fx.ops, before), fx, 'VoidedByFreeze', [hBefore, id])
      await expectPolicyError(execModule(fx, fx.ops, during), fx, 'VoidedByFreeze', [hDuring, id])
      // A void schedule is replaced; the new one runs.
      const again = await scheduleModule(fx, fx.ops, before)
      const t1 = await timestampOf(again.tx)
      await at(t1 + T)
      await execModule(fx, fx.ops, before)
    })

    it('does not void a schedule made after a lift', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(
        fx,
        scope(fx.ops.address),
        tl(T, { guardians: [fx.guardian.address], lifters: [fx.lifter.address] }),
      )
      await allow(fx, scope(fx.ops.address))
      await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      await fx.timelock.connect(fx.lifter).lift(fx.engine, fx.safeAddress, id)
      const c = call(fx.target)
      const { tx } = await scheduleModule(fx, fx.ops, c)
      await at((await timestampOf(tx)) + T)
      await execModule(fx, fx.ops, c)
    })

    it('never voids a scheduled configuration, and does not let it be replaced (AlreadyScheduled)', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(OWNERS), tl(T, { guardians: [fx.guardian.address] }))
      const config = call(fx.engine, configureData(fx, []))
      const { hash } = await scheduleOwner(fx, config, [fx.o1, fx.o2])
      const tx = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [id])
      const t0 = await timestampOf(tx)
      await expectRevert(scheduleOwner(fx, config, [fx.o1, fx.o2]), fx.timelock, 'AlreadyScheduled', [hash])
      await at(t0 + F)
      const exec = await execOwner(fx, config, [fx.o1, fx.o2])
      await expectEvent(exec, fx.timelock, 'Executed', [fx.engine, fx.safeAddress, hash])
    })
  })

  describe('cancel', () => {
    it('lets a canceller of a matched id cancel, and nobody else (a guardian is not a canceller)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T, { guardians: [fx.guardian.address] }))
      await attach(fx, scope(ANY, fx.target), tl(0, { cancellers: [fx.canceller.address] }))
      const { hash } = await scheduleOwner(fx, call(fx.target), [fx.o1, fx.o2])
      for (const who of [fx.guardian, fx.outsider, fx.o1]) {
        await expectRevert(
          fx.timelock.connect(who).cancel(fx.engine, fx.safeAddress, hash),
          fx.timelock,
          'NotCanceller',
          [who.address],
        )
      }
      const tx = await fx.timelock.connect(fx.canceller).cancel(fx.engine, fx.safeAddress, hash)
      await expectEvent(tx, fx.timelock, 'Cancelled', [fx.engine, fx.safeAddress, hash, fx.canceller.address])
      await time.increase(T)
      await expectPolicyError(execOwner(fx, call(fx.target), [fx.o1, fx.o2]), fx, 'NotScheduled', [hash])
    })

    it('makes the cancel of an owner-path schedule by a canceller final too (CancelledTransaction)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T, { cancellers: [fx.canceller.address] }))
      const c = call(fx.target)
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      await fx.timelock.connect(fx.canceller).cancel(fx.engine, fx.safeAddress, hash)
      expect(await fx.timelock.isCancelled(fx.engine, fx.safeAddress, hash)).to.equal(true)
      await expectRevert(scheduleOwner(fx, c, [fx.o1, fx.o2]), fx.timelock, 'CancelledTransaction', [hash])
    })

    it('never lets a listed canceller cancel a configuration change; the owners and its module can (rev 3 review fable P4)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T, { cancellers: [fx.canceller.address] }))
      await attach(fx, scope(fx.ops.address), tl(T, { cancellers: [fx.canceller.address] }))
      const config = call(fx.engine, configureData(fx, []))
      const { hash } = await scheduleOwner(fx, config, [fx.o1, fx.o2])
      await expectRevert(
        fx.timelock.connect(fx.canceller).cancel(fx.engine, fx.safeAddress, hash),
        fx.timelock,
        'NotCanceller',
        [fx.canceller.address],
      )
      const sigs = await sign(await fx.timelock.cancelDigest(fx.engine, fx.safeAddress, hash), [fx.o1, fx.o2])
      await fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hash, sigs)
      // A module's configuration schedule: not by the canceller, by the module itself.
      const own = await scheduleModule(fx, fx.ops, config)
      await expectRevert(
        fx.timelock.connect(fx.canceller).cancel(fx.engine, fx.safeAddress, own.hash),
        fx.timelock,
        'NotCanceller',
        [fx.canceller.address],
      )
      await fx.timelock.connect(fx.ops).cancel(fx.engine, fx.safeAddress, own.hash)
    })

    it('cancels an owner-path schedule with threshold owner signatures over cancelDigest', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T))
      const { hash, tx } = await scheduleOwner(fx, call(fx.target), [fx.o1, fx.o2])
      const scheduledAt = await timestampOf(tx)
      const digest = await fx.timelock.cancelDigest(fx.engine, fx.safeAddress, hash)
      const { chainId } = await ethers.provider.getNetwork()
      expect(digest).to.equal(
        TypedDataEncoder.hash(
          { name: 'TimelockPolicy', version: '1', chainId, verifyingContract: fx.policy },
          {
            Cancel: [
              { name: 'engine', type: 'address' },
              { name: 'safe', type: 'address' },
              { name: 'txHash', type: 'bytes32' },
              { name: 'scheduledAt', type: 'uint64' },
            ],
          },
          { engine: fx.engine, safe: fx.safeAddress, txHash: hash, scheduledAt },
        ),
      )
      await expectRevert(
        fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hash, await sign(digest, [fx.o1])),
        fx.safe,
        'InvalidSignatures',
      )
      const cancel = await fx.timelock
        .connect(fx.outsider)
        .cancelAsOwners(fx.engine, fx.safeAddress, hash, await sign(digest, [fx.o2, fx.o3]))
      await expectEvent(cancel, fx.timelock, 'Cancelled', [fx.engine, fx.safeAddress, hash, fx.safeAddress])
      await expectRevert(
        fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hash, '0x'),
        fx.timelock,
        'NotScheduled',
        [hash],
      )
    })

    it('retires the transaction for good: its signatures cannot schedule it again (CancelledTransaction)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), tl(T))
      const c = call(fx.target)
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      expect(await fx.timelock.isCancelled(fx.engine, fx.safeAddress, hash)).to.equal(false)
      const sigs = await sign(await fx.timelock.cancelDigest(fx.engine, fx.safeAddress, hash), [fx.o1, fx.o2])
      await fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hash, sigs)
      expect(await fx.timelock.isCancelled(fx.engine, fx.safeAddress, hash)).to.equal(true)
      await expectRevert(scheduleOwner(fx, c, [fx.o1, fx.o2]), fx.timelock, 'CancelledTransaction', [hash])
      // A new transaction at the same nonce (another hash) schedules as usual.
      await scheduleOwner(fx, call(fx.target, '0x01'), [fx.o1, fx.o2])
    })

    it('refuses cancelAsOwners on a module-path schedule (NotOwnersQueue)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.recovery.address), tl(R))
      const { hash } = await scheduleModule(fx, fx.recovery, call(fx.target))
      const sigs = await sign(await fx.timelock.cancelDigest(fx.engine, fx.safeAddress, hash), [fx.o1, fx.o2])
      await expectRevert(
        fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hash, sigs),
        fx.timelock,
        'NotOwnersQueue',
        [hash],
      )
    })
  })

  describe('queue module', () => {
    it('is passed to the constructor, which refuses an address without code (InvalidSettings)', async () => {
      const fx = await loadFixture(deploy)
      const factory = await ethers.getContractFactory('TimelockPolicy')
      const freezer = await fx.timelock.freezer()
      await expectRevert(factory.deploy(F, C, fx.outsider.address, freezer), fx.timelock, 'InvalidSettings')
      await expectRevert(factory.deploy(F, C, ZeroAddress, freezer), fx.timelock, 'InvalidSettings')
    })

    it('refuses a freeze module without code or built with other F or C (InvalidSettings)', async () => {
      const fx = await loadFixture(deploy)
      const factory = await ethers.getContractFactory('TimelockPolicy')
      const queue = await fx.timelock.queue()
      await expectRevert(factory.deploy(F, C, queue, fx.outsider.address), fx.timelock, 'InvalidSettings')
      const other = await ethers.deployContract('TimelockPolicyFreeze', [F, C + 1])
      await expectRevert(
        factory.deploy(F, C, queue, await other.getAddress()),
        fx.timelock,
        'InvalidSettings',
      )
      const longer = await ethers.deployContract('TimelockPolicyFreeze', [F + 1, C])
      await expectRevert(
        factory.deploy(F, C, queue, await longer.getAddress()),
        fx.timelock,
        'InvalidSettings',
      )
    })

    it('freeze module refuses direct calls (NotDelegated)', async () => {
      const fx = await loadFixture(deploy)
      const freezer = await ethers.getContractAt('TimelockPolicyFreeze', await fx.timelock.freezer())
      expect(await freezer.MAX_FREEZE()).to.equal(BigInt(F))
      expect(await freezer.COOLDOWN()).to.equal(BigInt(C))
      await expectRevert(freezer.freeze(fx.engine, fx.safeAddress, []), freezer, 'NotDelegated')
      await expectRevert(freezer.lift(fx.engine, fx.safeAddress, ethers.ZeroHash), freezer, 'NotDelegated')
    })

    it('refuses direct calls (NotDelegated)', async () => {
      const fx = await loadFixture(deploy)
      const queue = await ethers.getContractAt('TimelockPolicyQueue', await fx.timelock.queue())
      await expectRevert(
        queue.scheduleModuleTx(fx.engine, fx.safeAddress, fx.target, 0, '0x', 0),
        queue,
        'NotDelegated',
      )
      await expectRevert(queue.cancel(fx.engine, fx.safeAddress, ethers.ZeroHash), queue, 'NotDelegated')
    })
  })

  describe(`compromise timelines (T = 24 h, R = 72 h, F = 7 d, C = 12 h)`, () => {
    it('owner keys: the guardian freezes, recovery swaps the owners within R < F, the new owners cancel the attacker', async () => {
      const fx = await loadFixture(deploy)
      expect(R).to.be.lessThan(F)
      const ids = await org(fx)
      const attacker = [fx.o1, fx.o2]
      // The attacker queues a drain and a configuration that removes the owners' Timelock.
      const drain = call(fx.target, '0x', parseEther('5'))
      const removeTimelock = call(
        fx.engine,
        configureData(fx, [change(scope(OWNERS), Kind.POLICY, fx.policy, '0x', 0, true)]),
      )
      const nonce = await fx.safe.nonce()
      const { hash: hDrain } = await scheduleOwner(fx, drain, attacker, nonce)
      const { hash: hConfig } = await scheduleOwner(fx, removeTimelock, attacker, nonce + 1n)
      expect((await scheduleOf(fx, hConfig)).isConfiguration).to.equal(true)
      // The guardian sees the Scheduled events and freezes the owners.
      const freeze = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners])
      const t0 = await timestampOf(freeze)
      await at(t0 + T)
      await expectPolicyError(execOwner(fx, drain, attacker), fx, 'AttachmentFrozen', [ids.owners, t0 + F])
      // Recovery (not frozen) replaces the two compromised owners after R.
      const swap1 = swapOwnerCall(fx, fx.o1.address, fx.n1.address)
      const swap2 = swapOwnerCall(fx, fx.o2.address, fx.n2.address)
      const { tx: s1 } = await scheduleModule(fx, fx.recovery, swap1)
      await scheduleModule(fx, fx.recovery, swap2)
      const tr = await timestampOf(s1)
      await at(tr + R + 1)
      await execModule(fx, fx.recovery, swap1)
      await execModule(fx, fx.recovery, swap2)
      expect(await time.latest()).to.be.lessThan(t0 + F)
      expect(await fx.safe.isOwner(fx.o1.address)).to.equal(false)
      // The new owners cancel the attacker's configuration (it would survive the freeze).
      const digest = await fx.timelock.cancelDigest(fx.engine, fx.safeAddress, hConfig)
      await expectRevert(
        fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hConfig, await sign(digest, attacker)),
        fx.safe,
        'InvalidSignatures',
      )
      await fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hConfig, await sign(digest, [fx.n1, fx.n2]))
      // Recovery (a lifter of the owners' attachment) lifts; the attacker's drain stays void.
      await fx.timelock.connect(fx.recovery).lift(fx.engine, fx.safeAddress, ids.owners)
      await expectPolicyError(execOwner(fx, drain, [fx.n1, fx.n2]), fx, 'VoidedByFreeze', [
        hDrain,
        ids.owners,
      ])
      expect(await ethers.provider.getBalance(fx.target)).to.equal(0n)
    })

    it('guardian: the owners schedule a configuration during the freeze and run it in the cooldown (F + C per cycle)', async () => {
      const fx = await loadFixture(deploy)
      const ids = await org(fx)
      const owners = [fx.o1, fx.o2]
      const freeze = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners])
      const t0 = await timestampOf(freeze)
      // Replace the owners' attachment without the rogue guardian (recovery stays the lifter).
      const replace = call(
        fx.engine,
        configureData(fx, [
          change(scope(OWNERS), Kind.POLICY, fx.policy, tl(T, { lifters: [fx.recovery.address] })),
        ]),
      )
      await at(t0 + HOUR)
      const { hash } = await scheduleOwner(fx, replace, owners)
      // Ready at T < F, blocked by the freeze until F.
      await at(t0 + HOUR + T)
      await expectPolicyError(execOwner(fx, replace, owners), fx, 'AttachmentFrozen', [ids.owners, t0 + F])
      const skip = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners])
      await expectEvent(skip, fx.timelock, 'FreezeSkipped')
      // The freeze ends at F; the guardian cannot re-freeze during C; the owners run the change.
      await at(t0 + F)
      await expectEvent(
        await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners]),
        fx.timelock,
        'FreezeSkipped',
        [fx.engine, fx.safeAddress, ids.owners, fx.guardian.address, t0 + F + C],
      )
      const exec = await execOwner(fx, replace, owners)
      await expectEvent(exec, fx.timelock, 'Executed', [fx.engine, fx.safeAddress, hash])
      expect(await timestampOf(exec)).to.be.lessThan(t0 + F + C)
      await at(t0 + F + C)
      await expectRevert(
        fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners]),
        fx.timelock,
        'NotGuardian',
        [ids.owners],
      )
    })

    it('guardian, recovery lifts: the owners configuration runs as soon as the lifter ends the freeze', async () => {
      const fx = await loadFixture(deploy)
      const ids = await org(fx)
      const owners = [fx.o1, fx.o2]
      const freeze = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners])
      const t0 = await timestampOf(freeze)
      const replace = call(
        fx.engine,
        configureData(fx, [change(scope(OWNERS), Kind.POLICY, fx.policy, tl(T))]),
      )
      const { hash } = await scheduleOwner(fx, replace, owners)
      await at(t0 + R)
      await fx.timelock.connect(fx.recovery).lift(fx.engine, fx.safeAddress, ids.owners)
      const exec = await execOwner(fx, replace, owners)
      await expectEvent(exec, fx.timelock, 'Executed', [fx.engine, fx.safeAddress, hash])
      expect(await timestampOf(exec)).to.be.lessThan(t0 + F)
    })

    it('guardian with C < T: a re-freeze catches what was scheduled after the freeze; only the configuration survives it', async () => {
      const fx = await loadFixture(deploy)
      expect(C).to.be.lessThan(T)
      const ids = await org(fx)
      const owners = [fx.o1, fx.o2]
      const replace = call(
        fx.engine,
        configureData(fx, [change(scope(OWNERS), Kind.POLICY, fx.policy, tl(T))]),
      )
      const payment = call(fx.target, '0x', parseEther('1'))
      const freeze = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners])
      const t0 = await timestampOf(freeze)
      // Waiting for the freeze to end does not work: a schedule made at F is ready at F + T > F + C,
      // and the guardian freezes again at F + C.
      await at(t0 + F)
      const late = await scheduleOwner(fx, replace, owners)
      const pay = await scheduleOwner(fx, payment, owners)
      await at(t0 + F + C)
      const refreeze = await fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners])
      await expectEvent(refreeze, fx.timelock, 'Frozen', [
        fx.engine,
        fx.safeAddress,
        ids.owners,
        fx.guardian.address,
        t0 + 2 * F + C,
      ])
      await at(t0 + F + T)
      await expectPolicyError(execOwner(fx, replace, owners), fx, 'AttachmentFrozen', [
        ids.owners,
        t0 + 2 * F + C,
      ])
      // The payment is void; the configuration survives the second freeze and runs in its cooldown.
      await at(t0 + 2 * F + C)
      await expectPolicyError(execOwner(fx, payment, owners), fx, 'VoidedByFreeze', [pay.hash, ids.owners])
      const exec = await execOwner(fx, replace, owners)
      await expectEvent(exec, fx.timelock, 'Executed', [fx.engine, fx.safeAddress, late.hash])
      expect(await timestampOf(exec)).to.be.lessThan(t0 + 2 * F + 2 * C)
      expect([
        ...(await fx.timelock.getSettings(fx.engine, fx.safeAddress, ids.owners)).guardians,
      ]).to.deep.equal([])
      await expectRevert(
        fx.timelock.connect(fx.guardian).freeze(fx.engine, fx.safeAddress, [ids.owners]),
        fx.timelock,
        'NotGuardian',
        [ids.owners],
      )
    })

    it('recovery key: its swapOwner is visible for R; the owners detach recovery at T < R', async () => {
      const fx = await loadFixture(deploy)
      expect(T).to.be.lessThan(R)
      const ids = await org(fx)
      const owners = [fx.o1, fx.o2]
      const steal = swapOwnerCall(fx, fx.o1.address, fx.outsider.address)
      const { hash, tx } = await scheduleModule(fx, fx.recovery, steal)
      const tr = await timestampOf(tx)
      await expectEvent(tx, fx.timelock, 'Scheduled', [
        fx.engine,
        fx.safeAddress,
        hash,
        fx.recovery.address,
        steal.to,
        steal.value,
        steal.data,
        steal.operation,
        0,
        tr + R,
        false,
      ])
      // The owners cannot cancel recovery's queue; they detach recovery's Allow instead.
      const sigs = await sign(await fx.timelock.cancelDigest(fx.engine, fx.safeAddress, hash), owners)
      await expectRevert(
        fx.timelock.cancelAsOwners(fx.engine, fx.safeAddress, hash, sigs),
        fx.timelock,
        'NotOwnersQueue',
        [hash],
      )
      const detach = call(
        fx.engine,
        configureData(fx, [
          change(
            scope(fx.recovery.address, fx.safeAddress, ids.swapOwner),
            Kind.ALLOW,
            ZeroAddress,
            '0x',
            0,
            true,
          ),
        ]),
      )
      const { tx: st } = await scheduleOwner(fx, detach, owners)
      const ts = await timestampOf(st)
      await at(ts + T)
      await execOwner(fx, detach, owners)
      expect(ts + T).to.be.lessThan(tr + R)
      await at(tr + R)
      let data: string | undefined
      try {
        await execModule(fx, fx.recovery, steal)
      } catch (e) {
        data = revertData(e)
      }
      expect(fx.stub.interface.parseError(data!)?.name).to.equal('NotGranted')
      expect(await fx.safe.isOwner(fx.o1.address)).to.equal(true)
    })
  })
})
