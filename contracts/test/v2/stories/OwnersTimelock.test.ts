import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { guardsOf } from '../fixtures/safe'
import { expectAnyRevert, expectEvent } from '../helpers'
import {
  HOUR,
  Kind,
  OWNERS,
  SEL,
  T,
  type World,
  addrOf,
  allow,
  anyCall,
  attach,
  attachmentId,
  configureCall,
  deployWorld,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  expectPolicyError,
  impersonate,
  install,
  onContract,
  onFunction,
  ownerTxHash,
  safeCall,
  scheduleModule,
  scheduleOwners,
  signCancel,
  timelockSettings,
  transfer,
  usdc,
} from './world'

/**
 * Story: the owners' timelock cannot be skipped (WA-4014). Owners: Allow `(Owners, *)` +
 * Timelock(T = 24 h, guardian G) at `(Owners, *)`, and an exact Allow `(Owners, Safe.setGuard)`
 * that in V1 would have hidden the fallback timelock. Ops (module): Allow `(Ops, *)` +
 * Timelock(1 h) at `(Ops, *)`. Every matching scope runs, so the narrow Allow grants but the
 * Timelock at `(Owners, *)` still runs.
 */

async function world() {
  const w = await deployWorld()
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T, guardians: [w.guardian.address] })),
      allow(onFunction(OWNERS, w.safeAddress, SEL.setGuard)),
      allow(anyCall(w.ops.address)),
      attach(anyCall(w.ops.address), w.timelock, timelockSettings({ delay: HOUR })),
    ],
    { modules: [w.ops.address] },
  )
  return w
}

const ownersTimelockId = (w: World) => attachmentId(anyCall(OWNERS), Kind.POLICY, addrOf(w.timelock))

/** NotScheduled, then NotReady after scheduling, then it executes after T. */
async function waitsT(w: World, tx: ReturnType<typeof safeCall>) {
  const hash = await ownerTxHash(w, tx)
  await expectPolicyDenied(execOwners(w, tx), w, w.timelock, 'NotScheduled', [hash])
  await scheduleOwners(w, tx)
  await expectPolicyDenied(execOwners(w, tx), w, w.timelock, 'NotReady')
  await time.increase(T)
  await execOwners(w, tx)
}

