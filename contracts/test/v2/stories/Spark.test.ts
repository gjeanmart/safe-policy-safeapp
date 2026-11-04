import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { deploySafe, execAsOwners } from '../fixtures/safe'
import { expectEvent } from '../helpers'
import { ZeroAddress } from 'ethers'
import {
  HOUR,
  Kind,
  Mask,
  OWNERS,
  Op,
  SEL,
  T,
  addrOf,
  allow,
  anyCall,
  approve,
  attach,
  attachmentId,
  call,
  configureCall,
  deployWorld,
  detach,
  execModule,
  execOwners,
  expectConfigurationFailed,
  expectPolicyDenied,
  expectPolicyError,
  install,
  onContract,
  onFunction,
  safeCall,
  scheduleModule,
  scheduleOwners,
  timelockSettings,
  transfer,
  usdc,
} from './world'

/**
 * Story: another Safe as a canceller (the Spark set-up). A 1-of-1 "spark" Safe watches the
 * owners' and the ops actor's calls to the token. Owners: Allow `(Owners, *)` + Timelock(T,
 * guardian G) at `(Owners, *)` (it covers `configure`), and Timelock(T, cancellers [spark]) at
 * `(Owners, USDC.*)`. Ops: Allow `(Ops, USDC.transfer)` + Timelock(1 h, cancellers [spark]) at
 * `(Ops, USDC.*)`. The cancellers of a schedule are those of every attachment it matched.
 */

async function world() {
  const w = await deployWorld()
  const spark = await deploySafe([w.newOwner2], 1, { infra: w.infra })
  const sparkAddress = await spark.getAddress()
  const ops = w.ops.address
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T, guardians: [w.guardian.address] })),
      attach(
        onContract(OWNERS, w.tokenAddress),
        w.timelock,
        timelockSettings({ delay: T, cancellers: [sparkAddress] }),
      ),
      allow(onFunction(ops, w.tokenAddress, SEL.transfer)),
      attach(
        onContract(ops, w.tokenAddress),
        w.timelock,
        timelockSettings({ delay: HOUR, cancellers: [sparkAddress] }),
      ),
    ],
    { modules: [ops] },
  )
  return { ...w, spark, sparkAddress }
}
type W = Awaited<ReturnType<typeof world>>

/** The spark Safe cancels `txHash` with an ordinary transaction of its own. */
const sparkCancels = (w: W, txHash: string) =>
  execAsOwners(
    w.spark,
    call(
      addrOf(w.timelock),
      w.timelock.interface.encodeFunctionData('cancel', [w.engineAddress, w.safeAddress, txHash]),
    ),
    [w.newOwner2],
  )

