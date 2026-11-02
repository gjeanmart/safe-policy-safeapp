import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import {
  AbiCoder,
  TypedDataEncoder,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  parseEther,
  solidityPacked,
} from 'ethers'
import { ethers, network } from 'hardhat'
import type {
  FreezePolicy,
  TimelockEngineStub,
  TimelockMockSafe,
  TimelockPolicy,
} from '../../../typechain-types'
import { eventsOf, expectEvent, expectRevert, revertData } from '../helpers'

/**
 * TimelockPolicy (SPEC.md §7, §8.2) against TimelockEngineStub, which calls the policy as the V2
 * engine does, and TimelockMockSafe (real Safe transaction hash and checkNSignatures).
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const BATCH = getAddress('0x000000000000000000000000000000000000ba7c')
const CallMatch = { ANY: 0, TO: 1, SELECTOR: 2, TO_SELECTOR: 3 } as const
const Op = { CALL: 0, DELEGATECALL: 1 } as const
const POLICY_KIND = 2
const OP_ALL = 3
const HOUR = 3600
const DAY = 24 * HOUR
const T = DAY // owners' timelock
const R = 3 * DAY // recovery's timelock
const F = 7 * DAY // max freeze
const C = 12 * HOUR // freeze cooldown
const TX_INDEX = 65535n

type Scope = { actor: string; to: string; selector: string; callMatch: number }
type TimelockSettings = { delay: number; window: number; clearOnFreeze: boolean; cancellers: string[] }

const scope = (
  actor: string,
  to = ZeroAddress,
  selector = '0x00000000',
  callMatch: number = CallMatch.ANY,
): Scope => ({
  actor,
  to,
  selector,
  callMatch,
})
const scopeKey = (s: Scope) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]))
const attachmentId = (s: Scope, policy: string) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [scopeKey(s), POLICY_KIND, policy]))
const encodeTimelock = (s: TimelockSettings) =>
  coder.encode(['tuple(uint32,uint32,bool,address[])'], [[s.delay, s.window, s.clearOnFreeze, s.cancellers]])
const tl = (delay: number, more: Partial<TimelockSettings> = {}): string =>
  encodeTimelock({ delay, window: 0, clearOnFreeze: false, cancellers: [], ...more })
const encodeFreeze = (safeWide: boolean, actor: boolean) =>
  coder.encode(['tuple(bool,bool)'], [[safeWide, actor]])

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

/**
 * Asserts the action reverted with the engine's `outerError` (PolicyDenied / PolicyConfigurationFailed)
 * naming `policy`, whose `reason` decodes to `errorName` (with `args`, if given).
 */
async function expectPolicyError(
  action: Promise<unknown>,
  stub: TimelockEngineStub,
  policy: TimelockPolicy | FreezePolicy,
  errorName: string,
  args?: unknown[],
  outerError = 'PolicyDenied',
): Promise<void> {
  let data: string | undefined
  try {
    await action
  } catch (e) {
    data = revertData(e)
    if (data === undefined) throw e
  }
  if (data === undefined) expect.fail(`expected ${outerError}(${errorName}), but the call succeeded`)
  const outer = stub.interface.parseError(data)
  expect(outer?.name, `revert data ${data}`).to.equal(outerError)
  if (outerError === 'PolicyDenied') expect(outer!.args.callIndex).to.equal(TX_INDEX)
  expect(outer!.args.policy).to.equal(await policy.getAddress())
  const inner = policy.interface.parseError(outer!.args.reason)
  expect(inner?.name, `reason ${outer!.args.reason}`).to.equal(errorName)
  if (args) expect(normalize([...inner!.args])).to.deep.equal(normalize(args))
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string' && v.startsWith('0x')) return v.toLowerCase()
  return v
}

async function deploy() {
  const [
    deployer,
    o1,
    o2,
    o3,
    guardian,
    recovery,
    ops,
    sparkOwner,
    attacker,
    newOwner1,
    newOwner2,
    outsider,
  ] = await ethers.getSigners()
  const stub = await ethers.deployContract('TimelockEngineStub', [F, C, BATCH])
  const timelock = await ethers.deployContract('TimelockPolicy')
  const freeze = await ethers.deployContract('FreezePolicy')
  const owners = [o1, o2, o3]
  const safe = await ethers.deployContract('TimelockMockSafe', [
    owners.map((o) => o.address),
    2,
    await stub.getAddress(),
    [recovery.address, ops.address],
  ])
  const spark = await ethers.deployContract('TimelockMockSafe', [[sparkOwner.address], 1, ZeroAddress, []])
  await deployer.sendTransaction({ to: await safe.getAddress(), value: parseEther('10') })
  const target = getAddress('0x000000000000000000000000000000000000d1a1')
  return {
    deployer,
    o1,
    o2,
    o3,
    owners,
    guardian,
    recovery,
    ops,
    sparkOwner,
    attacker,
    newOwner1,
    newOwner2,
    outsider,
    stub,
    timelock,
    freeze,
    safe,
    spark,
    target,
  }
}

type Fx = Awaited<ReturnType<typeof deploy>>

/** Attaches `policy` with `data` at `s`; returns the attachment id. */
async function attach(
  fx: Fx,
  s: Scope,
  policy: TimelockPolicy | FreezePolicy,
  data: string,
  opMask = OP_ALL,
) {
  const policyAddress = await policy.getAddress()
  await fx.stub.attachPolicy(await fx.safe.getAddress(), s, policyAddress, opMask, data)
  return attachmentId(s, policyAddress)
}

type SafeCall = { to: string; value: bigint; data: string; operation: number }
const call = (to: string, data = '0x', value = 0n, operation: number = Op.CALL): SafeCall => ({
  to,
  value,
  data,
  operation,
})

async function safeTxHash(safe: TimelockMockSafe, c: SafeCall, nonce: bigint) {
  return safe.getTransactionHash(c.to, c.value, c.data, c.operation, 0, 0, 0, ZeroAddress, ZeroAddress, nonce)
}

