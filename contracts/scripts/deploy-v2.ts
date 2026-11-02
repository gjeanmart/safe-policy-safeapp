import { ethers, network } from 'hardhat'

/**
 * Deploys the Policy Engine V2 prototype (SPEC.md §5.4) on Sepolia:
 *
 *   PolicySignLib → 2 × SafePolicyGuardV2 (DELAY 5 s and 24 h) → PolicyFallbackHandler → 8 policies
 *
 *   npx hardhat vars set SEPOLIA_DEPLOYER_KEY      # read by hardhat.config.ts, never by this script
 *   pnpm deploy:v2:sepolia
 *
 * Dry run on the in-process Hardhat network (no key, no RPC, same code path):
 *
 *   DRY_RUN=1 npx hardhat run scripts/deploy-v2.ts
 *
 * Prints one JSON block per engine, shaped like `V2Deployment` (src/lib/v2/policies.ts), for
 * src/config/contracts.ts. The policies, the sign library and the fallback handler are shared: policies
 * key their state by engine (msg.sender), so one instance serves both engines.
 */

const DRY_RUN = process.env.DRY_RUN === '1'
const SEPOLIA_CHAIN_ID = 11155111n
const MIN_BALANCE = ethers.parseEther('0.02')
const CONFIRMATIONS = DRY_RUN ? 1 : 2

const HOUR = 3600n
const DAY = 24n * HOUR

// SPEC §5.4 requires EXPIRY ≥ MAX_FREEZE + FREEZE_COOLDOWN + DELAY (8.5 d for the 24 h engine), so V1's
// 7-day EXPIRY is not valid here: both engines use 9 days.
const TIMING = { expiry: 9n * DAY, maxFreeze: 7n * DAY, freezeCooldown: 12n * HOUR }
const ENGINES = [
  { label: '5 seconds', delay: 5n },
  { label: '24 hours', delay: DAY },
] as const

// Canonical MultiSendCallOnly deployments on Sepolia (11155111), from safe-global/safe-deployments at
// 685f22be940739259cfc4148db3df7048f39a4e8: src/assets/v1.4.1/multi_send_call_only.json and
// src/assets/v1.5.0/multi_send_call_only.json ("canonical" address). 1.4.1 first: the app batches with it.
const TRUSTED_BATCHES = [
  '0x9641d764fc13c8B624c04430C7356C1C7C8102e2', // MultiSendCallOnly v1.4.1
  '0xA83c336B20401Af773B6219BA5027174338D1836', // MultiSendCallOnly v1.5.0
]

// The real CoW GPv2Settlement and Uniswap Permit2 (same address on every chain), priced by PolicySignLib.
const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

// SafenetPolicyV2 binds a Consensus deployment and a genesis FROST group key at construction. As in V1's
// deploy (8ee68a8 deploy/deploy_contracts.ts) there is no sensible default, so it needs all five.
const SAFENET = {
  consensusChainId: process.env.SAFENET_CONSENSUS_CHAIN_ID,
  consensusAddress: process.env.SAFENET_CONSENSUS_ADDRESS,
  initialEpoch: process.env.SAFENET_INITIAL_EPOCH,
  groupKeyX: process.env.SAFENET_GROUP_KEY_X,
  groupKeyY: process.env.SAFENET_GROUP_KEY_Y,
}
// Dry run only: the secp256k1 generator as genesis key and a dummy Consensus. No real attestation can
// ever satisfy a policy built from these.
const SAFENET_PLACEHOLDER = {
  consensusAddress: '0x000000000000000000000000000000000000dEaD',
  initialEpoch: 0n,
  groupKey: {
    x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  },
}

/** Fully qualified names: some V1 vendor names (ISafe, IERC165) clash in the artifact namespace. */
const FQN = {
  signLib: 'contracts/v2/erc1271/PolicySignLib.sol:PolicySignLib',
  engine: 'contracts/v2/SafePolicyGuardV2.sol:SafePolicyGuardV2',
  fallbackHandler: 'contracts/v2/erc1271/PolicyFallbackHandler.sol:PolicyFallbackHandler',
  freeze: 'contracts/v2/policies/FreezePolicy.sol:FreezePolicy',
  timelock: 'contracts/v2/policies/TimelockPolicy.sol:TimelockPolicy',
  recipients: 'contracts/v2/policies/RecipientsPolicy.sol:RecipientsPolicy',
  limit: 'contracts/v2/policies/LimitPolicy.sol:LimitPolicy',
  args: 'contracts/v2/policies/ArgsPolicy.sol:ArgsPolicy',
  coSigner: 'contracts/v2/policies/CoSignerPolicyV2.sol:CoSignerPolicyV2',
  safenet: 'contracts/v2/policies/SafenetPolicyV2.sol:SafenetPolicyV2',
  quorum: 'contracts/v2/policies/QuorumPolicyV2.sol:QuorumPolicyV2',
} as const

