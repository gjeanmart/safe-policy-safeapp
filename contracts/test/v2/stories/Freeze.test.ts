import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import type { Interface } from 'ethers'
import { eventsOf, expectEvent } from '../helpers'
import {
  C,
  DAY,
  F,
  HOUR,
  Kind,
  OWNERS,
  R,
  SEL,
  SENTINEL,
  T,
  type World,
  addrOf,
  allow,
  anyCall,
  attach,
  attachmentId,
  batchTx,
  call,
  configureCall,
  deployWorld,
  detach,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  expectPolicyError,
  install,
  onFunction,
  scheduleModule,
  scheduleOwners,
  signCancel,
  swapOwnerCall,
  timelockSettings,
  transfer,
  usdc,
} from './world'

/**
 * Story: the freeze timelines of SPEC §5.1 with the deployed parameters T = 24 h (owners), R =
 * 72 h (recovery), F = 7 d (longest freeze), C = 12 h (cooldown); T < R < F.
 * Owners: Allow `(Owners, *)` + Timelock(T, guardian G, lifter Recovery) at `(Owners, *)`.
 * Recovery (module): Allow `(Recovery, Safe.swapOwner)` + Timelock(R, window 7 d) at
 * `(Recovery, *)`, no guardian: nothing can freeze it.
 */

async function world() {
  const w = await deployWorld()
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      attach(
        anyCall(OWNERS),
        w.timelock,
        timelockSettings({ delay: T, guardians: [w.guardian.address], lifters: [w.recovery.address] }),
      ),
      allow(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner)),
      attach(anyCall(w.recovery.address), w.timelock, timelockSettings({ delay: R, window: 7n * DAY })),
    ],
    { modules: [w.recovery.address] },
  )
  return w
}

const ownersId = (w: World) => attachmentId(anyCall(OWNERS), Kind.POLICY, addrOf(w.timelock))
const freezeOwners = (w: World, guardian = w.guardian) =>
  w.timelock.connect(guardian).freeze(w.engineAddress, w.safeAddress, [ownersId(w)])

/** Recovery's batch replacing two owners: [o1 -> a, o2 -> b] (owner list [o1, o2, o3]). */
function replaceTwoOwners(w: World, a: string, b: string) {
  const iface = w.safe.interface as Interface
  return batchTx(w, [
    call(w.safeAddress, iface.encodeFunctionData('swapOwner', [SENTINEL, w.o1.address, a])),
    call(w.safeAddress, iface.encodeFunctionData('swapOwner', [a, w.o2.address, b])),
  ])
}

/** The owners' Timelock settings with guardian G replaced by G2. */
const replaceGuardian = (w: World) =>
  configureCall(w, [
    attach(
      anyCall(OWNERS),
      w.timelock,
      timelockSettings({ delay: T, guardians: [w.guardian2.address], lifters: [w.recovery.address] }),
    ),
  ])