const safeTx = (c: SafeCall, nonce: bigint) => ({
  ...c,
  safeTxGas: 0,
  baseGas: 0,
  gasPrice: 0,
  gasToken: ZeroAddress,
  refundReceiver: ZeroAddress,
  nonce,
})

/** Owners schedule `c` at `nonce` (default: the Safe's next nonce) with `signers`. */
async function scheduleOwner(fx: Fx, c: SafeCall, signers: HardhatEthersSigner[], nonce?: bigint) {
  const n = nonce ?? (await fx.safe.nonce())
  const hash = await safeTxHash(fx.safe, c, n)
  const tx = await fx.timelock.scheduleOwnerTx(
    await fx.stub.getAddress(),
    await fx.safe.getAddress(),
    safeTx(c, n),
    await sign(hash, signers),
  )
  return { hash, tx }
}

/** Owners execute `c` at the Safe's current nonce. */
async function execOwner(fx: Fx, c: SafeCall, signers: HardhatEthersSigner[]) {
  const hash = await safeTxHash(fx.safe, c, await fx.safe.nonce())
  return fx.safe.execTransaction(c.to, c.value, c.data, c.operation, await sign(hash, signers))
}

async function scheduleModule(fx: Fx, module: HardhatEthersSigner, c: SafeCall) {
  const stub = await fx.stub.getAddress()
  const safe = await fx.safe.getAddress()
  const hash = await fx.timelock
    .connect(module)
    .scheduleModuleTx.staticCall(stub, safe, c.to, c.value, c.data, c.operation)
  const tx = await fx.timelock
    .connect(module)
    .scheduleModuleTx(stub, safe, c.to, c.value, c.data, c.operation)
  return { hash, tx }
}

const execModule = (fx: Fx, module: HardhatEthersSigner, c: SafeCall) =>
  fx.safe.connect(module).execTransactionFromModule(c.to, c.value, c.data, c.operation)

async function scheduleOf(fx: Fx, hash: string) {
  return fx.timelock.getSchedule(await fx.stub.getAddress(), await fx.safe.getAddress(), hash)
}

