import { expect } from 'chai'
import { ethers } from 'hardhat'
import { eventsOf } from '../helpers'
import {
  CallMatch,
  Level,
  OWNERS,
  SEL,
  allow,
  execOwner,
  expectRevert,
  policy,
  scope,
  setup,
} from './fixtures'

/**
 * SPEC.md §6.1: the re-entrancy flag covers `evaluate` only, so a Safe transaction whose execution
 * drives another guarded Safe (a module call) gets an independent check on the same engine.
 */
describe('V2 engine: nested executions', () => {
  async function twoSafes(innerAllowed: boolean) {
    const a = await setup([allow(scope(OWNERS))])
    const moduleContract = await ethers.deployContract('EngineModule')
    const m = await moduleContract.getAddress()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const { deploySafe } = await import('./fixtures')
    const b = await deploySafe()
    const changes = innerAllowed
      ? [allow(scope(m, CallMatch.TO, a.targetAddr)), policy(scope(m), await cp.getAddress())]
      : [policy(scope(m), await cp.getAddress())]
    await a.engine.connect(b.asSafe).configureImmediately(changes, [])
    await execOwner(b.safe, b.address, b.safe.interface.encodeFunctionData('enableModule', [m]))
    await execOwner(b.safe, b.address, b.safe.interface.encodeFunctionData('setModuleGuard', [a.engineAddr]))
    await execOwner(b.safe, b.address, b.safe.interface.encodeFunctionData('setGuard', [a.engineAddr]))
    const call = moduleContract.interface.encodeFunctionData('exec', [
      b.address,
      a.targetAddr,
      0,
      SEL.ping,
      0,
    ])
    return { a, b, m, cp, moduleContract, call }
  }

  it("Safe A's owner transaction drives Safe B's module transaction: both checked, both pass", async () => {
    const { a, b, cp, call, m } = await twoSafes(true)
    const tx = await execOwner(a.safe, m, call)
    const logs = await eventsOf(tx, cp, 'TransactionChecked')
    expect(logs.length).to.equal(1)
    expect(logs[0].args.ctx.safe).to.equal(b.address)
    expect(logs[0].args.ctx.actor).to.equal(m)
    // The lock was released after both: a further transaction on A works.
    await execOwner(a.safe, a.targetAddr, SEL.ping)
  })

  it("the inner Safe's denial reverts the outer transaction", async () => {
    const { a, m, call } = await twoSafes(false)
    // The inner NotGranted makes the outer inner call fail -> GS013 in the outer mock Safe.
    await expectRevert(execOwner(a.safe, m, call), a.safe, 'GS013')
  })
})
