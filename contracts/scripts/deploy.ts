import { ethers, network } from 'hardhat'

/**
 * Deploys SpendingLimitPolicy (guard-agnostic) and an AllOfPolicy bound to one SafePolicyGuard.
 *
 *   POLICY_GUARD=0x… pnpm deploy:sepolia
 *
 * POLICY_GUARD defaults to the 5-second-delay guard used by the sandbox app. AllOfPolicy only
 * serves the guard it is deployed for, so deploy one per guard you use.
 */
const DEFAULT_GUARD = '0x5202B1ebE100812437d47eae769e155945fbba6a'

async function main() {
  const guard = ethers.getAddress(process.env.POLICY_GUARD ?? DEFAULT_GUARD)
  const [deployer] = await ethers.getSigners()
  if (!deployer)
    throw new Error('No deployer account: run `npx hardhat vars set SEPOLIA_DEPLOYER_KEY` first.')
  console.log(`Network ${network.name}, deployer ${deployer.address}, guard ${guard}`)

  const spending = await ethers.deployContract('SpendingLimitPolicy')
  await spending.waitForDeployment()
  console.log(`SpendingLimitPolicy  ${await spending.getAddress()}`)

  const allOf = await ethers.deployContract('AllOfPolicy', [guard])
  await allOf.waitForDeployment()
  console.log(`AllOfPolicy          ${await allOf.getAddress()} (guard ${guard})`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
