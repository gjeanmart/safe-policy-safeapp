import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { deploySafe, execAsOwners } from '../fixtures/safe'
import { expectAnyRevert, expectEvent } from '../helpers'
import {
  HOUR,
  OWNERS,
  SEL,
  T,
  addr,
  allow,
  attach,
  call,
  deployWorld,
  ethSign,
  execModule,
  execOwners,
  expectError,
  expectPolicyDenied,
  install,
  scheduleModule,
  scheduleOwners,
  scope,
  timelockSettings,
  tokenTransfer,
  usdc,
} from './world'

/**
 * Story: Spark's request (via Akshay). A timelocked transaction can be cancelled by another Safe
 * (a security council) from its own Safe transaction. The cancellers are a Timelock setting,
 * snapshotted when the transaction is scheduled, next to the owners' rising-threshold cancel.
 */
describe('E2E story: another Safe cancels a queued transaction (Spark)', () => {
  async function deploy() {
    const w = await deployWorld()
    const council = await deploySafe([w.sparkOwner], 1, { infra: w.infra })
    const councilAddress = await council.getAddress()
    await install(
      w,
      [
        allow(scope(OWNERS)),
        attach(scope(OWNERS), addr(w.timelock), timelockSettings(T, { cancellers: [councilAddress] })),
        allow(scope(w.ops.address, w.tokenAddress, SEL.transfer)),
        attach(
          scope(w.ops.address),
          addr(w.timelock),
          timelockSettings(HOUR, { cancellers: [councilAddress] }),
        ),
      ],
      [],
      { modules: [w.ops.address] },
    )
    /** The council Safe's own transaction: `timelock.cancel(engine, safe, txHash)`. */
    const councilCancel = (hash: string) =>
      execAsOwners(
        council,
        call(
          addr(w.timelock),
          w.timelock.interface.encodeFunctionData('cancel', [w.engineAddress, w.safeAddress, hash]),
        ),
        [w.sparkOwner],
      )
    return { ...w, council, councilAddress, councilCancel }
  }

  it("cancels the owners' queued transaction; executing it is then NotScheduled", async () => {
    const w = await loadFixture(deploy)
    const pay = tokenTransfer(w, w.attacker.address, usdc(50_000))
    const hash = await scheduleOwners(w, pay)
    expect(await w.timelock.getCancellers(w.engineAddress, w.safeAddress, hash)).to.deep.equal([
      w.councilAddress,
    ])

    const tx = await w.councilCancel(hash)
    await expectEvent(tx, w.timelock, 'Cancelled', [
      w.engineAddress,
      w.safeAddress,
      hash,
      w.councilAddress,
      0n,
    ])
    await time.increase(T)
    await expectPolicyDenied(execOwners(w, pay), w.engine, w.timelock, 'NotScheduled', [hash])
  })

  it("cancels a module's queued call (Ops), which the owners could not", async () => {
    const w = await loadFixture(deploy)
    const pay = tokenTransfer(w, w.attacker.address, usdc(1_000))
    const hash = await scheduleModule(w, w.ops, pay)
    await expectError(
      w.timelock
        .connect(w.outsider)
        .cancelAsOwners(
          w.engineAddress,
          w.safeAddress,
          hash,
          await ethSign(await w.timelock.cancelDigest(w.engineAddress, w.safeAddress, hash), [w.o1]),
        ),
      w.timelock,
      'NotOwnersQueue',
    )
    await w.councilCancel(hash)
    await time.increase(HOUR)
    await expectPolicyDenied(execModule(w, w.ops, pay), w.engine, w.timelock, 'NotScheduled', [hash])
  })

  it('anyone else is NotCanceller; the owners cancel with 1, then 2 signatures (rising threshold)', async () => {
    const w = await loadFixture(deploy)
    const hash = await scheduleOwners(w, tokenTransfer(w, w.vendorA.address, 1n))
    await expectError(
      w.timelock.connect(w.attacker).cancel(w.engineAddress, w.safeAddress, hash),
      w.timelock,
      'NotCanceller',
      [w.attacker.address],
    )
    const cancelAs = async (h: string, signers: typeof w.owners) =>
      w.timelock
        .connect(w.outsider)
        .cancelAsOwners(
          w.engineAddress,
          w.safeAddress,
          h,
          await ethSign(await w.timelock.cancelDigest(w.engineAddress, w.safeAddress, h), signers),
        )
    await cancelAs(hash, [w.o1])
    const second = await scheduleOwners(w, tokenTransfer(w, w.vendorA.address, 2n))
    expect(await w.timelock.requiredCancelSignatures(w.engineAddress, w.safeAddress)).to.equal(2n)
    await expectAnyRevert(cancelAs(second, [w.o1]))
    await cancelAs(second, [w.o1, w.o2])
  })
})