describe('TimelockPolicy (WP3)', () => {
  describe('settings', () => {
    it('reports the delay as the delay floor and stores the settings', async () => {
      const fx = await loadFixture(deploy)
      const s = scope(OWNERS)
      const settings = { delay: T, window: HOUR, clearOnFreeze: true, cancellers: [fx.outsider.address] }
      const tx = await fx.stub.attachPolicy(
        await fx.safe.getAddress(),
        s,
        await fx.timelock.getAddress(),
        OP_ALL,
        encodeTimelock(settings),
      )
      const id = attachmentId(s, await fx.timelock.getAddress())
      await expectEvent(tx, fx.stub, 'Configured', [
        await fx.safe.getAddress(),
        id,
        await fx.timelock.getAddress(),
        T,
      ])
      const stored = await fx.timelock.getSettings(await fx.stub.getAddress(), await fx.safe.getAddress(), id)
      expect([stored.delay, stored.window, stored.clearOnFreeze, [...stored.cancellers]]).to.deep.equal([
        BigInt(T),
        BigInt(HOUR),
        true,
        [fx.outsider.address],
      ])
      // Settings are namespaced by engine: another caller sees nothing.
      const other = await fx.timelock.getSettings(fx.outsider.address, await fx.safe.getAddress(), id)
      expect(other.delay).to.equal(0n)
    })

    it('encodes settings like abi.encode(Settings)', async () => {
      const { timelock, outsider } = await loadFixture(deploy)
      const settings = { delay: 5, window: 6, clearOnFreeze: true, cancellers: [outsider.address] }
      expect(await timelock.encodeSettings(settings)).to.equal(encodeTimelock(settings))
    })

    it('rejects a zero delay, more than 8 cancellers and a zero canceller (InvalidSettings)', async () => {
      const fx = await loadFixture(deploy)
      const nine = Array.from({ length: 9 }, (_, i) =>
        getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`),
      )
      for (const data of [tl(0), tl(HOUR, { cancellers: nine }), tl(HOUR, { cancellers: [ZeroAddress] })]) {
        await expectPolicyError(
          fx.stub.attachPolicy(
            await fx.safe.getAddress(),
            scope(OWNERS),
            await fx.timelock.getAddress(),
            OP_ALL,
            data,
          ),
          fx.stub,
          fx.timelock,
          'InvalidSettings',
          [],
          'PolicyConfigurationFailed',
        )
      }
      // Exactly 8 cancellers is fine.
      await attach(fx, scope(OWNERS), fx.timelock, tl(HOUR, { cancellers: nine.slice(0, 8) }))
    })

    it('is a transaction-level IPolicyV2 and ITimelockPolicy', async () => {
      const { timelock } = await loadFixture(deploy)
      expect(await timelock.policyLevel()).to.equal(1n)
      expect(await timelock.supportsInterface('0x55872811')).to.equal(true) // IPolicyV2
      expect(await timelock.supportsInterface('0x01ffc9a7')).to.equal(true) // IERC165
      expect(await timelock.supportsInterface('0xffffffff')).to.equal(false)
    })
  })

  describe('module path', () => {
    it('schedules, denies too early, executes once matured, and never twice', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR))
      const c = call(fx.target, '0x12345678', 0n)
      const { hash, tx } = await scheduleModule(fx, fx.ops, c)
      const scheduledAt = BigInt(await time.latest())
      expect(hash).to.equal(
        keccak256(
          coder.encode(
            ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
            [await fx.safe.getAddress(), fx.ops.address, c.to, c.value, c.data, c.operation],
          ),
        ),
      )
      await expectEvent(tx, fx.timelock, 'Scheduled', [
        await fx.stub.getAddress(),
        await fx.safe.getAddress(),
        hash,
        fx.ops.address,
        c.to,
        c.value,
        c.data,
        c.operation,
        0n,
        scheduledAt + BigInt(HOUR),
      ])
      const s = await scheduleOf(fx, hash)
      expect([s.actor, s.scheduledAt, s.readyAt, s.epoch, s.frozenAtSchedule]).to.deep.equal([
        fx.ops.address,
        scheduledAt,
        scheduledAt + BigInt(HOUR),
        0n,
        false,
      ])

      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'NotReady', [
        hash,
        scheduledAt + BigInt(HOUR),
      ])
      await time.setNextBlockTimestamp(scheduledAt + BigInt(HOUR))
      const exec = await execModule(fx, fx.ops, c)
      await expectEvent(exec, fx.timelock, 'Executed', [
        await fx.stub.getAddress(),
        await fx.safe.getAddress(),
        hash,
      ])
      expect((await scheduleOf(fx, hash)).scheduledAt).to.equal(0n)

      // Used once: the same call again needs a new schedule.
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'NotScheduled', [hash])
      await scheduleModule(fx, fx.ops, c)
    })

    it('denies an unscheduled call and a second schedule of a pending one', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR))
      const c = call(fx.target)
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'NotScheduled')
      const { hash: h } = await scheduleModule(fx, fx.ops, c)
      await expectRevert(
        fx.timelock
          .connect(fx.ops)
          .scheduleModuleTx(
            await fx.stub.getAddress(),
            await fx.safe.getAddress(),
            c.to,
            c.value,
            c.data,
            c.operation,
          ),
        fx.timelock,
        'AlreadyScheduled',
        [h],
      )
    })

    it("binds the schedule to the module: another module's identical call is not scheduled", async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(ANY), fx.timelock, tl(HOUR))
      const c = call(fx.target)
      await scheduleModule(fx, fx.ops, c)
      await time.increase(HOUR)
      await expectPolicyError(execModule(fx, fx.recovery, c), fx.stub, fx.timelock, 'NotScheduled')
      await execModule(fx, fx.ops, c)
    })

    it('expires a matured schedule after the window', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR, { window: HOUR }))
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.ops, c)
      const readyAt = (await scheduleOf(fx, hash)).readyAt
      await time.setNextBlockTimestamp(readyAt + BigInt(HOUR) + 1n)
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'ScheduleExpired', [
        hash,
        readyAt + BigInt(HOUR),
      ])
    })

    it('still executes on the last second of the window', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR, { window: HOUR }))
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.ops, c)
      await time.setNextBlockTimestamp((await scheduleOf(fx, hash)).readyAt + BigInt(HOUR))
      await execModule(fx, fx.ops, c)
    })

    it('keeps the schedule when the execution fails (the guard reverts)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR))
      // TimelockPolicy has no fallback: this call reverts inside the Safe.
      const c = call(await fx.timelock.getAddress(), '0xdeadbeef')
      const { hash } = await scheduleModule(fx, fx.ops, c)
      await time.increase(HOUR)
      await expectRevert(execModule(fx, fx.ops, c), fx.stub, 'ModuleExecutionFailed')
      expect((await scheduleOf(fx, hash)).scheduledAt).to.not.equal(0n)
    })
  })

  describe('owner path', () => {
    it('schedules with the executing signatures and executes after the delay', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), fx.timelock, tl(T))
      const c = call(fx.target, '0x', parseEther('1'))
      const { hash, tx } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      const at = BigInt(await time.latest())
      await expectEvent(tx, fx.timelock, 'Scheduled', [
        await fx.stub.getAddress(),
        await fx.safe.getAddress(),
        hash,
        OWNERS,
        c.to,
        c.value,
        c.data,
        c.operation,
        0n,
        at + BigInt(T),
      ])
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx.stub, fx.timelock, 'NotReady', [
        hash,
        at + BigInt(T),
      ])
      await time.increaseTo(at + BigInt(T))
      const exec = await execOwner(fx, c, [fx.o1, fx.o2])
      await expectEvent(exec, fx.timelock, 'Executed')
      expect(await ethers.provider.getBalance(fx.target)).to.equal(parseEther('1'))

      // The same call at the next nonce is a different transaction: not scheduled.
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx.stub, fx.timelock, 'NotScheduled')
    })

    it('accepts a future nonce and lets a schedule die when the nonce moves past it', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS, fx.target, '0x00000000', CallMatch.TO), fx.timelock, tl(HOUR))
      const c = call(fx.target)
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o3], 1n)
      expect((await scheduleOf(fx, hash)).actor).to.equal(OWNERS)
      await time.increase(HOUR)
      // Nonce 0 is used by an untimelocked transaction, so nonce 1 executes the scheduled one.
      await execOwner(fx, call(fx.outsider.address), [fx.o1, fx.o2])
      await execOwner(fx, c, [fx.o1, fx.o3])

      // A schedule for nonce 3 dies when nonce 3 is spent on something else.
      const { hash: dead } = await scheduleOwner(fx, c, [fx.o1, fx.o3], 3n)
      await time.increase(HOUR)
      await execOwner(fx, call(fx.outsider.address), [fx.o1, fx.o2]) // nonce 2
      await execOwner(fx, call(fx.outsider.address), [fx.o1, fx.o2]) // nonce 3
      expect((await scheduleOf(fx, dead)).scheduledAt).to.not.equal(0n) // stale, never executable
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o3]), fx.stub, fx.timelock, 'NotScheduled')
    })

    it('rejects a used nonce (StaleNonce) and too few signatures', async () => {
      const fx = await loadFixture(deploy)
      await execOwner(fx, call(fx.outsider.address), [fx.o1, fx.o2])
      const c = call(fx.target)
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      const staleHash = await safeTxHash(fx.safe, c, 0n)
      await expectRevert(
        fx.timelock.scheduleOwnerTx(stub, safe, safeTx(c, 0n), await sign(staleHash, [fx.o1, fx.o2])),
        fx.timelock,
        'StaleNonce',
        [0n, 1n],
      )
      const hash = await safeTxHash(fx.safe, c, 1n)
      await expectRevert(
        fx.timelock.scheduleOwnerTx(stub, safe, safeTx(c, 1n), await sign(hash, [fx.o1])),
        fx.safe,
        'InvalidSignatures',
      )
      await expectRevert(
        fx.timelock.scheduleOwnerTx(stub, safe, safeTx(c, 1n), await sign(hash, [fx.o1, fx.outsider])),
        fx.safe,
        'InvalidSignatures',
      )
      const { hash: h } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      expect(h).to.equal(hash)
      await expectRevert(
        fx.timelock.scheduleOwnerTx(stub, safe, safeTx(c, 1n), await sign(hash, [fx.o2, fx.o3])),
        fx.timelock,
        'AlreadyScheduled',
        [hash],
      )
    })
  })

  describe('merge rules', () => {
    it('waits for the longest delay of the matched attachments', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), fx.timelock, tl(HOUR))
      await attach(fx, scope(OWNERS, fx.target, '0x00000000', CallMatch.TO), fx.timelock, tl(3 * HOUR))
      const c = call(fx.target)
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      const at = BigInt(await time.latest())
      expect((await scheduleOf(fx, hash)).readyAt).to.equal(at + BigInt(3 * HOUR))
      await time.increaseTo(at + BigInt(HOUR))
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx.stub, fx.timelock, 'NotReady', [
        hash,
        at + BigInt(3 * HOUR),
      ])
      await time.increaseTo(at + BigInt(3 * HOUR))
      await execOwner(fx, c, [fx.o1, fx.o2])

      // A call to another target only meets the 1h attachment.
      const other = call(fx.outsider.address)
      await scheduleOwner(fx, other, [fx.o1, fx.o2])
      await time.increase(HOUR)
      await execOwner(fx, other, [fx.o1, fx.o2])
    })

    it('recomputes the delay at execution from the current attachments', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR))
      const long = await attach(
        fx,
        scope(fx.ops.address, fx.target, '0x00000000', CallMatch.TO),
        fx.timelock,
        tl(R),
      )
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.ops, c)
      const at = BigInt(await time.latest())
      await time.increaseTo(at + BigInt(HOUR))
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'NotReady', [
        hash,
        at + BigInt(R),
      ])
      // Lengthening applies too.
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(5 * DAY))
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'NotReady', [
        hash,
        at + BigInt(5 * DAY),
      ])
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR))
      await fx.stub.detachPolicy(await fx.safe.getAddress(), long)
      await execModule(fx, fx.ops, c)
    })

    it('expires after the shortest non-zero window', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR, { window: 0 }))
      await attach(
        fx,
        scope(fx.ops.address, fx.target, '0x00000000', CallMatch.TO),
        fx.timelock,
        tl(HOUR, { window: 2 * HOUR }),
      )
      await attach(
        fx,
        scope(ANY, fx.target, '0x00000000', CallMatch.TO),
        fx.timelock,
        tl(HOUR, { window: HOUR }),
      )
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.ops, c)
      const readyAt = (await scheduleOf(fx, hash)).readyAt
      await time.setNextBlockTimestamp(readyAt + BigInt(HOUR) + 1n)
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'ScheduleExpired', [
        hash,
        readyAt + BigInt(HOUR),
      ])
    })

    it('snapshots the union of the cancellers of every matched attachment', async () => {
      const fx = await loadFixture(deploy)
      const [a, b, d] = [fx.outsider.address, fx.attacker.address, fx.sparkOwner.address]
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR, { cancellers: [a, b] }))
      await attach(
        fx,
        scope(ANY, fx.target, '0x00000000', CallMatch.TO),
        fx.timelock,
        tl(HOUR, { cancellers: [b, d] }),
      )
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      // Level order: (ANY, to.*) is level 1, (ops, *) level 4.
      expect([...(await fx.timelock.getCancellers(stub, safe, hash))]).to.deep.equal([b, d, a])
    })

    it('covers a batch through the union of its sub-calls (MultiSend)', async () => {
      const fx = await loadFixture(deploy)
      // Only the target is timelocked; a batch hiding a call to it must be scheduled too.
      await attach(fx, scope(OWNERS, fx.target, '0x00000000', CallMatch.TO), fx.timelock, tl(T))
      const entries = [
        { op: 0, to: fx.outsider.address, value: 0n, data: '0x' },
        { op: 0, to: fx.target, value: 0n, data: '0xabcdef01' },
      ]
      const batchData = concat([
        '0x8d80ff0a',
        coder.encode(
          ['bytes'],
          [
            concat(
              entries.map((t) =>
                solidityPacked(
                  ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
                  [t.op, t.to, t.value, (t.data.length - 2) / 2, t.data],
                ),
              ),
            ),
          ],
        ),
      ])
      const c = call(BATCH, batchData, 0n, Op.DELEGATECALL)
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx.stub, fx.timelock, 'NotScheduled')
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      expect((await scheduleOf(fx, hash)).readyAt).to.equal(BigInt(await time.latest()) + BigInt(T))
      await time.increase(T)
      await execOwner(fx, c, [fx.o1, fx.o2])
    })
  })

  describe('cancellers (another Safe can cancel: Spark)', () => {
    it("lets another Safe cancel a module's queued transaction", async () => {
      const fx = await loadFixture(deploy)
      const sparkAddress = await fx.spark.getAddress()
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(T, { cancellers: [sparkAddress] }))
      const c = call(fx.target, '0x', parseEther('5'))
      const { hash } = await scheduleModule(fx, fx.ops, c)

      // The Spark Safe executes its own transaction: timelock.cancel(engine, safe, txHash).
      const cancelData = fx.timelock.interface.encodeFunctionData('cancel', [
        await fx.stub.getAddress(),
        await fx.safe.getAddress(),
        hash,
      ])
      const sparkHash = await fx.spark.getTransactionHash(
        await fx.timelock.getAddress(),
        0,
        cancelData,
        Op.CALL,
        0,
        0,
        0,
        ZeroAddress,
        ZeroAddress,
        0,
      )
      const tx = await fx.spark.execTransaction(
        await fx.timelock.getAddress(),
        0,
        cancelData,
        Op.CALL,
        await sign(sparkHash, [fx.sparkOwner]),
      )
      await expectEvent(tx, fx.timelock, 'Cancelled', [
        await fx.stub.getAddress(),
        await fx.safe.getAddress(),
        hash,
        sparkAddress,
        0n,
      ])
      await time.increase(T)
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'NotScheduled', [hash])
    })

    it('lets a canceller cancel the owners queue too, without touching the owners cancel count', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), fx.timelock, tl(T, { cancellers: [fx.outsider.address] }))
      const { hash } = await scheduleOwner(fx, call(fx.target), [fx.o1, fx.o2])
      await fx.timelock
        .connect(fx.outsider)
        .cancel(await fx.stub.getAddress(), await fx.safe.getAddress(), hash)
      expect(await fx.timelock.cancelCount(await fx.stub.getAddress(), await fx.safe.getAddress())).to.equal(
        0n,
      )
      expect((await scheduleOf(fx, hash)).scheduledAt).to.equal(0n)
    })

    it('rejects anyone not listed (NotCanceller) and unknown schedules (NotScheduled)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(T, { cancellers: [fx.outsider.address] }))
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      for (const who of [fx.attacker, fx.ops, fx.o1]) {
        await expectRevert(fx.timelock.connect(who).cancel(stub, safe, hash), fx.timelock, 'NotCanceller', [
          who.address,
        ])
      }
      await expectRevert(
        fx.timelock.connect(fx.outsider).cancel(stub, safe, keccak256('0x01')),
        fx.timelock,
        'NotScheduled',
        [keccak256('0x01')],
      )
    })

    it('uses the snapshot taken at schedule time', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(T, { cancellers: [fx.outsider.address] }))
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(T, { cancellers: [fx.attacker.address] }))
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      await expectRevert(
        fx.timelock.connect(fx.attacker).cancel(stub, safe, hash),
        fx.timelock,
        'NotCanceller',
      )
      await fx.timelock.connect(fx.outsider).cancel(stub, safe, hash)
    })
  })

  describe('owners cancel with a rising threshold', () => {
    async function threeOfThree() {
      const fx = await deploy()
      const safe = await ethers.deployContract('TimelockMockSafe', [
        fx.owners.map((o) => o.address),
        3,
        await fx.stub.getAddress(),
        [fx.recovery.address],
      ])
      const f3: Fx = { ...fx, safe }
      await attach(f3, scope(OWNERS), fx.timelock, tl(T, { clearOnFreeze: true }))
      await attach(f3, scope(fx.recovery.address), fx.timelock, tl(R))
      return f3
    }

    async function cancelAsOwners(fx: Fx, hash: string, signers: HardhatEthersSigner[], digest?: string) {
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      const d = digest ?? (await fx.timelock.cancelDigest(stub, safe, hash))
      return fx.timelock.connect(fx.outsider).cancelAsOwners(stub, safe, hash, await sign(d, signers))
    }

    it('signs an EIP-712 Cancel(engine, safe, txHash, cancelCount) under the policy domain', async () => {
      const fx = await loadFixture(threeOfThree)
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      const hash = keccak256('0x1234')
      const expected = TypedDataEncoder.hash(
        {
          name: 'TimelockPolicy',
          version: '1',
          chainId: network.config.chainId,
          verifyingContract: await fx.timelock.getAddress(),
        },
        {
          Cancel: [
            { name: 'engine', type: 'address' },
            { name: 'safe', type: 'address' },
            { name: 'txHash', type: 'bytes32' },
            { name: 'cancelCount', type: 'uint256' },
          ],
        },
        { engine: stub, safe, txHash: hash, cancelCount: 0 },
      )
      expect(await fx.timelock.cancelDigest(stub, safe, hash)).to.equal(expected)
    })

    it('requires 1, then 2, then 3 signatures (capped at the threshold), and resets on execution', async () => {
      const fx = await loadFixture(threeOfThree)
      const all = [fx.o1, fx.o2, fx.o3]
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      const hashes: string[] = []
      for (let n = 0n; n < 5n; n++) hashes.push((await scheduleOwner(fx, call(fx.target), all, n)).hash)

      expect(await fx.timelock.requiredCancelSignatures(stub, safe)).to.equal(1n)
      const first = await cancelAsOwners(fx, hashes[1], [fx.o1])
      await expectEvent(first, fx.timelock, 'Cancelled', [stub, safe, hashes[1], fx.outsider.address, 1n])

      expect(await fx.timelock.requiredCancelSignatures(stub, safe)).to.equal(2n)
      await expectRevert(cancelAsOwners(fx, hashes[2], [fx.o1]), fx.safe, 'InvalidSignatures')
      await cancelAsOwners(fx, hashes[2], [fx.o1, fx.o2])

      expect(await fx.timelock.requiredCancelSignatures(stub, safe)).to.equal(3n)
      await expectRevert(cancelAsOwners(fx, hashes[3], [fx.o1, fx.o2]), fx.safe, 'InvalidSignatures')
      await cancelAsOwners(fx, hashes[3], all)

      // Capped at the Safe threshold.
      expect(await fx.timelock.cancelCount(stub, safe)).to.equal(3n)
      expect(await fx.timelock.requiredCancelSignatures(stub, safe)).to.equal(3n)

      // Executing an owners' schedule (nonce 0) resets the count.
      await time.increase(T)
      await execOwner(fx, call(fx.target), all)
      expect(await fx.timelock.cancelCount(stub, safe)).to.equal(0n)
      expect(await fx.timelock.requiredCancelSignatures(stub, safe)).to.equal(1n)
      await cancelAsOwners(fx, hashes[4], [fx.o3])
    })

    it('binds the cancel count, so an old cancel signature cannot be replayed', async () => {
      const fx = await loadFixture(threeOfThree)
      const all = [fx.o1, fx.o2, fx.o3]
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      const a = (await scheduleOwner(fx, call(fx.target), all, 0n)).hash
      const b = (await scheduleOwner(fx, call(fx.target), all, 1n)).hash
      const staleDigestB = await fx.timelock.cancelDigest(stub, safe, b) // signed at count 0
      await cancelAsOwners(fx, a, [fx.o1])
      await expectRevert(cancelAsOwners(fx, b, [fx.o1, fx.o2], staleDigestB), fx.safe, 'InvalidSignatures')
    })

    it("does not let owners cancel another actor's queue (NotOwnersQueue)", async () => {
      const fx = await loadFixture(threeOfThree)
      const { hash } = await scheduleModule(fx, fx.recovery, call(fx.target))
      await expectRevert(cancelAsOwners(fx, hash, [fx.o1, fx.o2, fx.o3]), fx.timelock, 'NotOwnersQueue', [
        hash,
      ])
      await expectRevert(cancelAsOwners(fx, keccak256('0x02'), [fx.o1]), fx.timelock, 'NotScheduled', [
        keccak256('0x02'),
      ])
    })

    it("does not reset the count when another actor's schedule executes", async () => {
      const fx = await loadFixture(threeOfThree)
      const stub = await fx.stub.getAddress()
      const safe = await fx.safe.getAddress()
      const { hash } = await scheduleOwner(fx, call(fx.target), [fx.o1, fx.o2, fx.o3], 0n)
      await cancelAsOwners(fx, hash, [fx.o2])
      const c = call(fx.target)
      await scheduleModule(fx, fx.recovery, c)
      await time.increase(R)
      await execModule(fx, fx.recovery, c)
      expect(await fx.timelock.cancelCount(stub, safe)).to.equal(1n)
    })
  })

  describe('freeze clearing', () => {
    async function withFreeze() {
      const fx = await deploy()
      const safe = await fx.safe.getAddress()
      await fx.stub.setRole(safe, 0, fx.guardian.address, true)
      await attach(fx, scope(OWNERS), fx.timelock, tl(T, { clearOnFreeze: true }))
      await attach(fx, scope(fx.ops.address), fx.timelock, tl(HOUR, { clearOnFreeze: true }))
      await attach(fx, scope(fx.recovery.address), fx.timelock, tl(R, { clearOnFreeze: false }))
      return fx
    }

    it("voids the owners' schedules made before a freeze", async () => {
      const fx = await loadFixture(withFreeze)
      const c = call(fx.target)
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      await fx.stub.connect(fx.guardian).freeze([await fx.safe.getAddress()])
      await fx.stub.connect(fx.guardian).lift(await fx.safe.getAddress(), ANY)
      await time.increase(T)
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx.stub, fx.timelock, 'ClearedByFreeze', [
        hash,
      ])
    })

    it("voids the owners' schedules made during a freeze, and accepts new ones after it", async () => {
      const fx = await loadFixture(withFreeze)
      const safe = await fx.safe.getAddress()
      await fx.stub.connect(fx.guardian).freeze([safe])
      const c = call(fx.target)
      const { hash } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      const s = await scheduleOf(fx, hash)
      expect([s.frozenAtSchedule, s.epoch]).to.deep.equal([true, 1n])
      await fx.stub.connect(fx.guardian).lift(safe, ANY)
      await time.increase(T)
      await expectPolicyError(execOwner(fx, c, [fx.o1, fx.o2]), fx.stub, fx.timelock, 'ClearedByFreeze', [
        hash,
      ])

      // During the cooldown (not frozen, same epoch) re-making the voided schedule works.
      const { tx } = await scheduleOwner(fx, c, [fx.o1, fx.o2])
      await expectEvent(tx, fx.timelock, 'Scheduled')
      await time.increase(T)
      await execOwner(fx, c, [fx.o1, fx.o2])
    })

    it('lets a module re-make its own voided schedule (it cannot cancel it), but not a live one', async () => {
      const fx = await loadFixture(withFreeze)
      const safe = await fx.safe.getAddress()
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.ops, c)
      const stub = await fx.stub.getAddress()
      const again = () =>
        fx.timelock.connect(fx.ops).scheduleModuleTx(stub, safe, c.to, c.value, c.data, c.operation)
      await expectRevert(again(), fx.timelock, 'AlreadyScheduled', [hash])
      await fx.stub.connect(fx.guardian).freezeActor(safe, fx.ops.address)
      await fx.stub.connect(fx.guardian).lift(safe, fx.ops.address)
      await again()
      expect((await scheduleOf(fx, hash)).epoch).to.equal(1n)
      await expectRevert(again(), fx.timelock, 'AlreadyScheduled', [hash])
      await time.increase(HOUR)
      await execModule(fx, fx.ops, c)
    })

    it("replaces the voided schedule's cancellers with the current ones", async () => {
      const fx = await loadFixture(withFreeze)
      const safe = await fx.safe.getAddress()
      const stub = await fx.stub.getAddress()
      const [a, b] = [fx.outsider.address, fx.attacker.address]
      const ops = scope(fx.ops.address)
      await attach(fx, ops, fx.timelock, tl(HOUR, { clearOnFreeze: true, cancellers: [a, b] }))
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.ops, c)
      expect([...(await fx.timelock.getCancellers(stub, safe, hash))]).to.deep.equal([a, b])
      await fx.stub.connect(fx.guardian).freezeActor(safe, fx.ops.address)
      await fx.stub.connect(fx.guardian).lift(safe, fx.ops.address)
      await attach(fx, ops, fx.timelock, tl(HOUR, { clearOnFreeze: true, cancellers: [b] }))
      await scheduleModule(fx, fx.ops, c)
      expect([...(await fx.timelock.getCancellers(stub, safe, hash))]).to.deep.equal([b])
    })

    it("does not let a voided schedule be replaced when nothing clears it (recovery's queue)", async () => {
      const fx = await loadFixture(withFreeze)
      const safe = await fx.safe.getAddress()
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.recovery, c)
      await fx.stub.connect(fx.guardian).freeze([safe])
      await expectRevert(
        fx.timelock
          .connect(fx.recovery)
          .scheduleModuleTx(await fx.stub.getAddress(), safe, c.to, c.value, c.data, c.operation),
        fx.timelock,
        'AlreadyScheduled',
        [hash],
      )
    })

    it("keeps recovery's queue (clearOnFreeze false) through a freeze", async () => {
      const fx = await loadFixture(withFreeze)
      const c = call(fx.target)
      await scheduleModule(fx, fx.recovery, c)
      await fx.stub.connect(fx.guardian).freeze([await fx.safe.getAddress()])
      await time.increase(R)
      await execModule(fx, fx.recovery, c)
    })

    it("an actor freeze voids that actor's queue only", async () => {
      const fx = await loadFixture(withFreeze)
      const safe = await fx.safe.getAddress()
      const c = call(fx.target)
      const { hash: opsHash } = await scheduleModule(fx, fx.ops, c)
      await scheduleOwner(fx, c, [fx.o1, fx.o2])
      await fx.stub.connect(fx.guardian).freezeActor(safe, fx.ops.address)
      await fx.stub.connect(fx.guardian).lift(safe, fx.ops.address)
      await time.increase(T)
      await expectPolicyError(execModule(fx, fx.ops, c), fx.stub, fx.timelock, 'ClearedByFreeze', [opsHash])
      await execOwner(fx, c, [fx.o1, fx.o2])
    })

    it('clears if any matched attachment says so', async () => {
      const fx = await loadFixture(withFreeze)
      // Recovery's calls to the target also meet a clearing attachment.
      await attach(
        fx,
        scope(ANY, fx.target, '0x00000000', CallMatch.TO),
        fx.timelock,
        tl(HOUR, { clearOnFreeze: true }),
      )
      const c = call(fx.target)
      const { hash } = await scheduleModule(fx, fx.recovery, c)
      await fx.stub.connect(fx.guardian).freeze([await fx.safe.getAddress()])
      await time.increase(R)
      await expectPolicyError(execModule(fx, fx.recovery, c), fx.stub, fx.timelock, 'ClearedByFreeze', [hash])
    })
  })

  describe('compromise timelines (design doc: T < R < F)', () => {
    /** Owners: Freeze + Timelock T (clears on freeze). Recovery: Timelock R, no Freeze. */
    async function story() {
      const fx = await deploy()
      const safe = await fx.safe.getAddress()
      await fx.stub.setRole(safe, 0, fx.guardian.address, true) // GUARDIAN
      await fx.stub.setRole(safe, 1, fx.recovery.address, true) // LIFTER
      await attach(fx, scope(OWNERS), fx.freeze, encodeFreeze(true, false))
      await attach(fx, scope(OWNERS), fx.timelock, tl(T, { clearOnFreeze: true }))
      await attach(fx, scope(fx.recovery.address), fx.timelock, tl(R, { clearOnFreeze: false }))
      return fx
    }

    it('owner keys compromised: the guardian freezes, recovery replaces the owners after R', async () => {
      const fx = await loadFixture(story)
      const safe = await fx.safe.getAddress()
      const t0 = BigInt(await time.latest())
      const thieves = [fx.o1, fx.o2] // enough for the 2-of-3 threshold

      // 0h: the attacker queues a drain.
      const drain = call(fx.attacker.address, '0x', parseEther('10'))
      const { hash: drainHash } = await scheduleOwner(fx, drain, thieves)

      // 2h: monitoring alerts; the guardian freezes the Safe.
      await time.increaseTo(t0 + 2n * BigInt(HOUR))
      await fx.stub.connect(fx.guardian).freeze([safe])
      const frozenUntil = (await fx.stub.getFreezeState(safe, ANY)).frozenUntil

      // 4h: recovery queues the owner swaps (module path, R = 72h).
      await time.increaseTo(t0 + 4n * BigInt(HOUR))
      const swap1 = call(
        safe,
        fx.safe.interface.encodeFunctionData('swapOwner', [OWNERS, fx.o1.address, fx.newOwner1.address]),
      )
      const swap2 = call(
        safe,
        fx.safe.interface.encodeFunctionData('swapOwner', [OWNERS, fx.o2.address, fx.newOwner2.address]),
      )
      await scheduleModule(fx, fx.recovery, swap1)
      await scheduleModule(fx, fx.recovery, swap2)

      // 24h: the drain matured, but the freeze denies it.
      await time.increaseTo(t0 + BigInt(T))
      await expectPolicyError(execOwner(fx, drain, thieves), fx.stub, fx.freeze, 'Frozen', [
        safe,
        ANY,
        frozenUntil,
      ])

      // 76h: recovery replaces the owners through the fire exit (no Freeze on it), then lifts.
      await time.increaseTo(t0 + 4n * BigInt(HOUR) + BigInt(R))
      await execModule(fx, fx.recovery, swap1)
      await execModule(fx, fx.recovery, swap2)
      expect(await fx.safe.isOwner(fx.o1.address)).to.equal(false)
      expect(await fx.safe.isOwner(fx.newOwner1.address)).to.equal(true)
      await fx.stub.connect(fx.recovery).lift(safe, ANY)

      // The attacker's queue is dead: old keys no longer sign, and the schedule was cleared anyway.
      await expectRevert(execOwner(fx, drain, thieves), fx.safe, 'InvalidSignatures')
      await expectRevert(scheduleOwner(fx, drain, thieves), fx.safe, 'InvalidSignatures')
      await expectPolicyError(
        execOwner(fx, drain, [fx.newOwner1, fx.o3]),
        fx.stub,
        fx.timelock,
        'ClearedByFreeze',
        [drainHash],
      )
      expect(await ethers.provider.getBalance(safe)).to.equal(parseEther('10'))
    })

    it('guardian compromised: the freeze lasts at most F, then a cooldown; owners remove the guardian', async () => {
      const fx = await loadFixture(story)
      const safe = await fx.safe.getAddress()
      const owners = [fx.o1, fx.o2]
      const pay = call(fx.target, '0x', parseEther('1'))

      // 0h: the rogue guardian freezes.
      await fx.stub.connect(fx.guardian).freeze([safe])
      const t0 = BigInt(await time.latest())

      // 1h: owners queue a payment; it can't run while frozen, and is void after (scheduled during).
      await time.increaseTo(t0 + BigInt(HOUR))
      const { hash: duringHash } = await scheduleOwner(fx, pay, owners)
      await time.increaseTo(t0 + BigInt(HOUR + T))
      await expectPolicyError(execOwner(fx, pay, owners), fx.stub, fx.freeze, 'Frozen', [
        safe,
        ANY,
        t0 + BigInt(F),
      ])

      // F: the freeze expires by itself, no extension.
      await time.increaseTo(t0 + BigInt(F) - 1n)
      expect((await fx.stub.freezeStatus(safe, OWNERS)).safeFrozen).to.equal(true)
      await time.increaseTo(t0 + BigInt(F))
      expect((await fx.stub.freezeStatus(safe, OWNERS)).safeFrozen).to.equal(false)
      await expectPolicyError(execOwner(fx, pay, owners), fx.stub, fx.timelock, 'ClearedByFreeze', [
        duringHash,
      ])

      // Cooldown: owners re-make the payment; re-freezing is skipped, so the schedule survives it.
      const { hash } = await scheduleOwner(fx, pay, owners)
      expect(hash).to.equal(duringHash)
      const freezeAgain = await fx.stub.connect(fx.guardian).freeze([safe])
      expect(await eventsOf(freezeAgain, fx.stub, 'Frozen')).to.have.length(0)

      // The guardian removal the owners requested during the freeze (config, DELAY ≤ F) is applied
      // once the freeze ended; the stub stands in for applyConfiguration.
      await fx.stub.setRole(safe, 0, fx.guardian.address, false)
      await time.increaseTo(t0 + BigInt(F + C))
      await expectRevert(fx.stub.connect(fx.guardian).freeze([safe]), fx.stub, 'NotGuardian', [safe])
      await time.increaseTo(t0 + BigInt(F + T) + 10n)
      await execOwner(fx, pay, owners)
      expect((await scheduleOf(fx, hash)).scheduledAt).to.equal(0n)
    })

    it('recovery key compromised: owners remove the recovery module within T < R', async () => {
      const fx = await loadFixture(story)
      const safe = await fx.safe.getAddress()
      const owners = [fx.o1, fx.o2]

      // 0h: the rogue recovery key queues an owner swap to itself (R = 72h).
      const takeover = call(
        safe,
        fx.safe.interface.encodeFunctionData('swapOwner', [OWNERS, fx.o1.address, fx.attacker.address]),
      )
      const { hash: takeoverHash } = await scheduleModule(fx, fx.recovery, takeover)
      const t0 = BigInt(await time.latest())

      // 1h: owners can't cancel recovery's queue; they queue the module's removal instead (T = 24h).
      await time.increaseTo(t0 + BigInt(HOUR))
      const stub = await fx.stub.getAddress()
      await expectRevert(
        fx.timelock
          .connect(fx.outsider)
          .cancelAsOwners(
            stub,
            safe,
            takeoverHash,
            await sign(await fx.timelock.cancelDigest(stub, safe, takeoverHash), [fx.o1, fx.o2, fx.o3]),
          ),
        fx.timelock,
        'NotOwnersQueue',
        [takeoverHash],
      )
      const removal = call(
        safe,
        fx.safe.interface.encodeFunctionData('disableModule', [OWNERS, fx.recovery.address]),
      )
      const { hash: removalHash } = await scheduleOwner(fx, removal, owners)

      // ~25h: the removal executes, well before R.
      await time.increaseTo((await scheduleOf(fx, removalHash)).readyAt)
      await execOwner(fx, removal, owners)
      expect(await fx.safe.isModuleEnabled(fx.recovery.address)).to.equal(false)

      // 72h: the takeover matured, but the module is gone.
      await time.increaseTo(t0 + BigInt(R))
      await expectRevert(execModule(fx, fx.recovery, takeover), fx.safe, 'ModuleNotEnabled', [
        fx.recovery.address,
      ])
      expect(await fx.safe.isOwner(fx.attacker.address)).to.equal(false)
    })
  })

  describe('engine-facing input checks', () => {
    const ctx = (safe: string, actor: string, txHash: string) => ({
      safe,
      actor,
      txHash,
      nonce: 0,
      executor: actor,
    })

    it('denies a schedule whose actor differs from the context (NotScheduled)', async () => {
      const fx = await loadFixture(deploy)
      const id = await attach(fx, scope(ANY), fx.timelock, tl(HOUR))
      const { hash } = await scheduleModule(fx, fx.ops, call(fx.target))
      await time.increase(HOUR)
      const safe = await fx.safe.getAddress()
      await expectRevert(
        fx.stub.callCheckTransaction(
          await fx.timelock.getAddress(),
          ctx(safe, fx.recovery.address, hash),
          [],
          [id],
        ),
        fx.timelock,
        'NotScheduled',
        [hash],
      )
      // Same inputs with the right actor pass and return the PASS selector.
      expect(
        await fx.stub.callCheckTransaction.staticCall(
          await fx.timelock.getAddress(),
          ctx(safe, fx.ops.address, hash),
          [],
          [id],
        ),
      ).to.equal('0xe18ffdca')
    })

    it('rejects a call-level check (WrongPolicyLevel) and an empty id list (NoAttachments)', async () => {
      const fx = await loadFixture(deploy)
      const safe = await fx.safe.getAddress()
      const c = ctx(safe, fx.ops.address, keccak256('0x03'))
      await expectRevert(
        fx.stub.callCheckCall(await fx.timelock.getAddress(), c, call(fx.target), [keccak256('0x04')]),
        fx.timelock,
        'WrongPolicyLevel',
      )
      await expectRevert(
        fx.stub.callCheckTransaction(await fx.timelock.getAddress(), c, [], []),
        fx.timelock,
        'NoAttachments',
      )
    })
  })
})
