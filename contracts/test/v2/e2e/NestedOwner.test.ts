import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { concat, toBeHex, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import { completeTx, deploySafe, safeTxHash } from '../fixtures/safe'
import {
  OWNERS,
  Op,
  addr,
  allow,
  attach,
  call,
  deployWorld,
  execOwners,
  expectPolicyDenied,
  install,
  limitSettings,
  scope,
  usdc,
} from './world'

/**
 * Story (review F2, SPEC §10, §14 D-22): a V2 Safe with PolicyFallbackHandler refuses every
 * off-chain signature, so it can only sign as an owner of another Safe (or for a dapp login) by
 * approving the hash on-chain with `PolicySignLib.signMessage`. That raw approval is now matched as
 * a CALL, like the typed entries: the owners' `Allow (Owners, *)` grants it and their policies
 * judge it, instead of needing an exact DELEGATECALL Allow the lint blocks.
 */
describe('E2E story: a V2 Safe as the owner of another Safe', () => {
  async function deploy() {
    const w = await deployWorld()
    await install(w, [allow(scope(OWNERS))])
    // The child Safe: the V2 Safe is its only owner.
    const child = await deploySafe([w.safeAddress], 1, { infra: w.infra })
    await w.deployer.sendTransaction({ to: await child.getAddress(), value: ethers.parseEther('1') })
    return { ...w, child }
  }

  /** A Safe contract signature: `r` = the owner, `s` = offset of its (empty) data, `v` = 0. */
  const contractSignature = (owner: string) =>
    concat([zeroPadValue(owner, 32), toBeHex(65, 32), '0x00', toBeHex(0, 32)])

  it("signs the child's transaction on-chain (signMessage under Allow (Owners, *)) and the child executes it", async () => {
    const w = await loadFixture(deploy)
    const childTx = await completeTx(w.child, { to: w.vendorA.address, value: ethers.parseEther('0.5') })
    const hash = await safeTxHash(w.child, childTx)
    await execOwners(
      w,
      call(
        w.signLibAddress,
        w.signLib.interface.encodeFunctionData('signMessage', [hash]),
        0n,
        Op.DELEGATECALL,
      ),
    )

    const before = await ethers.provider.getBalance(w.vendorA.address)
    await w.child.execTransaction(
      childTx.to,
      childTx.value,
      childTx.data,
      childTx.operation,
      childTx.safeTxGas,
      childTx.baseGas,
      childTx.gasPrice,
      childTx.gasToken,
      childTx.refundReceiver,
      contractSignature(w.safeAddress),
    )
    expect((await ethers.provider.getBalance(w.vendorA.address)) - before).to.equal(ethers.parseEther('0.5'))
  })

  it('the raw approval is opaque to the budget: a Limit that does not let unpriced calls pass denies it', async () => {
    const w = await deployWorld()
    await install(w, [
      allow(scope(OWNERS)),
      attach(
        scope(OWNERS),
        addr(w.limit),
        limitSettings([{ token: w.tokenAddress, amount: usdc(1), period: 0n }], false),
      ),
    ])
    const digest = ethers.id('any message')
    await expectPolicyDenied(
      execOwners(
        w,
        call(
          w.signLibAddress,
          w.signLib.interface.encodeFunctionData('signMessage', [digest]),
          0n,
          Op.DELEGATECALL,
        ),
      ),
      w.engine,
      w.limit,
      'Unpriced',
    )
  })
})
