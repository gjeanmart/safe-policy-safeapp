import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { deploySafe, execAsOwners } from '../fixtures/safe'
import { expectEvent } from '../helpers'
import {
  HOUR,
  OWNERS,
  SEL,
  T,
  addrOf,
  allow,
  anyCall,
  attach,
  call,
  deployWorld,
  execModule,
  execOwners,
  expectPolicyDenied,
  expectPolicyError,
  install,
  onContract,
  onFunction,
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
})
