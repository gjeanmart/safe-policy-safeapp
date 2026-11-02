import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import { multiSendTx } from '../fixtures/safe'
import { eventsOf } from '../helpers'
import {
  ANY,
  C,
  DELAY,
  F,
  HOUR,
  OWNERS,
  R,
  T,
  applyConfig,
  call,
  deployOrg,
  ethSign,
  execModule,
  execOwners,
  expectError,
  expectPolicyDenied,
  expectSafeError,
  guardianRole,
  requestConfig,
  safeCall,
  scheduleModule,
  scheduleOwners,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/**
 * Story: the three compromise timelines of the design doc (§2.6, §4) on the real engine, with
 * T = 24h (owners) < R = 72h (recovery) < F = 7d (maximum freeze), cooldown C = 12h and the
 * configuration DELAY = T. Any single compromised key loses; WP3 ran these against a stub.
 */
describe('E2E story: compromise timelines (T < R < F)', () => {
  it('the deployment orders the delays: T ≤ DELAY, T < R < F, C < T', async () => {
    const w = await loadFixture(deployOrg)
    expect(await w.engine.DELAY()).to.equal(DELAY)
    expect(await w.engine.MAX_FREEZE()).to.equal(F)
    expect(await w.engine.FREEZE_COOLDOWN()).to.equal(C)
    expect(T <= DELAY && T < R && R < F && C < T).to.equal(true)
  })

  /** Recovery's two owner swaps (o1 → new1, then o2 → new2) as one MultiSend batch: one schedule. */
  async function recoveryBatch(w: World) {
    const swap1 = safeCall(w, 'swapOwner', [OWNERS, w.o1.address, w.newOwner1.address])
    const swap2 = safeCall(w, 'swapOwner', [w.newOwner1.address, w.o2.address, w.newOwner2.address])
    return multiSendTx(await w.infra.multiSendCallOnly.getAddress(), [swap1, swap2])
  }

  it('owner keys compromised: the guardian freezes, recovery replaces the owners after R', async () => {
    const w = await loadFixture(deployOrg)
    const thieves = [w.o1, w.o2] // enough for the 2-of-3 threshold
    const t0 = BigInt(await time.latest())

    // 0h: the attacker requests a configuration that drops the guardian, and queues a drain.
    const dropGuardian = [guardianRole(w.guardian.address, false)]
    await requestConfig(w, [], dropGuardian, thieves)
    const drain = tokenTransfer(w, w.attacker.address, usdc(100_000))
    const drainHash = await scheduleOwners(w, drain, thieves)

    // 2h: monitoring sees Scheduled and ConfigRequested; the guardian freezes the Safe.
    await time.increaseTo(t0 + 2n * HOUR)
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    const frozenUntil = (await w.engine.getFreezeState(w.safeAddress, ANY)).frozenUntil

    // 4h: recovery queues the owner swaps (module path, R = 72h), one schedule for the batch.
    await time.increaseTo(t0 + 4n * HOUR)
    const recovery = await recoveryBatch(w)
    const recoveryHash = await scheduleModule(w, w.recovery, recovery)

    // 24h: the drain matured and the configuration is valid, but the freeze denies both.
    await time.increaseTo(t0 + T + 1n)
    await expectPolicyDenied(execOwners(w, drain, thieves), w.engine, w.freeze, 'Frozen', [
      w.safeAddress,
      ANY,
      frozenUntil,
    ])
    await expectError(applyConfig(w, [], dropGuardian, thieves), w.engine, 'ConfigFrozen', [frozenUntil])
    await expectPolicyDenied(execModule(w, w.recovery, recovery), w.engine, w.timelock, 'NotReady')

    // 76h: recovery replaces both owners through the fire exit (no Freeze on it), then lifts.
    const s = await w.timelock.getSchedule(w.engineAddress, w.safeAddress, recoveryHash)
    const ready = s.scheduledAt + R
    expect(s.readyAt).to.equal(ready)
    await time.increaseTo(ready)
    await execModule(w, w.recovery, recovery)
    expect(await w.safe.isOwner(w.o1.address)).to.equal(false)
    expect(await w.safe.isOwner(w.o2.address)).to.equal(false)
    expect(await w.safe.isOwner(w.newOwner2.address)).to.equal(true)
    await w.engine.connect(w.recovery).lift(w.safeAddress, ANY)

    // The attacker's queue is dead: old keys no longer sign; the new owners can't reuse it either.
    await expectSafeError(execOwners(w, drain, thieves), 'GS026')
    await expectPolicyDenied(
      execOwners(w, drain, [w.newOwner1, w.o3]),
      w.engine,
      w.timelock,
      'ClearedByFreeze',
      [drainHash],
    )
    expect(await w.token.balanceOf(w.safeAddress)).to.equal(usdc(100_000))
    // The new owners drop the stale configuration request.
    await execOwners(
      w,
      call(
        w.engineAddress,
        w.engine.interface.encodeFunctionData('invalidateRoot', [
          await w.engine.configurationRoot([], dropGuardian),
        ]),
      ),
      [w.newOwner1, w.o3],
    )
  })

  it('guardian compromised: the freeze lasts at most F, then a cooldown; owners remove the guardian', async () => {
    const w = await loadFixture(deployOrg)
    const pay = tokenTransfer(w, w.vendorA.address, usdc(500))

    // 0h: the rogue guardian freezes.
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    const t0 = BigInt(await time.latest())

    // 1h: owners request the guardian's removal, and queue a payment for the nonce after its
    // apply (configuration calls are Safe transactions too). Made during the freeze: void.
    await time.increaseTo(t0 + HOUR)
    const removeGuardian = [guardianRole(w.guardian.address, false)]
    await requestConfig(w, [], removeGuardian)
    const duringHash = await scheduleOwners(w, pay, w.quorum2, (await w.safe.nonce()) + 1n)

    // 25h: both are mature, the freeze blocks both.
    await time.increaseTo(t0 + HOUR + T)
    await expectPolicyDenied(execOwners(w, pay), w.engine, w.freeze, 'Frozen')
    await expectError(applyConfig(w, [], removeGuardian), w.engine, 'ConfigFrozen', [t0 + F])

    // F: the freeze expires by itself, no extension; the cooldown starts.
    await time.increaseTo(t0 + F - 1n)
    expect((await w.engine.freezeStatus(w.safeAddress, OWNERS)).safeFrozen).to.equal(true)
    await time.increaseTo(t0 + F)
    expect((await w.engine.freezeStatus(w.safeAddress, OWNERS)).safeFrozen).to.equal(false)
    const again = await w.engine.connect(w.guardian).freeze([w.safeAddress])
    expect(await eventsOf(again, w.engine, 'FreezeSkipped')).to.have.length(1)
    expect(await eventsOf(again, w.engine, 'Frozen')).to.have.length(0)

    // Cooldown: owners apply the guardian's removal; the payment queued during the freeze is void.
    await applyConfig(w, [], removeGuardian)
    expect(await w.engine.isGuardian(w.safeAddress, w.guardian.address)).to.equal(false)
    await expectPolicyDenied(execOwners(w, pay), w.engine, w.timelock, 'ClearedByFreeze', [duringHash])

    // After the cooldown the old guardian can do nothing; the owners re-queue and pay.
    await time.increaseTo(t0 + F + C)
    await expectError(w.engine.connect(w.guardian).freeze([w.safeAddress]), w.engine, 'NotGuardian', [
      w.safeAddress,
    ])
    await scheduleOwners(w, pay)
    await time.increase(T)
    await execOwners(w, pay)
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(500))
  })

  it('guardian compromised, faster: the recovery key (lifter) lifts the rogue freeze at once', async () => {
    const w = await loadFixture(deployOrg)
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    await expectPolicyDenied(
      execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, 1n)),
      w.engine,
      w.freeze,
      'Frozen',
    )
    await expectError(w.engine.connect(w.o1).lift(w.safeAddress, ANY), w.engine, 'NotGuardianOrLifter')
    await w.engine.connect(w.recovery).lift(w.safeAddress, ANY)
    await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, 1n))
    // The cooldown keeps the rogue guardian from freezing again right away.
    const again = await w.engine.connect(w.guardian).freeze([w.safeAddress])
    expect(await eventsOf(again, w.engine, 'FreezeSkipped')).to.have.length(1)
  })

  it('recovery key compromised: owners remove the recovery module within T < R', async () => {
    const w = await loadFixture(deployOrg)

    // 0h: the rogue recovery key queues an owner swap to itself (R = 72h).
    const takeover = safeCall(w, 'swapOwner', [OWNERS, w.o1.address, w.attacker.address])
    const takeoverHash = await scheduleModule(w, w.recovery, takeover)
    const t0 = BigInt(await time.latest())

    // 1h: owners can't cancel recovery's queue (by design); they queue the module's removal (T).
    await time.increaseTo(t0 + HOUR)
    await expectError(
      w.timelock
        .connect(w.outsider)
        .cancelAsOwners(
          w.engineAddress,
          w.safeAddress,
          takeoverHash,
          await ethSign(
            await w.timelock.cancelDigest(w.engineAddress, w.safeAddress, takeoverHash),
            w.owners,
          ),
        ),
      w.timelock,
      'NotOwnersQueue',
      [takeoverHash],
    )
    const [modules] = await w.safe.getModulesPaginated(OWNERS, 10)
    const i = modules.map((m) => ethers.getAddress(m)).indexOf(w.recovery.address)
    const prev = i === 0 ? OWNERS : modules[i - 1]
    const removal = safeCall(w, 'disableModule', [prev, w.recovery.address])
    const removalHash = await scheduleOwners(w, removal)

    // ~25h: the removal executes, well before R.
    await time.increaseTo((await w.timelock.getSchedule(w.engineAddress, w.safeAddress, removalHash)).readyAt)
    await execOwners(w, removal)
    expect(await w.safe.isModuleEnabled(w.recovery.address)).to.equal(false)

    // 72h: the takeover matured, but the module is gone.
    await time.increaseTo(t0 + R)
    await expectSafeError(execModule(w, w.recovery, takeover), 'GS104')
    expect(await w.safe.isOwner(w.attacker.address)).to.equal(false)
  })
})
