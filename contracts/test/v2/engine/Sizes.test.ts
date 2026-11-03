import { expect } from 'chai'
import { ethers } from 'hardhat'
import {
  DEPLOYED,
  MAX_RUNTIME_BYTES,
  type Deploy,
  SEPOLIA,
  deployEngine,
  deployPolicies,
  nameOf,
  runtimeSize,
  safenetPlaceholder,
  sepoliaCreateGas,
} from '../../../scripts/lib/v2-deployment'

/**
 * Sepolia prices deployed code at ~1,542 gas per byte and caps a transaction at 2^24 gas, so every
 * contract `scripts/deploy-v2.ts` deploys must stay at most 10,000 bytes of runtime (PLAN-rev3
 * decision 15). `DEPLOYED` is the script's own list (scripts/lib/v2-deployment.ts).
 */
describe('V2 deployable sizes', () => {
  it(`every deployed contract is at most ${MAX_RUNTIME_BYTES} bytes of runtime and fits a Sepolia create`, async () => {
    const sizes: string[] = []
    for (const fqn of DEPLOYED) {
      const size = await runtimeSize(fqn)
      sizes.push(`${nameOf(fqn)} ${size}`)
      expect(size, fqn).to.be.greaterThan(0)
      expect(size, fqn).to.be.at.most(MAX_RUNTIME_BYTES)
      expect(sepoliaCreateGas(size), fqn).to.be.lessThan(SEPOLIA.maxCreateGas)
    }
    console.log(`      ${sizes.join(', ')}`)
  })

  it('a dry deploy through the script plan matches the artifacts (immutables included)', async () => {
    const [deployer] = await ethers.getSigners()
    const { chainId } = await ethers.provider.getNetwork()
    const deployed = new Map<string, string>()
    const record: Deploy = async (_label, fqn, args) => {
      const contract = await ethers.deployContract(fqn, args)
      await contract.waitForDeployment()
      deployed.set(fqn, await contract.getAddress())
      return contract.getAddress()
    }
    await deployEngine([deployer.address], record)
    await deployPolicies(record, { safenet: safenetPlaceholder(chainId) })

    expect([...deployed.keys()]).to.deep.equal([...DEPLOYED])
    for (const [fqn, address] of deployed) {
      const size = (await ethers.provider.getCode(address)).length / 2 - 1
      expect(size, fqn).to.equal(await runtimeSize(fqn))
      expect(size, fqn).to.be.at.most(MAX_RUNTIME_BYTES)
    }
  })
})
