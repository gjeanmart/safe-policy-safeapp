import { readFileSync } from 'node:fs'
import { ethers, network } from 'hardhat'
import {
  DEPLOYED_V2_CONTRACTS,
  type Deploy,
  ENGINE_MODULES,
  FQN,
  SEPOLIA,
  deployEngineV2,
  deployTimelockPolicy,
  runtimeSize,
  sepoliaCreateGas,
} from './lib/v2-deployment'

/** What each engine deploys on its own: its modules and the guard. */
const ENGINE_PIECES = new Set<string>([...ENGINE_MODULES, FQN.engine])

/**
 * Deploys the Policy Engine V2 prototype (SPEC.md §5.4) on Sepolia, one contract per transaction:
 *
 *   PolicySignLib
 *   → per engine (DELAY 5 s, then 24 h): the five engine modules, then SafePolicyGuardV2
 *   → PolicyFallbackHandler → FreezePolicy → TimelockPolicyQueue → TimelockPolicy → the other policies
 *
 *   npx hardhat vars set SEPOLIA_DEPLOYER_KEY      # read by hardhat.config.ts, never by this script
 *   pnpm deploy:v2:sepolia
 *
 * Dry run on the in-process Hardhat network (no key, no RPC, same code path):
 *
 *   DRY_RUN=1 npx hardhat run scripts/deploy-v2.ts
 *
 * Fees: Sepolia's base fee is a tiny fraction of a gwei, while ethers' default tip is 1 gwei (paying
 * ~50 million times the base fee). Every transaction is therefore priced from the network: tip =
 * max(eth_maxPriorityFeePerGas × 2, PRIORITY_FEE_GWEI, default 0.001), max fee = 2 × base fee + tip,
 * and the script refuses to send above MAX_FEE_GWEI (default 1).
 *
 * Resuming: V2_REUSE=<file.json> maps a label as printed (e.g. "PolicySignLib",
 * "SafePolicyGuardV2 (5 seconds)") to { "address": "0x…", "block": 123 }. Those contracts are not
 * deployed again: the script checks they have code of the expected length and reuses them.
 *
 * Sepolia charges ~1,542 gas per byte of deployed code plus ~210k per create, and caps a
 * transaction at 2^24 gas: before each create the script checks `210,000 + 1,542 × runtime bytes`
 * stays under 16,000,000 and aborts otherwise. Prints each contract's address, gas and block, then
 * one JSON block per engine shaped like `V2Deployment` (src/lib/v2/policies.ts) and a ready-to-paste
 * `V2_ENGINES` entry for src/config/contracts.ts (its `fromBlock` is the engine's deployment block,
 * where the app starts its timelock queue scan). The policies, the sign library and the fallback
 * handler are shared: policies key their state by engine (msg.sender), so one instance serves both.
 */

const DRY_RUN = process.env.DRY_RUN === '1'
const SEPOLIA_CHAIN_ID = 11155111n
/** Fee parameters in gwei, as decimal strings (e.g. "0.001"). */
const PRIORITY_FEE_FLOOR = ethers.parseUnits(process.env.PRIORITY_FEE_GWEI ?? '0.001', 'gwei')
const MAX_FEE = ethers.parseUnits(process.env.MAX_FEE_GWEI ?? '1', 'gwei')

/** Already-deployed contracts to reuse, by label (V2_REUSE). */
type Reused = { address: string; block: number }
const REUSE: Record<string, Reused> = process.env.V2_REUSE
  ? (JSON.parse(readFileSync(process.env.V2_REUSE, 'utf8')) as Record<string, Reused>)
  : {}

/** EIP-1559 fee overrides from the network's own fee data (empty in a dry run: Hardhat's defaults). */
async function feeOverrides(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  if (DRY_RUN) return {}
  const block = await ethers.provider.getBlock('latest')
  const base = block?.baseFeePerGas ?? 0n
  const suggested = BigInt((await ethers.provider.send('eth_maxPriorityFeePerGas', [])) as string)
  const tip = suggested * 2n > PRIORITY_FEE_FLOOR ? suggested * 2n : PRIORITY_FEE_FLOOR
  const maxFeePerGas = base * 2n + tip
  if (maxFeePerGas > MAX_FEE)
    throw new Error(
      `Fee ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei is above MAX_FEE_GWEI ` +
        `(${ethers.formatUnits(MAX_FEE, 'gwei')}): wait for lower fees or raise it.`,
    )
  return { maxFeePerGas, maxPriorityFeePerGas: tip }
}
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

/** Block of each deployed contract by label, for the engines' `fromBlock`. */
const blocks = new Map<string, number>()

/** Sepolia's create cost of `fqn`; throws if it does not fit the per-transaction budget. */
async function checkedCreateGas(label: string, fqn: string): Promise<{ size: number; estimate: number }> {
  const size = await runtimeSize(fqn)
  const estimate = sepoliaCreateGas(size)
  if (estimate >= SEPOLIA.maxCreateGas)
    throw new Error(
      `${label}: ${size} bytes of runtime would cost ~${estimate.toLocaleString('en-US')} gas on Sepolia ` +
        `(${SEPOLIA.createBase} + ${SEPOLIA.gasPerByte} × ${size}), above the ${SEPOLIA.maxCreateGas.toLocaleString('en-US')} ` +
        'budget under the 2^24 transaction cap. Split the contract (SPEC.md §14, D-14) before deploying.',
    )
  return { size, estimate }
}