describe('Story: the owners wait T for everything, configuration included (WA-4014)', () => {
  it('setGuard(0) waits T although an exact Allow (Owners, Safe.setGuard) exists', async () => {
    const w = await loadFixture(world)
    await waitsT(w, safeCall(w, 'setGuard', [ZeroAddress]))
    expect((await guardsOf(w.safe)).guard).to.equal(ZeroAddress)
  })

  it('addOwnerWithThreshold waits T', async () => {
    const w = await loadFixture(world)
    await waitsT(w, safeCall(w, 'addOwnerWithThreshold', [w.newOwner1.address, 2]))
    expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
  })

  it('configure waits T: the implicit grant does not skip the owners Timelock', async () => {
    const w = await loadFixture(world)
    await waitsT(w, configureCall(w, [allow(onFunction(OWNERS, w.tokenAddress, SEL.transfer))]))
    const [exists] = await w.engine.getAttachment(
      w.safeAddress,
      attachmentId(onFunction(OWNERS, w.tokenAddress, SEL.transfer), Kind.ALLOW),
    )
    expect(exists).to.equal(true)
  })

  it('a plain payment waits T too', async () => {
    const w = await loadFixture(world)
    await waitsT(w, transfer(w, w.vendorA.address, usdc(1)))
  })

  describe('schedules are bound to the Safe nonce', () => {
    it('two schedules at nonces n and n + 1 execute in order after T', async () => {
      const w = await loadFixture(world)
      const n = await w.safe.nonce()
      const a = { ...transfer(w, w.vendorA.address, usdc(1)), nonce: n }
      const b = { ...transfer(w, w.vendorB.address, usdc(2)), nonce: n + 1n }
      await scheduleOwners(w, a)
      await scheduleOwners(w, b)
      await time.increase(T)
      await execOwners(w, a)
      await execOwners(w, b)
      expect(await w.token.balanceOf(w.vendorB.address)).to.equal(usdc(2))
    })

    it('a schedule dies when another transaction uses its nonce', async () => {
      const w = await loadFixture(world)
      const n = await w.safe.nonce()
      const a = { ...transfer(w, w.vendorA.address, usdc(1)), nonce: n }
      const other = { ...transfer(w, w.vendorB.address, usdc(1)), nonce: n }
      await scheduleOwners(w, a)
      await scheduleOwners(w, other)
      await time.increase(T)
      await execOwners(w, other)
      // `a` at the next nonce is a different Safe transaction hash: never scheduled.
      await expectPolicyDenied(
        execOwners(w, transfer(w, w.vendorA.address, usdc(1))),
        w,
        w.timelock,
        'NotScheduled',
      )
    })

    it('scheduling at a used nonce is refused (StaleNonce)', async () => {
      const w = await loadFixture(world)
      const n = await w.safe.nonce()
      await expectPolicyError(
        scheduleOwners(w, { ...transfer(w, w.vendorA.address, 1n), nonce: n - 1n }),
        w.timelock,
        'StaleNonce',
        [n - 1n, n],
      )
    })
  })

  describe('cancelling', () => {
    it('the owners cancel their own schedule with threshold signatures (cancelAsOwners)', async () => {
      const w = await loadFixture(world)
      const tx = transfer(w, w.attacker.address, usdc(50_000))
      const hash = await scheduleOwners(w, tx)
      const sigs = await signCancel(w, hash, w.quorum)
      const cancel = await w.timelock
        .connect(w.stranger)
        .cancelAsOwners(w.engineAddress, w.safeAddress, hash, sigs)
      await expectEvent(cancel, w.timelock, 'Cancelled', [
        w.engineAddress,
        w.safeAddress,
        hash,
        w.safeAddress,
      ])
      await time.increase(T)
      await expectPolicyDenied(execOwners(w, tx), w, w.timelock, 'NotScheduled', [hash])
    })

    it('one owner signature is not enough (threshold 2)', async () => {
      const w = await loadFixture(world)
      const hash = await scheduleOwners(w, transfer(w, w.vendorA.address, 1n))
      const sigs = await signCancel(w, hash, [w.o1])
      await expectAnyRevert(w.timelock.cancelAsOwners(w.engineAddress, w.safeAddress, hash, sigs))
      expect((await w.timelock.getSchedule(w.engineAddress, w.safeAddress, hash)).scheduledAt).to.not.equal(
        0n,
      )
    })

    it('the owners cannot cancel a module schedule this way (NotOwnersQueue)', async () => {
      const w = await loadFixture(world)
      const hash = await scheduleModule(w, w.ops, transfer(w, w.vendorA.address, 1n))
      const sigs = await signCancel(w, hash, w.quorum)
      await expectPolicyError(
        w.timelock.cancelAsOwners(w.engineAddress, w.safeAddress, hash, sigs),
        w.timelock,
        'NotOwnersQueue',
        [hash],
      )
    })

    it('a guardian cannot cancel (NotCanceller): it is not a canceller unless listed', async () => {
      const w = await loadFixture(world)
      const hash = await scheduleOwners(w, transfer(w, w.vendorA.address, 1n))
      await expectPolicyError(
        w.timelock.connect(w.guardian).cancel(w.engineAddress, w.safeAddress, hash),
        w.timelock,
        'NotCanceller',
        [w.guardian.address],
      )
    })
  })

  describe('a Timelock always protects its own removal (TimelockNotCoveringConfiguration)', () => {
    /** The revert reason of `IPolicy.configure` inside the engine's `PolicyConfigurationFailed`. */
    async function configureFailsWith(w: World, change: ReturnType<typeof attach>[], name: string) {
      const asSafe = await impersonate(w.safeAddress)
      const data = await expectEngineError(
        w.engine.connect(asSafe).configure.staticCall(change),
        w,
        'PolicyConfigurationFailed',
      )
      const outer = w.engine.interface.parseError(data)!
      expect(outer.args.policy).to.equal(addrOf(w.timelock))
      expect(w.timelock.interface.parseError(outer.args.reason)?.name).to.equal(name)
    }

    it('a narrow (Owners, token.*) Timelock longer than the covering one is rejected', async () => {
      const w = await loadFixture(world)
      const narrow = attach(
        onContract(OWNERS, w.tokenAddress),
        w.timelock,
        timelockSettings({ delay: 2n * T }),
      )
      await configureFailsWith(w, [narrow], 'TimelockNotCoveringConfiguration')
      // As an owner transaction it is scheduled, waits T, and then fails as a whole.
      const tx = configureCall(w, [narrow])
      await scheduleOwners(w, tx)
      await time.increase(T)
      await expectAnyRevert(execOwners(w, tx))
      // One no longer than the covering delay is accepted.
      const ok = attach(onContract(OWNERS, w.tokenAddress), w.timelock, timelockSettings({ delay: T }))
      const asSafe = await impersonate(w.safeAddress)
      await w.engine.connect(asSafe).configure.staticCall([ok])
    })

    it('with no covering Timelock at all, a narrow owners Timelock is rejected; with one first in the same change list it passes', async () => {
      const w = await deployWorld()
      await install(w, [allow(anyCall(OWNERS))])
      const narrow = attach(onContract(OWNERS, w.tokenAddress), w.timelock, timelockSettings({ delay: T }))
      await configureFailsWith(w, [narrow], 'TimelockNotCoveringConfiguration')
      await expectAnyRevert(execOwners(w, configureCall(w, [narrow])))
      const covering = attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T }))
      await execOwners(w, configureCall(w, [covering, narrow]))
      const [exists] = await w.engine.getAttachment(
        w.safeAddress,
        attachmentId(onContract(OWNERS, w.tokenAddress), Kind.POLICY, addrOf(w.timelock)),
      )
      expect(exists).to.equal(true)
    })

    it('a module actor Timelock is exempt (the owners remove it through their own delay)', async () => {
      const w = await loadFixture(world)
      const opsNarrow = attach(
        onContract(w.ops.address, w.tokenAddress),
        w.timelock,
        timelockSettings({ delay: 10n * T }),
      )
      const asSafe = await impersonate(w.safeAddress)
      await w.engine.connect(asSafe).configure.staticCall([opsNarrow])
    })
  })

  it('the guardian freezes the owners at once; the frozen check comes before the schedule check', async () => {
    const w = await loadFixture(world)
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [ownersTimelockId(w)])
    await expectPolicyDenied(
      execOwners(w, transfer(w, w.vendorA.address, 1n)),
      w,
      w.timelock,
      'AttachmentFrozen',
    )
    // The module path is a different attachment: not frozen.
    const tx = transfer(w, w.vendorA.address, 1n)
    await scheduleModule(w, w.ops, tx)
    await time.increase(HOUR)
    await execModule(w, w.ops, tx)
  })
})