async function deploy(label: string, fqn: string, args: unknown[] = []): Promise<string> {
  const contract = await ethers.deployContract(fqn, args)
  const tx = contract.deploymentTransaction()
  const receipt = await tx?.wait(CONFIRMATIONS)
  const address = await contract.getAddress()
  console.log(`${label.padEnd(30)} ${address}  (gas ${receipt?.gasUsed ?? '?'})`)
  return address
}

function safenetArgs(chainId: bigint): unknown[] | undefined {
  if (Object.values(SAFENET).every((value) => value !== undefined && value !== '')) {
    return [
      BigInt(SAFENET.consensusChainId!),
      ethers.getAddress(SAFENET.consensusAddress!),
      BigInt(SAFENET.initialEpoch!),
      { x: BigInt(SAFENET.groupKeyX!), y: BigInt(SAFENET.groupKeyY!) },
    ]
  }
  if (DRY_RUN) {
    console.log('SafenetPolicyV2: SAFENET_* not set, dry run deploys it with a PLACEHOLDER consensus/key')
    const { consensusAddress, initialEpoch, groupKey } = SAFENET_PLACEHOLDER
    return [chainId, consensusAddress, initialEpoch, groupKey]
  }
  return undefined
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork()
  if (DRY_RUN && network.name !== 'hardhat')
    throw new Error(`DRY_RUN=1 runs on the in-process hardhat network only, not ${network.name}`)
  if (!DRY_RUN && chainId !== SEPOLIA_CHAIN_ID)
    throw new Error(`Addresses are Sepolia's: refusing chain ${chainId}. Use DRY_RUN=1 for a local run.`)

  const [deployer] = await ethers.getSigners()
  if (!deployer)
    throw new Error('No deployer account: run `npx hardhat vars set SEPOLIA_DEPLOYER_KEY` first.')
  const balance = await ethers.provider.getBalance(deployer.address)
  console.log(`Network ${network.name} (chain ${chainId})${DRY_RUN ? ', DRY RUN' : ''}`)
  console.log(`Deployer ${deployer.address}, balance ${ethers.formatEther(balance)} ETH`)
  if (balance < MIN_BALANCE)
    throw new Error(`Balance below ${ethers.formatEther(MIN_BALANCE)} ETH: fund the deployer first.`)
  console.log('')

  // The engine constructor takes the sign library's address, so it goes first.
  const signLib = await deploy('PolicySignLib', FQN.signLib, [COW_SETTLEMENT, PERMIT2])

  const engines: { label: string; address: string }[] = []
  for (const { label, delay } of ENGINES) {
    const { expiry, maxFreeze, freezeCooldown } = TIMING
    const args = [delay, expiry, maxFreeze, freezeCooldown, TRUSTED_BATCHES, signLib]
    engines.push({ label, address: await deploy(`SafePolicyGuardV2 (${label})`, FQN.engine, args) })
  }

  const fallbackHandler = await deploy('PolicyFallbackHandler', FQN.fallbackHandler)

  const policies = {
    freeze: await deploy('FreezePolicy', FQN.freeze),
    timelock: await deploy('TimelockPolicy', FQN.timelock),
    recipients: await deploy('RecipientsPolicy', FQN.recipients),
    limit: await deploy('LimitPolicy', FQN.limit),
    args: await deploy('ArgsPolicy', FQN.args),
    coSigner: await deploy('CoSignerPolicyV2', FQN.coSigner),
    safenet: ethers.ZeroAddress,
    quorum: await deploy('QuorumPolicyV2', FQN.quorum),
  }
  const safenet = safenetArgs(chainId)
  if (safenet) policies.safenet = await deploy('SafenetPolicyV2', FQN.safenet, safenet)
  else console.log('SafenetPolicyV2                SKIPPED: set all SAFENET_* variables (address left 0x0)')

  for (const { label, address } of engines) {
    const deployment = {
      engine: address,
      signLib,
      fallbackHandler,
      trustedBatches: TRUSTED_BATCHES,
      policies,
    }
    console.log(`\n// V2Deployment, engine DELAY ${label}`)
    console.log(JSON.stringify(deployment, null, 2))
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