/** Checks the Sepolia create budget, deploys, waits, and prints address, gas and block. */
const deploy: Deploy = async (label, fqn, args) => {
  const { size, estimate } = await checkedCreateGas(label, fqn)
  const reused = REUSE[label]
  if (reused) {
    const address = ethers.getAddress(reused.address)
    const code = await ethers.provider.getCode(address)
    if ((code.length - 2) / 2 !== size)
      throw new Error(
        `${label}: V2_REUSE ${address} has ${(code.length - 2) / 2} bytes of code, expected ${size}`,
      )
    blocks.set(label, reused.block)
    console.log(
      `${label.padEnd(36)} ${address}  runtime ${String(size).padStart(5)} B  reused  block ${reused.block}`,
    )
    return address
  }
  const contract = await ethers.deployContract(fqn, args, await feeOverrides())
  const receipt = await contract.deploymentTransaction()?.wait(CONFIRMATIONS)
  if (!receipt) throw new Error(`${label}: no receipt`)
  const address = await contract.getAddress()
  blocks.set(label, receipt.blockNumber)
  console.log(
    `${label.padEnd(36)} ${address}  runtime ${String(size).padStart(5)} B  ` +
      `Sepolia est. ${String(estimate).padStart(10)}  gas ${String(receipt.gasUsed).padStart(9)}  block ${receipt.blockNumber}`,
  )
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

  // Every create must fit on its own (checked again right before each one), and the whole plan must
  // be affordable at today's fee: check both before the first transaction, so nothing is half-deployed.
  const safenet = safenetArgs(chainId)
  const plan = [
    FQN.signLib,
    ...ENGINES.flatMap(() => [...ENGINE_MODULES, FQN.engine]),
    ...DEPLOYED_V2_CONTRACTS.filter((fqn) => !ENGINE_PIECES.has(fqn) && fqn !== FQN.signLib),
  ].filter((fqn) => safenet || fqn !== FQN.safenet)
  let planned = 0
  for (const fqn of plan) planned += (await checkedCreateGas(fqn.split(':')[1], fqn)).estimate
  const reusedCount = Object.keys(REUSE).length
  const overrides = await feeOverrides()
  const fee = overrides.maxFeePerGas ?? (await ethers.provider.getFeeData()).maxFeePerGas ?? 0n
  // Upper bound: reused contracts are still counted, and the max fee is ~2x what is actually paid.
  const needed = BigInt(planned) * fee
  console.log(
    `Plan: ${plan.length} creates (${reusedCount} reused), ~${planned.toLocaleString('en-US')} gas at ` +
      `Sepolia's code pricing, at most ~${ethers.formatEther(needed)} ETH at ${ethers.formatUnits(fee, 'gwei')} gwei max fee` +
      (overrides.maxPriorityFeePerGas !== undefined
        ? ` (tip ${ethers.formatUnits(overrides.maxPriorityFeePerGas, 'gwei')} gwei)`
        : ''),
  )
  if (balance < needed)
    throw new Error(
      `Balance below the ~${ethers.formatEther(needed)} ETH the plan needs: fund the deployer first.`,
    )
  console.log('')

  // The engine constructor takes the sign library's address, so it goes first.
  const signLib = await deploy('PolicySignLib', FQN.signLib, [COW_SETTLEMENT, PERMIT2])

  const engines: { label: string; address: string }[] = []
  for (const { label, delay } of ENGINES) {
    const { expiry, maxFreeze, freezeCooldown } = TIMING
    const args = { delay, expiry, maxFreeze, freezeCooldown, trustedBatches: TRUSTED_BATCHES, signLib }
    const { engine } = await deployEngineV2(args, deploy, ` (${label})`)
    engines.push({ label, address: engine })
  }

  const fallbackHandler = await deploy('PolicyFallbackHandler', FQN.fallbackHandler, [])

  const policies = {
    freeze: await deploy('FreezePolicy', FQN.freeze, []),
    timelock: await deployTimelockPolicy(deploy),
    recipients: await deploy('RecipientsPolicy', FQN.recipients, []),
    limit: await deploy('LimitPolicy', FQN.limit, []),
    args: await deploy('ArgsPolicy', FQN.args, []),
    coSigner: await deploy('CoSignerPolicyV2', FQN.coSigner, []),
    safenet: ethers.ZeroAddress,
    quorum: await deploy('QuorumPolicyV2', FQN.quorum, []),
  }
  if (safenet) policies.safenet = await deploy('SafenetPolicyV2', FQN.safenet, safenet)
  else
    console.log(
      'SafenetPolicyV2                      SKIPPED: set all SAFENET_* variables (address left 0x0)',
    )

  for (const { label, address } of engines) {
    const deployment = {
      engine: address,
      signLib,
      fallbackHandler,
      trustedBatches: TRUSTED_BATCHES,
      policies,
    }
    const fromBlock = blocks.get(`SafePolicyGuardV2 (${label})`)!
    console.log(`\n// V2Deployment, engine DELAY ${label}: deployed in block ${fromBlock}`)
    console.log(JSON.stringify(deployment, null, 2))
    console.log(`// src/config/contracts.ts, V2_ENGINES (fromBlock: the engine's deployment block)`)
    console.log(
      `{ label: '${label}', fromBlock: ${fromBlock}n, ` +
        `deployment: parseV2Deployment(${JSON.stringify(deployment)}) },`,
    )
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
