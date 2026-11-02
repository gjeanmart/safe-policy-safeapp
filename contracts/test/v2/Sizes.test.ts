import { expect } from 'chai'
import { ethers } from 'hardhat'
import {
  DEPLOYED_V2_CONTRACTS,
  ENGINE_MODULES,
  FQN,
  MAX_RUNTIME_BYTES,
  SEPOLIA,
  deployEngineV2,
  deployTimelockPolicy,
  runtimeSize,
  sepoliaCreateGas,
} from '../../scripts/lib/v2-deployment'

/**
 * Sepolia prices deployed code at ~1,542 gas per byte and caps a transaction at 2^24 gas, so every
 * contract `scripts/deploy-v2.ts` deploys must stay ≤ 10,000 bytes of runtime (SPEC.md §14, D-14).
 */
describe('V2 deployable sizes', () => {
  it(`every contract the deploy script deploys is at most ${MAX_RUNTIME_BYTES} bytes of runtime`, async () => {
    const sizes: string[] = []
    for (const fqn of DEPLOYED_V2_CONTRACTS) {
      const size = await runtimeSize(fqn)
      sizes.push(`${fqn.split(':')[1]} ${size}`)
      expect(size, fqn).to.be.greaterThan(0)
      expect(size, fqn).to.be.at.most(MAX_RUNTIME_BYTES)
      expect(sepoliaCreateGas(size), fqn).to.be.lessThan(SEPOLIA.maxCreateGas)
    }
    console.log(`      ${sizes.join(', ')}`)
  })

  it('lists the engine pieces and the timelock pieces the script deploys', async () => {
    for (const fqn of [...ENGINE_MODULES, FQN.engine, FQN.timelockQueue, FQN.timelock])
      expect(DEPLOYED_V2_CONTRACTS, fqn).to.include(fqn)
  })

  it('the deployed code is as large as the artifacts say (immutables included)', async () => {
    const [deployer] = await ethers.getSigners()
    const signLib = await (
      await ethers.deployContract(FQN.signLib, [deployer.address, deployer.address])
    ).getAddress()
    const { engine, modules } = await deployEngineV2({
      delay: 1n,
      expiry: 10n,
      maxFreeze: 1n,
      freezeCooldown: 1n,
      trustedBatches: [deployer.address],
      signLib,
    })
    const timelock = await deployTimelockPolicy()
    const queue = await (await ethers.getContractAt(FQN.timelock, timelock)).queue()
    for (const address of [engine, ...modules, timelock, queue]) {
      const size = (await ethers.provider.getCode(address)).length / 2 - 1
      expect(size, address).to.be.at.most(MAX_RUNTIME_BYTES)
    }
  })
})
