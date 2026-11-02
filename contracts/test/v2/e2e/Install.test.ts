import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { getAddress } from 'ethers'
import { type MetaTx, execAsOwners, guardsOf, multiSendTx } from '../fixtures/safe'
import {
  engineCall,
  deployWorld,
  execOwners,
  execOwnersAfter,
  expectError,
  orgChanges,
  orgRoles,
  safeCall,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/**
 * Story: adopting V2 in one owner transaction, as the app's `installCalls` (src/lib/v2/changes.ts)
 * plans it: `configureImmediately(changes, roles)`, `setFallbackHandler(PolicyFallbackHandler)`,
 * `setGuard(engine)`, `setModuleGuard(engine)`, batched through MultiSendCallOnly 1.5.0 by
 * `planOwnerTransactions`. Does it work on a real Safe 1.5.0?
 */
describe('E2E story: the app install batch on a real Safe 1.5.0', () => {
  /** `installCalls(safe, deployment, set)`, in the app's order. */
  async function installCalls(w: World): Promise<MetaTx[]> {
    return [
      engineCall(w, 'configureImmediately', [orgChanges(w), orgRoles(w)]),
      safeCall(w, 'setFallbackHandler', [await w.handler.getAddress()]),
      safeCall(w, 'setGuard', [w.engineAddress]),
      safeCall(w, 'setModuleGuard', [w.engineAddress]),
    ]
  }
  const batch = async (w: World, calls: MetaTx[]) =>
    multiSendTx(await w.infra.multiSendCallOnly.getAddress(), calls)

  async function deploy() {
    return deployWorld()
  }

  it('works: one MultiSendCallOnly transaction configures, sets the handler, the guard and the module guard', async () => {
    const w = await loadFixture(deploy)
    await execAsOwners(w.safe, await batch(w, await installCalls(w)), w.quorum2)

    expect(await guardsOf(w.safe)).to.deep.equal({ guard: w.engineAddress, moduleGuard: w.engineAddress })
    const handlerSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'
    expect(getAddress('0x' + (await w.safe.getStorageAt(handlerSlot, 1)).slice(26))).to.equal(
      await w.handler.getAddress(),
    )
    expect(await w.engine.getAttachments(w.safeAddress)).to.have.length(orgChanges(w).length)
    expect(await w.engine.isGuardian(w.safeAddress, w.guardian.address)).to.equal(true)

    // The next owner transaction is already checked: the owners' Timelock applies.
    const pay = tokenTransfer(w, w.vendorA.address, usdc(1))
    await expectError(execOwners(w, pay), w.engine, 'PolicyDenied')
    await execOwnersAfter(w, pay)
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(1))
  })

  it('the order matters: setGuard before configureImmediately reverts the batch (GuardAlreadyEnabled)', async () => {
    const w = await loadFixture(deploy)
    const [configure, handler, guard, moduleGuard] = await installCalls(w)
    // Safe 1.5.0 bubbles the inner revert when safeTxGas and gasPrice are zero.
    await expectError(
      execAsOwners(w.safe, await batch(w, [guard, configure, handler, moduleGuard]), w.quorum2),
      w.engine,
      'GuardAlreadyEnabled',
    )
    expect((await guardsOf(w.safe)).guard).to.equal(getAddress('0x' + '00'.repeat(20)))
  })

  it('cannot run twice: once installed, a configureImmediately call through the Safe is GuardTargetDenied', async () => {
    const w = await loadFixture(deploy)
    await execAsOwners(w.safe, await batch(w, await installCalls(w)), w.quorum2)
    await expectError(
      execOwners(w, await batch(w, [engineCall(w, 'configureImmediately', [[], []])])),
      w.engine,
      'GuardTargetDenied',
    )
  })
})