describe('Story: freeze timelines (T 24 h < R 72 h < F 7 d, C 12 h)', () => {
  it('owner keys compromised: G freezes, recovery replaces the owners within R < F, the new owners cancel the attacker configuration, the attacker queue is void', async () => {
    const w = await loadFixture(world)
    // The attacker holds o1 and o2 (the threshold) and queues a drain and the removal of the Timelock.
    const n = await w.safe.nonce()
    const drain = { ...transfer(w, w.attacker.address, usdc(100_000)), nonce: n }
    const escape = { ...configureCall(w, [detach(anyCall(OWNERS), Kind.POLICY, w.timelock)]), nonce: n + 1n }
    await scheduleOwners(w, drain)
    const escapeHash = await scheduleOwners(w, escape)
    // G sees the Scheduled events and freezes the owners; recovery starts at once.
    await freezeOwners(w)
    const swaps = replaceTwoOwners(w, w.newOwner1.address, w.newOwner2.address)
    await scheduleModule(w, w.recovery, swaps)

    await time.increase(T)
    await expectPolicyDenied(execOwners(w, drain), w, w.timelock, 'AttachmentFrozen')

    await time.increase(R - T)
    const [frozenUntil] = await w.timelock.freezeState(w.engineAddress, w.safeAddress, ownersId(w))
    expect(BigInt(await time.latest()) < frozenUntil, 'R < F: still frozen').to.equal(true)
    await execModule(w, w.recovery, swaps)
    expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
    expect(await w.safe.isOwner(w.o2.address)).to.equal(false)

    // The attacker's configuration schedule survives a freeze: the new owners cancel it.
    const newOwners = [w.newOwner1, w.newOwner2]
    await w.timelock.cancelAsOwners(
      w.engineAddress,
      w.safeAddress,
      escapeHash,
      await signCancel(w, escapeHash, newOwners),
    )
    expect((await w.timelock.getSchedule(w.engineAddress, w.safeAddress, escapeHash)).scheduledAt).to.equal(
      0n,
    )

    // Recovery lifts. The drain (same hash whoever signs it) was queued before the freeze ended: void.
    await w.timelock.connect(w.recovery).lift(w.engineAddress, w.safeAddress, ownersId(w))
    await expectPolicyDenied(execOwners(w, drain, newOwners), w, w.timelock, 'VoidedByFreeze')
    expect(await w.token.balanceOf(w.safeAddress)).to.equal(usdc(100_000))
  })

  it('guardian compromised: the owners replace G with a configure scheduled during the freeze, executed in the cooldown; G cannot re-freeze', async () => {
    const w = await loadFixture(world)
    await freezeOwners(w)
    const fix = replaceGuardian(w)
    await scheduleOwners(w, fix)
    await time.increase(T)
    await expectPolicyDenied(execOwners(w, fix), w, w.timelock, 'AttachmentFrozen')

    const [frozenUntil, cooldownUntil] = await w.timelock.freezeState(
      w.engineAddress,
      w.safeAddress,
      ownersId(w),
    )
    expect(cooldownUntil - frozenUntil).to.equal(C)
    await time.increaseTo(frozenUntil)
    // In the cooldown G's new freeze is skipped, not extended.
    const again = await freezeOwners(w)
    await expectEvent(again, w.timelock, 'FreezeSkipped', [
      w.engineAddress,
      w.safeAddress,
      ownersId(w),
      w.guardian.address,
      cooldownUntil,
    ])
    expect(await eventsOf(again, w.timelock, 'Frozen')).to.have.length(0)
    // The configure schedule was made during the freeze, yet it is not void (configuration exemption).
    await execOwners(w, fix)
    expect(BigInt(await time.latest()) < cooldownUntil, 'executed within F + C').to.equal(true)
    await expectPolicyError(freezeOwners(w), w.timelock, 'NotGuardian', [ownersId(w)])
    expect(
      (await w.timelock.getSettings(w.engineAddress, w.safeAddress, ownersId(w))).guardians,
    ).to.deep.equal([w.guardian2.address])
  })

  it('guardian compromised, with recovery as lifter: the owners get out after T instead of F', async () => {
    const w = await loadFixture(world)
    await freezeOwners(w)
    const fix = replaceGuardian(w)
    await scheduleOwners(w, fix)
    await w.timelock.connect(w.recovery).lift(w.engineAddress, w.safeAddress, ownersId(w))
    await time.increase(T)
    await execOwners(w, fix)
  })

  it('recovery key compromised: it must wait R in the open; the owners detach it after T < R', async () => {
    const w = await loadFixture(world)
    const swaps = replaceTwoOwners(w, w.attacker.address, w.stranger.address)
    await scheduleModule(w, w.recovery, swaps)
    const removal = configureCall(w, [
      detach(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner), Kind.ALLOW),
      detach(anyCall(w.recovery.address), Kind.POLICY, w.timelock),
    ])
    await scheduleOwners(w, removal)
    await time.increase(T)
    await execOwners(w, removal)
    await time.increase(R - T)
    await expectEngineError(execModule(w, w.recovery, swaps), w, 'NotGranted')
  })

  it('two colluding (guardian + recovery key): lost, as documented; the owners frozen cannot detach recovery in time', async () => {
    const w = await loadFixture(world)
    await freezeOwners(w)
    const swaps = replaceTwoOwners(w, w.attacker.address, w.stranger.address)
    await scheduleModule(w, w.recovery, swaps)
    const removal = configureCall(w, [
      detach(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner), Kind.ALLOW),
    ])
    await scheduleOwners(w, removal)
    await time.increase(T)
    await expectPolicyDenied(execOwners(w, removal), w, w.timelock, 'AttachmentFrozen')
    await time.increase(R - T)
    await execModule(w, w.recovery, swaps)
    expect(await w.safe.isOwner(w.attacker.address)).to.equal(true)
    expect(await w.safe.isOwner(w.stranger.address)).to.equal(true)
  })

  it("the owners' queue is void after a freeze, but a scheduled configure is exempt", async () => {
    const w = await loadFixture(world)
    const n = await w.safe.nonce()
    const pay = { ...transfer(w, w.vendorA.address, usdc(1)), nonce: n }
    const conf = { ...configureCall(w, [allow(onFunction(OWNERS, w.tokenAddress, SEL.transfer))]), nonce: n }
    const payHash = await scheduleOwners(w, pay)
    await scheduleOwners(w, conf)
    await time.increase(HOUR)
    await freezeOwners(w)
    await time.increase(F)
    await expectPolicyDenied(execOwners(w, pay), w, w.timelock, 'VoidedByFreeze', [payHash, ownersId(w)])
    await execOwners(w, conf)
    // A voided schedule can be replaced, and then waits T again.
    const pay2 = transfer(w, w.vendorA.address, usdc(1))
    await scheduleOwners(w, pay2)
    await expectPolicyDenied(execOwners(w, pay2), w, w.timelock, 'NotReady')
  })

  it('a lift starts the cooldown at once; a freeze during C is skipped; after C the guardian can freeze again', async () => {
    const w = await loadFixture(world)
    await freezeOwners(w)
    const lift = await w.timelock.connect(w.recovery).lift(w.engineAddress, w.safeAddress, ownersId(w))
    const cooldownUntil = BigInt(await time.latest()) + C
    await expectEvent(lift, w.timelock, 'Lifted', [
      w.engineAddress,
      w.safeAddress,
      ownersId(w),
      w.recovery.address,
      cooldownUntil,
    ])
    await expectEvent(await freezeOwners(w), w.timelock, 'FreezeSkipped')
    await time.increaseTo(cooldownUntil)
    await expectEvent(await freezeOwners(w), w.timelock, 'Frozen')
    await expectPolicyError(
      w.timelock.connect(w.stranger).lift(w.engineAddress, w.safeAddress, ownersId(w)),
      w.timelock,
      'NotGuardianOrLifter',
      [ownersId(w)],
    )
  })

  it('lifting what is not frozen reverts (NotFrozen); a freeze ends by itself after F', async () => {
    const w = await loadFixture(world)
    await expectPolicyError(
      w.timelock.connect(w.guardian).lift(w.engineAddress, w.safeAddress, ownersId(w)),
      w.timelock,
      'NotFrozen',
      [ownersId(w)],
    )
    await freezeOwners(w)
    await time.increase(F)
    const tx = transfer(w, w.vendorA.address, 1n)
    await scheduleOwners(w, tx)
    await time.increase(T)
    await execOwners(w, tx)
  })

  it('one guardian on two attachments matching the owners configure cannot chain freezes: the configure runs when its window ends (rev 3 review P3)', async () => {
    const w = await deployWorld()
    const G = [w.guardian.address]
    const all = anyCall(OWNERS)
    const cfg = onFunction(OWNERS, w.engineAddress, SEL.configure)
    await install(w, [
      allow(all),
      attach(all, w.timelock, timelockSettings({ delay: T, guardians: G })),
      attach(cfg, w.timelock, timelockSettings({ delay: T, guardians: G })),
    ])
    const idA = attachmentId(all, Kind.POLICY, addrOf(w.timelock))
    const idB = attachmentId(cfg, Kind.POLICY, addrOf(w.timelock))
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [idA])
    // The owners schedule their way out: both attachments without G (exempt from voiding).
    const out = configureCall(w, [
      attach(all, w.timelock, timelockSettings({ delay: T })),
      attach(cfg, w.timelock, timelockSettings({ delay: T })),
    ])
    await scheduleOwners(w, out)
    // Just before A thaws, G freezes B: B joins G's window and thaws with A.
    const [until] = await w.timelock.freezeState(w.engineAddress, w.safeAddress, idA)
    await time.increaseTo(until - 60n)
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [idB])
    expect((await w.timelock.freezeState(w.engineAddress, w.safeAddress, idB))[0]).to.equal(until)
    await time.increaseTo(until)
    // G is now cooling down in this Safe: nothing it freezes sticks, and the owners get out.
    const again = await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [idA, idB])
    expect(await eventsOf(again, w.timelock, 'Frozen')).to.have.length(0)
    await execOwners(w, out)
    expect((await w.timelock.getSettings(w.engineAddress, w.safeAddress, idA)).guardians).to.deep.equal([])
    expect(BigInt(await time.latest()) - until < C, 'out within F + C of the first freeze').to.equal(true)
  })

  it('two colluding guardians can chain their windows: the owners wait up to 2F (documented)', async () => {
    const w = await deployWorld()
    const all = anyCall(OWNERS)
    const cfg = onFunction(OWNERS, w.engineAddress, SEL.configure)
    await install(w, [
      allow(all),
      attach(all, w.timelock, timelockSettings({ delay: T, guardians: [w.guardian.address] })),
      attach(cfg, w.timelock, timelockSettings({ delay: T, guardians: [w.guardian2.address] })),
    ])
    const idA = attachmentId(all, Kind.POLICY, addrOf(w.timelock))
    const idB = attachmentId(cfg, Kind.POLICY, addrOf(w.timelock))
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [idA])
    const out = configureCall(w, [
      attach(all, w.timelock, timelockSettings({ delay: T })),
      attach(cfg, w.timelock, timelockSettings({ delay: T })),
    ])
    await scheduleOwners(w, out)
    const [untilA] = await w.timelock.freezeState(w.engineAddress, w.safeAddress, idA)
    await time.increaseTo(untilA - 60n)
    await w.timelock.connect(w.guardian2).freeze(w.engineAddress, w.safeAddress, [idB])
    const [untilB] = await w.timelock.freezeState(w.engineAddress, w.safeAddress, idB)
    await time.increaseTo(untilA)
    await expectPolicyDenied(execOwners(w, out), w, w.timelock, 'AttachmentFrozen')
    // G is cooling down; G2 cannot extend B; B thaws and the owners get out.
    await time.increaseTo(untilB)
    await execOwners(w, out)
  })

  it('a detach and re-attach of the same id keeps its freeze state: it never shortens a freeze or a cooldown (rev 3 review fable P5, documented)', async () => {
    const w = await deployWorld()
    const tl = timelockSettings({ delay: 0, guardians: [w.guardian.address], lifters: [w.recovery.address] })
    const ops = anyCall(w.ops.address)
    await install(
      w,
      [allow(onFunction(w.ops.address, w.tokenAddress, SEL.transfer)), attach(ops, w.timelock, tl)],
      {
        modules: [w.ops.address],
      },
    )
    const id = attachmentId(ops, Kind.POLICY, addrOf(w.timelock))
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [id])
    // Re-attaching while frozen does not unfreeze the ops actor.
    await execOwners(w, configureCall(w, [detach(ops, Kind.POLICY, w.timelock), attach(ops, w.timelock, tl)]))
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.vendorA.address, 1n)),
      w,
      w.timelock,
      'AttachmentFrozen',
    )
    await w.timelock.connect(w.recovery).lift(w.engineAddress, w.safeAddress, id)
    // Nor does it reset the cooldown: the guardian's next freeze is skipped.
    await execOwners(w, configureCall(w, [detach(ops, Kind.POLICY, w.timelock), attach(ops, w.timelock, tl)]))
    const skipped = await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [id])
    expect(await eventsOf(skipped, w.timelock, 'FreezeSkipped')).to.have.length(1)
    expect(await eventsOf(skipped, w.timelock, 'Frozen')).to.have.length(0)
  })

  it('recovery has no guardian: nothing can freeze it (NotGuardian)', async () => {
    const w = await loadFixture(world)
    const recoveryId = attachmentId(anyCall(w.recovery.address), Kind.POLICY, addrOf(w.timelock))
    await expectPolicyError(
      w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [recoveryId]),
      w.timelock,
      'NotGuardian',
      [recoveryId],
    )
    const swap = await swapOwnerCall(w, w.o3.address, w.newOwner1.address)
    await scheduleModule(w, w.recovery, swap)
    await freezeOwners(w)
    await time.increase(R)
    await execModule(w, w.recovery, swap)
  })
})
