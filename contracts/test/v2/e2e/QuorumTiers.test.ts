import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { AbiCoder } from 'ethers'
import { multiSendTx } from '../fixtures/safe'
import {
  OWNERS,
  addr,
  allow,
  attach,
  deployWorld,
  execModule,
  execOwners,
  expectPolicyDenied,
  install,
  scope,
  tokenTransfer,
  usdc,
} from './world'

/**
 * Story: approval tiers (design doc §5, "enterprise policies"). The Safe is 2-of-3; QuorumPolicyV2
 * at `(Owners, *)` asks for 3 signatures once a transaction moves more than 10,000 USDC, summed over
 * a batch. On a real Safe 1.5.0 the policy re-checks the signatures with `checkNSignatures`, using
 * the executor the Safe passes to the guard (SPEC §8.8).
 */
describe('E2E story: approval tiers (Quorum) on a real Safe', () => {
  async function deploy() {
    const w = await deployWorld()
    const settings = AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint8 required, tuple(address token, uint256 above, uint8 required)[] tiers)'],
      [[2, [[w.tokenAddress, usdc(10_000), 3]]]],
    )
    await install(w, [allow(scope(OWNERS)), attach(scope(OWNERS), addr(w.quorum), settings)], [], {
      modules: [w.ops.address],
    })
    return w
  }

  it('routine: 2 signatures pay 10,000; above the tier 2 are denied (QuorumNotMet), 3 pass', async () => {
    const w = await loadFixture(deploy)
    await execOwners(w, tokenTransfer(w, w.vendorA.address, usdc(10_000)))
    await expectPolicyDenied(
      execOwners(w, tokenTransfer(w, w.vendorA.address, usdc(10_001))),
      w.engine,
      w.quorum,
      'QuorumNotMet',
    )
    await execOwners(w, tokenTransfer(w, w.vendorA.address, usdc(10_001)), w.owners)
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(20_001))
  })

  it('splitting into a batch does not dodge it: the tier sums the batch', async () => {
    const w = await loadFixture(deploy)
    const split = multiSendTx(await w.infra.multiSendCallOnly.getAddress(), [
      tokenTransfer(w, w.vendorA.address, usdc(6_000)),
      tokenTransfer(w, w.vendorB.address, usdc(6_000)),
    ])
    await expectPolicyDenied(execOwners(w, split), w.engine, w.quorum, 'QuorumNotMet')
    await execOwners(w, split, w.owners)
  })

  it('owner path only: a module call meeting a Quorum attachment is denied (ModulePathUnsupported)', async () => {
    const w = await deployWorld()
    const settings = AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint8 required, tuple(address token, uint256 above, uint8 required)[] tiers)'],
      [[2, []]],
    )
    await install(
      w,
      [allow(scope(w.ops.address)), attach(scope(w.ops.address), addr(w.quorum), settings)],
      [],
      {
        modules: [w.ops.address],
      },
    )
    await expectPolicyDenied(
      execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, 1n)),
      w.engine,
      w.quorum,
      'ModulePathUnsupported',
    )
  })
})
