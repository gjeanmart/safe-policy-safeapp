import { expect } from 'chai'
import { artifacts, ethers } from 'hardhat'

/**
 * Sepolia prices deployed code at ~1,542 gas per byte and caps a transaction at 2^24 gas, so every
 * contract the V2 deployment deploys must stay at most 10,000 bytes of runtime (PLAN-rev3
 * decision 15). WP E: add each policy (and any split-off module) to `DEPLOYED`.
 */
export const MAX_RUNTIME_BYTES = 10_000

export const DEPLOYED: string[] = [
  'contracts/v2/PolicyGuard.sol:PolicyGuard',
  'contracts/v2/PolicyGuardConfig.sol:PolicyGuardConfig',
]

async function runtimeSize(fqn: string): Promise<number> {
  const { deployedBytecode } = await artifacts.readArtifact(fqn)
  return (deployedBytecode.length - 2) / 2
}

describe('V2 deployable sizes', () => {
  it(`every deployed contract is at most ${MAX_RUNTIME_BYTES} bytes of runtime`, async () => {
    const sizes: string[] = []
    for (const fqn of DEPLOYED) {
      const size = await runtimeSize(fqn)
      sizes.push(`${fqn.split(':')[1]} ${size}`)
      expect(size, fqn).to.be.greaterThan(0)
      expect(size, fqn).to.be.at.most(MAX_RUNTIME_BYTES)
    }
    console.log(`      ${sizes.join(', ')}`)
  })

  it('the deployed engine is as large as its artifacts say (immutables included)', async () => {
    const [deployer] = await ethers.getSigners()
    const config = await ethers.deployContract('PolicyGuardConfig')
    const guard = await ethers.deployContract('PolicyGuard', [[deployer.address], await config.getAddress()])
    for (const c of [guard, config]) {
      const size = (await ethers.provider.getCode(await c.getAddress())).length / 2 - 1
      expect(size).to.be.at.most(MAX_RUNTIME_BYTES)
    }
  })
})
