import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import { eventsOf, expectEvent } from '../helpers'
import {
  ANY,
  OWNERS,
  TIMING,
  allow,
  deployEngine,
  deploySafe,
  execModule,
  execOwner,
  expectRevert,
  scope,
  setup,
} from './fixtures'

/** SPEC.md §7.1: the bounded freeze, its roles, and its effect on configuration. */
describe('V2 engine: freeze', () => {
  async function fresh() {
    const [, guardian, lifter, other, agent] = await ethers.getSigners()
    const { engine } = await deployEngine()
    const a = await deploySafe()
    const b = await deploySafe()
    const roles = [
      { role: 0, account: guardian.address, enabled: true },
      { role: 1, account: lifter.address, enabled: true },
    ]
    await engine.connect(a.asSafe).configureImmediately([], roles)
    await engine.connect(b.asSafe).configureImmediately([], roles)
    return { engine, a, b, guardian, lifter, other, agent }
  }

  it('freeze → expiry → cooldown → freezable again; never longer than MAX_FREEZE', async () => {
    const f = await fresh()
    const tx = await f.engine.connect(f.guardian).freeze([f.a.address])
    const t0 = BigInt(await time.latest())
    await expectEvent(tx, f.engine, 'Frozen', [
      f.a.address,
      ANY,
      f.guardian.address,
      t0 + TIMING.maxFreeze,
      1,
    ])
    let st = await f.engine.getFreezeState(f.a.address, ANY)
    expect(st.frozenAt).to.equal(t0)
    expect(st.frozenUntil).to.equal(t0 + TIMING.maxFreeze)
    expect(st.cooldownUntil).to.equal(t0 + TIMING.maxFreeze + TIMING.cooldown)
    expect(st.epoch).to.equal(1n)
    expect([...(await f.engine.freezeStatus(f.a.address, f.agent.address))]).to.deep.equal([true, false, 1n])

    // Re-freezing while frozen is skipped (no extension).
    const again = await f.engine.connect(f.guardian).freeze([f.a.address])
    await expectEvent(again, f.engine, 'FreezeSkipped', [
      f.a.address,
      f.guardian.address,
      t0 + TIMING.maxFreeze,
    ])
    expect((await eventsOf(again, f.engine, 'Frozen')).length).to.equal(0)

    await time.increaseTo(t0 + TIMING.maxFreeze)
    expect((await f.engine.freezeStatus(f.a.address, ANY))[0]).to.equal(false)
    // Cooling down: skipped with the cooldown end.
    const cooling = await f.engine.connect(f.guardian).freeze([f.a.address])
    await expectEvent(cooling, f.engine, 'FreezeSkipped', [
      f.a.address,
      f.guardian.address,
      t0 + TIMING.maxFreeze + TIMING.cooldown,
    ])
    await time.increaseTo(t0 + TIMING.maxFreeze + TIMING.cooldown)
    await f.engine.connect(f.guardian).freeze([f.a.address])
    st = await f.engine.getFreezeState(f.a.address, ANY)
    expect(st.epoch).to.equal(2n)
  })

  it('freeze(safes[]) freezes many Safes, skips frozen ones, and reverts if the caller does not guard one', async () => {
    const f = await fresh()
    await f.engine.connect(f.guardian).freeze([f.a.address])
    const tx = await f.engine.connect(f.guardian).freeze([f.a.address, f.b.address])
    expect((await eventsOf(tx, f.engine, 'FreezeSkipped')).length).to.equal(1)
    expect((await eventsOf(tx, f.engine, 'Frozen')).length).to.equal(1)
    const c = await deploySafe()
    await expectRevert(
      f.engine.connect(f.guardian).freeze([f.b.address, c.address]),
      f.engine,
      'NotGuardian',
      [c.address],
    )
    await expectRevert(f.engine.connect(f.lifter).freeze([f.a.address]), f.engine, 'NotGuardian', [
      f.a.address,
    ])
  })

  it('lift: guardian or lifter only, only while frozen; starts the cooldown so lift + re-freeze cannot extend', async () => {
    const f = await fresh()
    await expectRevert(f.engine.connect(f.lifter).lift(f.a.address, ANY), f.engine, 'NotFrozen', [
      f.a.address,
      ANY,
    ])
    await f.engine.connect(f.guardian).freeze([f.a.address])
    await expectRevert(f.engine.connect(f.other).lift(f.a.address, ANY), f.engine, 'NotGuardianOrLifter', [
      f.a.address,
    ])
    // Owners (the Safe itself) cannot lift either.
    await expectRevert(f.engine.connect(f.a.asSafe).lift(f.a.address, ANY), f.engine, 'NotGuardianOrLifter', [
      f.a.address,
    ])
    const tx = await f.engine.connect(f.lifter).lift(f.a.address, ANY)
    const now = BigInt(await time.latest())
    await expectEvent(tx, f.engine, 'Unfrozen', [f.a.address, ANY, f.lifter.address, now + TIMING.cooldown])
    expect((await f.engine.freezeStatus(f.a.address, ANY))[0]).to.equal(false)
    const skipped = await f.engine.connect(f.guardian).freeze([f.a.address])
    expect((await eventsOf(skipped, f.engine, 'FreezeSkipped')).length).to.equal(1)
    // A guardian can lift too.
    await f.engine.connect(f.guardian).freeze([f.b.address])
    await f.engine.connect(f.guardian).lift(f.b.address, ANY)
  })

  it('freezeActor: module actors only, AlreadyFrozen, FreezeCooldown, independent epochs', async () => {
    const f = await fresh()
    await expectRevert(f.engine.connect(f.guardian).freezeActor(f.a.address, ANY), f.engine, 'InvalidActor', [
      ANY,
    ])
    await expectRevert(
      f.engine.connect(f.guardian).freezeActor(f.a.address, OWNERS),
      f.engine,
      'InvalidActor',
      [OWNERS],
    )
    await expectRevert(
      f.engine.connect(f.lifter).freezeActor(f.a.address, f.agent.address),
      f.engine,
      'NotGuardian',
      [f.a.address],
    )
    const tx = await f.engine.connect(f.guardian).freezeActor(f.a.address, f.agent.address)
    const t0 = BigInt(await time.latest())
    await expectEvent(tx, f.engine, 'Frozen', [
      f.a.address,
      f.agent.address,
      f.guardian.address,
      t0 + TIMING.maxFreeze,
      1,
    ])
    expect([...(await f.engine.freezeStatus(f.a.address, f.agent.address))]).to.deep.equal([false, true, 1n])
    await expectRevert(
      f.engine.connect(f.guardian).freezeActor(f.a.address, f.agent.address),
      f.engine,
      'AlreadyFrozen',
      [f.a.address, f.agent.address, t0 + TIMING.maxFreeze],
    )
    await f.engine.connect(f.lifter).lift(f.a.address, f.agent.address)
    const now = BigInt(await time.latest())
    await expectRevert(
      f.engine.connect(f.guardian).freezeActor(f.a.address, f.agent.address),
      f.engine,
      'FreezeCooldown',
      [f.a.address, f.agent.address, now + TIMING.cooldown],
    )
    // Safe-wide freeze adds to the actor's epoch.
    await f.engine.connect(f.guardian).freeze([f.a.address])
    expect([...(await f.engine.freezeStatus(f.a.address, f.agent.address))]).to.deep.equal([true, false, 2n])
    expect([...(await f.engine.freezeStatus(f.a.address, ANY))]).to.deep.equal([true, false, 1n])
  })

  it('a Safe-wide freeze blocks applyConfiguration only; request and invalidate still work; apply works after it', async () => {
    const f = await fresh()
    const changes = [allow(scope(ANY))]
    const root = await f.engine.configurationRoot(changes, [])
    await f.engine.connect(f.guardian).freeze([f.a.address])
    const until = (await f.engine.getFreezeState(f.a.address, ANY)).frozenUntil
    await f.engine.connect(f.a.asSafe).requestConfiguration(root) // allowed during the freeze
    await f.engine.connect(f.a.asSafe).requestConfiguration(ethers.id('x'))
    await f.engine.connect(f.a.asSafe).invalidateRoot(ethers.id('x'))
    await time.increase(TIMING.delay)
    await expectRevert(
      f.engine.connect(f.a.asSafe).applyConfiguration(changes, []),
      f.engine,
      'ConfigFrozen',
      [until],
    )
    // An actor freeze does not block configuration.
    await f.engine.connect(f.guardian).freezeActor(f.b.address, f.agent.address)
    const rootB = await f.engine.configurationRoot(changes, [])
    await f.engine.connect(f.b.asSafe).requestConfiguration(rootB)
    await time.increase(TIMING.delay)
    await f.engine.connect(f.b.asSafe).applyConfiguration(changes, [])
    // After the freeze ends (cooldown running) the queued root applies (EXPIRY ≥ F + C + DELAY).
    await time.increaseTo(until)
    await f.engine.connect(f.a.asSafe).applyConfiguration(changes, [])
  })

  it('the guard denies an apply transaction early during the freeze (owner path)', async () => {
    const [, , , , , guardian] = await ethers.getSigners()
    const f = await setup([allow(scope(OWNERS))], [{ role: 0, account: guardian.address, enabled: true }])
    const changes = [allow(scope(ANY))]
    await execOwner(
      f.safe,
      f.engineAddr,
      f.engine.interface.encodeFunctionData('requestConfiguration', [
        await f.engine.configurationRoot(changes, []),
      ]),
    )
    await time.increase(TIMING.delay)
    await f.engine.connect(guardian).freeze([f.safeAddr])
    const until = (await f.engine.getFreezeState(f.safeAddr, ANY)).frozenUntil
    await expectRevert(
      execOwner(
        f.safe,
        f.engineAddr,
        f.engine.interface.encodeFunctionData('applyConfiguration', [changes, []]),
      ),
      f.engine,
      'ConfigFrozen',
      [until],
    )
  })

  it('a guarded guardian Safe freezes another Safe through an exact-scope ALLOW (module) or any ALLOW (owners)', async () => {
    const [, module] = await ethers.getSigners()
    const g = await setup([allow(scope(OWNERS))])
    const { address: victim, asSafe } = await deploySafe()
    await g.engine.connect(asSafe).configureImmediately([], [{ role: 0, account: g.safeAddr, enabled: true }])
    const data = g.engine.interface.encodeFunctionData('freeze', [[victim]])
    await execOwner(g.safe, g.engineAddr, data)
    expect((await g.engine.freezeStatus(victim, ANY))[0]).to.equal(true)

    const h = await setup([allow(scope(module.address))])
    // A wildcard ALLOW does not let a module call the engine (F5).
    await expectRevert(
      execModule(
        h.safe,
        h.module,
        h.engineAddr,
        h.engine.interface.encodeFunctionData('lift', [victim, ANY]),
      ),
      h.engine,
      'NotGranted',
    )
  })
})
