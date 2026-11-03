import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { expectEvent } from '../helpers'
import {
  ANY,
  DAY,
  HOUR,
  Kind,
  OWNERS,
  R,
  SEL,
  T,
  type Change,
  type World,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  attachmentId,
  configureCall,
  deployWorld,
  detach,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  expectPolicyError,
  install,
  onContract,
  onFunction,
  recipientsPreset,
  scheduleModule,
  scheduleOwners,
  signCancel,
  swapOwnerCall,
  timelockSettings,
  transfer,
  usdc,
} from './world'

/**
 * Story: recovery is its own actor (WA-4016). Owners: Allow `(Owners, *)` + Timelock(T, guardian
 * G, lifter Recovery) at `(Owners, *)`. Recovery (module): Allow `(Recovery, Safe.swapOwner)` +
 * Timelock(R = 72 h, window 7 d) at `(Recovery, *)`. A payment allowlist written for the
 * owners or for everyone never reaches recovery's `swapOwner`, because the actor and the
 * function are part of every scope key.
 */

const WINDOW = 7n * DAY

function baseChanges(w: World): Change[] {
  return [
    allow(anyCall(OWNERS)),
    attach(
      anyCall(OWNERS),
      w.timelock,
      timelockSettings({ delay: T, guardians: [w.guardian.address], lifters: [w.recovery.address] }),
    ),
    allow(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner)),
    attach(anyCall(w.recovery.address), w.timelock, timelockSettings({ delay: R, window: WINDOW })),
  ]
}

async function installWith(extra: (w: World) => Change[]) {
  const w = await deployWorld()
  await install(w, [...baseChanges(w), ...extra(w)], { modules: [w.recovery.address] })
  return w
}

const world = () => installWith(() => [])

/** Recovery schedules `swapOwner(o1 -> newOwner1)`, waits R and executes it. */
async function recoverAfterR(w: World) {
  const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
  await scheduleModule(w, w.recovery, swap)
  await expectPolicyDenied(execModule(w, w.recovery, swap), w, w.timelock, 'NotReady')
  await time.increase(R)
  await execModule(w, w.recovery, swap)
  expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
  expect(await w.safe.isOwner(w.o1.address)).to.equal(false)
}

describe('Story: recovery replaces an owner after R, and a payment allowlist never blocks it (WA-4016)', () => {
  it('recovery waits R, then swaps an owner', async () => {
    const w = await loadFixture(world)
    await recoverAfterR(w)
  })

  it('recovery without a schedule is denied (NotScheduled), and after the window it has expired', async () => {
    const w = await loadFixture(world)
    const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
    await expectPolicyDenied(execModule(w, w.recovery, swap), w, w.timelock, 'NotScheduled')
    await scheduleModule(w, w.recovery, swap)
    await time.increase(R + WINDOW + HOUR)
    await expectPolicyDenied(execModule(w, w.recovery, swap), w, w.timelock, 'ScheduleExpired')
    // An expired schedule can be replaced.
    await scheduleModule(w, w.recovery, swap)
    await time.increase(R)
    await execModule(w, w.recovery, swap)
  })

  it('recovery can only swap owners: any other call is NotGranted', async () => {
    const w = await loadFixture(world)
    await expectEngineError(
      execModule(w, w.recovery, transfer(w, w.recovery.address, usdc(1))),
      w,
      'NotGranted',
    )
  })

  describe('payment allowlists next to recovery', () => {
    it('Recipients strict at (ANY, USDC.*): recovery still completes after R', async () => {
      const w = await installWith((w) => [
        attach(
          onContract(ANY, w.tokenAddress),
          w.args,
          argsSettings(recipientsPreset([w.vendorA.address]), true),
        ),
      ])
      await recoverAfterR(w)
    })

    it('Recipients non-strict at (ANY, *): recovery still completes after R', async () => {
      const w = await installWith((w) => [
        attach(anyCall(ANY), w.args, argsSettings(recipientsPreset([w.vendorA.address]), false)),
      ])
      await recoverAfterR(w)
    })

    it('Recipients strict at (Owners, *): recovery still completes after R', async () => {
      const w = await installWith((w) => [
        attach(anyCall(OWNERS), w.args, argsSettings(recipientsPreset([w.vendorA.address]), true)),
      ])
      await recoverAfterR(w)
    })

    it('what to avoid: Recipients strict at (ANY, *) denies every other call, recovery included (NoConstraint)', async () => {
      const w = await installWith((w) => [
        attach(anyCall(ANY), w.args, argsSettings(recipientsPreset([w.vendorA.address]), true)),
      ])
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      await scheduleModule(w, w.recovery, swap)
      await time.increase(R)
      await expectPolicyDenied(execModule(w, w.recovery, swap), w, w.args, 'NoConstraint')
    })
  })

  it('the owners detach a rogue recovery within T, before its R is over', async () => {
    const w = await loadFixture(world)
    const swap = await swapOwnerCall(w, w.o1.address, w.attacker.address)
    await scheduleModule(w, w.recovery, swap)
    const removal = configureCall(w, [
      detach(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner), Kind.ALLOW),
      detach(anyCall(w.recovery.address), Kind.POLICY, w.timelock),
    ])
    await scheduleOwners(w, removal)
    await time.increase(T)
    await execOwners(w, removal)
    await time.increase(R - T)
    await expectEngineError(execModule(w, w.recovery, swap), w, 'NotGranted')
    expect(await w.safe.isOwner(w.attacker.address)).to.equal(false)
  })

  it("the owners cannot cancel recovery's schedule with their signatures (NotOwnersQueue)", async () => {
    const w = await loadFixture(world)
    const hash = await scheduleModule(
      w,
      w.recovery,
      await swapOwnerCall(w, w.o1.address, w.newOwner1.address),
    )
    await expectPolicyError(
      w.timelock.cancelAsOwners(w.engineAddress, w.safeAddress, hash, await signCancel(w, hash, w.quorum)),
      w.timelock,
      'NotOwnersQueue',
      [hash],
    )
  })

  it("recovery is a lifter of the owners' attachment: it ends a guardian's freeze at once", async () => {
    const w = await loadFixture(world)
    const ownersId = attachmentId(anyCall(OWNERS), Kind.POLICY, addrOf(w.timelock))
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [ownersId])
    await expectPolicyDenied(
      execOwners(w, transfer(w, w.vendorA.address, 1n)),
      w,
      w.timelock,
      'AttachmentFrozen',
    )
    const lift = await w.timelock.connect(w.recovery).lift(w.engineAddress, w.safeAddress, ownersId)
    await expectEvent(lift, w.timelock, 'Lifted')
    // Lifted, the owners' own Timelock applies again: NotScheduled, not AttachmentFrozen.
    await expectPolicyDenied(execOwners(w, transfer(w, w.vendorA.address, 1n)), w, w.timelock, 'NotScheduled')
    // A lifter cannot freeze.
    await expectPolicyError(
      w.timelock.connect(w.recovery).freeze(w.engineAddress, w.safeAddress, [ownersId]),
      w.timelock,
      'NotGuardian',
      [ownersId],
    )
  })
})