describe('Story: another Safe cancels queued transactions (Spark)', () => {
  it("the spark Safe cancels the owners' queued token transfer", async () => {
    const w = await loadFixture(world)
    const tx = transfer(w, w.attacker.address, usdc(50_000))
    const hash = await scheduleOwners(w, tx)
    await expectEvent(await sparkCancels(w, hash), w.timelock, 'Cancelled', [
      w.engineAddress,
      w.safeAddress,
      hash,
      w.sparkAddress,
    ])
    await time.increase(T)
    await expectPolicyDenied(execOwners(w, tx), w, w.timelock, 'NotScheduled', [hash])
    // The cancel is final: the same signed transaction can never be scheduled again.
    await expectPolicyError(scheduleOwners(w, tx), w.timelock, 'CancelledTransaction', [hash])
  })

  it("the spark Safe cancels the ops actor's queued transfer", async () => {
    const w = await loadFixture(world)
    const tx = transfer(w, w.vendorA.address, usdc(10))
    const hash = await scheduleModule(w, w.ops, tx)
    await sparkCancels(w, hash)
    await time.increase(HOUR)
    await expectPolicyDenied(execModule(w, w.ops, tx), w, w.timelock, 'NotScheduled', [hash])
    // A module call has no nonce: the cancel resets the clock, the ops actor may schedule it again.
    expect(await scheduleModule(w, w.ops, tx)).to.equal(hash)
  })

  it('without a cancel the queued transfers execute after their delays', async () => {
    const w = await loadFixture(world)
    const owners = transfer(w, w.vendorB.address, usdc(1))
    const ops = transfer(w, w.vendorA.address, usdc(1))
    await scheduleOwners(w, owners)
    await scheduleModule(w, w.ops, ops)
    await expectPolicyDenied(execModule(w, w.ops, ops), w, w.timelock, 'NotReady')
    await time.increase(T)
    await execOwners(w, owners)
    await execModule(w, w.ops, ops)
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(1))
  })

  it('the spark Safe cannot cancel what its attachments did not match (NotCanceller)', async () => {
    const w = await loadFixture(world)
    // An ETH payment matches only (Owners, *), whose cancellers do not include spark.
    const hash = await scheduleOwners(w, call(w.vendorA.address, '0x', 1n))
    await expectPolicyError(
      w.timelock.connect(w.newOwner2).cancel(w.engineAddress, w.safeAddress, hash),
      w.timelock,
      'NotCanceller',
    )
    // Its own transaction reverts as a whole (Safe GS013), and the schedule stays.
    let failed = false
    await sparkCancels(w, hash).catch(() => (failed = true))
    expect(failed).to.equal(true)
    expect((await w.timelock.getSchedule(w.engineAddress, w.safeAddress, hash)).scheduledAt).to.not.equal(0n)
  })

  it("a stranger and the spark Safe's own owner cannot cancel (NotCanceller)", async () => {
    const w = await loadFixture(world)
    const hash = await scheduleOwners(w, transfer(w, w.vendorA.address, 1n))
    for (const who of [w.stranger, w.newOwner2]) {
      await expectPolicyError(
        w.timelock.connect(who).cancel(w.engineAddress, w.safeAddress, hash),
        w.timelock,
        'NotCanceller',
        [who.address],
      )
    }
  })

  describe('rev 4: a 72 h delay on USDC.transfer alone, the escape routes covered (review B1)', () => {
    const H72 = 3n * T
    /** Owners: no owner-wide delay; the transfer 72 h with guardian G and spark as canceller, and the routes. */
    /**
     * The "Delay on one function" shape: the narrow 72 h with G and spark, and the three route covers,
     * G on them too (`guardOnCovers`, the default): the covers are what the owners' `configure` matches.
     */
    async function narrowWorld(guardOnCovers = true) {
      const w = await deployWorld()
      const spark = await deploySafe([w.newOwner2], 1, { infra: w.infra })
      const cover = timelockSettings({ delay: H72, guardians: guardOnCovers ? [w.guardian.address] : [] })
      const routes = [
        attach(onContract(OWNERS, w.safeAddress), w.timelock, cover),
        attach(onFunction(OWNERS, w.engineAddress, SEL.configure), w.timelock, cover),
        attach(anyCall(OWNERS), w.timelock, cover, Mask.DELEGATECALL),
      ]
      const narrow = attach(
        onFunction(OWNERS, w.tokenAddress, SEL.transfer),
        w.timelock,
        timelockSettings({
          delay: H72,
          guardians: [w.guardian.address],
          cancellers: [await spark.getAddress()],
        }),
      )
      return { w, spark, routes, narrow }
    }

    it('each missing route cover is named; with the three the configuration is accepted', async () => {
      const { w, routes, narrow } = await narrowWorld()
      const missing = [
        [ZeroAddress, '0x00000000', Mask.DELEGATECALL],
        [w.safeAddress, SEL.setGuard, Mask.CALL],
        [w.engineAddress, SEL.configure, Mask.CALL],
      ]
      for (const [i, args] of [
        [2, missing[0]],
        [0, missing[1]],
        [1, missing[2]],
      ] as const) {
        await expectConfigurationFailed(
          install(w, [allow(anyCall(OWNERS)), narrow, ...routes.filter((_, j) => j !== i)]),
          w,
          w.timelock,
          'TimelockNotCoveringConfiguration',
          [...args, H72],
        )
      }
      await install(w, [allow(anyCall(OWNERS)), narrow, ...routes])
    })

    it('the guardian stops the removal of the delay only through the configure cover (review rev 4, fable S1)', async () => {
      // Without G on the covers: G freezes the narrow delay, the owners' detach of it runs at 72 h anyway.
      const bare = await narrowWorld(false)
      const narrowScope = onFunction(OWNERS, bare.w.tokenAddress, SEL.transfer)
      const dropOf = (w: typeof bare.w) => configureCall(w, [detach(narrowScope, Kind.POLICY, w.timelock)])
      let w = bare.w
      await install(w, [allow(anyCall(OWNERS)), bare.narrow, ...bare.routes])
      await scheduleOwners(w, dropOf(w))
      await w.timelock
        .connect(w.guardian)
        .freeze(w.engineAddress, w.safeAddress, [attachmentId(narrowScope, Kind.POLICY, addrOf(w.timelock))])
      await time.increase(H72)
      await execOwners(w, dropOf(w))
      await execOwners(w, transfer(w, w.attacker.address, usdc(1)))
      // With G on the covers (the template's shape): G freezes the configure cover and the detach waits.
      const guarded = await narrowWorld()
      w = guarded.w
      await install(w, [allow(anyCall(OWNERS)), guarded.narrow, ...guarded.routes])
      await scheduleOwners(w, dropOf(w))
      const cfg = attachmentId(
        onFunction(OWNERS, w.engineAddress, SEL.configure),
        Kind.POLICY,
        addrOf(w.timelock),
      )
      await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [cfg])
      await time.increase(H72)
      await expectPolicyDenied(execOwners(w, dropOf(w)), w, w.timelock, 'AttachmentFrozen')
    })

    it('approve, ETH and other calls are instant; transfers, Safe admin, configure and DELEGATECALLs wait 72 h', async () => {
      const { w, spark, routes, narrow } = await narrowWorld()
      await install(w, [allow(anyCall(OWNERS)), narrow, ...routes])
      await execOwners(w, call(w.vendorA.address, '0x', 1n))
      await execOwners(w, approve(w, w.vendorA.address, 1n))
      await expectPolicyDenied(
        execOwners(w, transfer(w, w.vendorA.address, 1n)),
        w,
        w.timelock,
        'NotScheduled',
      )
      for (const [fn, args] of [
        ['setGuard', [ZeroAddress]],
        ['setModuleGuard', [ZeroAddress]],
        ['enableModule', [w.attacker.address]],
        ['disableModule', [OWNERS, w.attacker.address]],
        ['setFallbackHandler', [w.attacker.address]],
        ['addOwnerWithThreshold', [w.attacker.address, 1]],
      ] as const)
        await expectPolicyDenied(execOwners(w, safeCall(w, fn, [...args])), w, w.timelock, 'NotScheduled')
      const drop = configureCall(w, [
        detach(onFunction(OWNERS, w.tokenAddress, SEL.transfer), Kind.POLICY, w.timelock),
      ])
      await expectPolicyDenied(execOwners(w, drop), w, w.timelock, 'NotScheduled')
      // A DELEGATECALL needs an exact Allow: granting it is a configure (72 h), then the call waits 72 h too.
      const target = w.attacker.address
      const grant = configureCall(w, [allow(onFunction(OWNERS, target, '0xdeadbeef'), Mask.DELEGATECALL)])
      await scheduleOwners(w, grant)
      await time.increase(H72)
      await execOwners(w, grant)
      await expectPolicyDenied(
        execOwners(w, { to: target, data: '0xdeadbeef', operation: Op.DELEGATECALL }),
        w,
        w.timelock,
        'NotScheduled',
      )
      // A scheduled transfer runs after 72 h; the spark Safe can cancel one.
      const pay = transfer(w, w.vendorB.address, 5n)
      await scheduleOwners(w, pay)
      await time.increase(H72)
      await execOwners(w, pay)
      expect(await w.token.balanceOf(w.vendorB.address)).to.equal(5n)
      const steal = transfer(w, w.attacker.address, usdc(50_000))
      const hash = await scheduleOwners(w, steal)
      await execAsOwners(
        spark,
        call(
          addrOf(w.timelock),
          w.timelock.interface.encodeFunctionData('cancel', [w.engineAddress, w.safeAddress, hash]),
        ),
        [w.newOwner2],
      )
      await time.increase(H72)
      await expectPolicyDenied(execOwners(w, steal), w, w.timelock, 'NotScheduled', [hash])
    })
  })
})
