import { readFileSync } from 'node:fs'
import { ethers, network } from 'hardhat'
import {
  DEPLOYED,
  type Deploy,
  FQN,
  SEPOLIA,
  type SafenetArgs,
  TIMELOCK,
  type V2Deployment,
  deployEngine,
  deployPolicies,
  nameOf,
  runtimeSize,
  safenetPlaceholder,
  sepoliaCreateGas,
} from './lib/v2-deployment'

/**
 * Deploys the Policy Engine V2 prototype (rev 4, SPEC.md) on Sepolia, one contract per transaction:
 *
 *   PolicyGuardConfig → PolicyGuard(trusted batches, config)
 *   → TimelockPolicyQueue → TimelockPolicyFreeze(F, C) → TimelockPolicy(MAX_FREEZE 7 d, COOLDOWN 12 h, queue, freezer)
 *   → ArgsPolicy → LimitPolicy → CoSignerPolicy → SafenetPolicy (only with every SAFENET_* variable)
 *
 *   npx hardhat vars set SEPOLIA_DEPLOYER_KEY      # read by hardhat.config.ts, never by this script
 *   pnpm deploy:v2:sepolia
 *
 * Dry run on the in-process Hardhat network (no key, no RPC, same code path):
 *
 *   DRY_RUN=1 npx hardhat run scripts/deploy-v2.ts
 *
 * The engine has no configuration delay of its own (the owners' Timelock is the delay), so one
 * engine serves every Safe. V2_LABEL (default "rev 4") names it in the printed config entry.
 *
 * Fees: Sepolia's base fee is a tiny fraction of a gwei, while ethers' default tip is 1 gwei (paying
 * ~50 million times the base fee). Every transaction is therefore priced from the network: tip =
 * max(eth_maxPriorityFeePerGas × 2, PRIORITY_FEE_GWEI, default 0.001), max fee = 2 × base fee + tip,
 * and the script refuses to send above MAX_FEE_GWEI (default 1).
 *
 * Resuming: V2_REUSE=<file.json> maps a contract name as printed (e.g. "PolicyGuardConfig") to
 * { "address": "0x…", "block": 123 }. Those contracts are not deployed again: the script checks they
 * have code of the expected length and reuses them.
 *
 * Sepolia charges ~1,542 gas per byte of deployed code plus ~210k per create, and caps a
 * transaction at 2^24 gas: before each create the script checks `210,000 + 1,542 × runtime bytes`
 * stays under 16,000,000 and aborts otherwise. Prints each contract's address, gas and block, then
 * the `V2Deployment` JSON block (src/lib/v2/policies.ts) and a ready-to-paste `V2_ENGINES` entry for
 * src/config/contracts.ts.
 */

const DRY_RUN = process.env.DRY_RUN === '1'
const SEPOLIA_CHAIN_ID = 11155111n
const LABEL = process.env.V2_LABEL || 'rev 4'
/** Fee parameters in gwei, as decimal strings (e.g. "0.001"). */
const PRIORITY_FEE_FLOOR = ethers.parseUnits(process.env.PRIORITY_FEE_GWEI ?? '0.001', 'gwei')
const MAX_FEE = ethers.parseUnits(process.env.MAX_FEE_GWEI ?? '1', 'gwei')
const CONFIRMATIONS = DRY_RUN ? 1 : 2

/** Already-deployed contracts to reuse, by contract name (V2_REUSE). */
type Reused = { address: string; block: number }
const REUSE: Record<string, Reused> = process.env.V2_REUSE
  ? (JSON.parse(readFileSync(process.env.V2_REUSE, 'utf8')) as Record<string, Reused>)
  : {}

// Canonical MultiSendCallOnly deployments on Sepolia (11155111), from safe-global/safe-deployments at
// 685f22be940739259cfc4148db3df7048f39a4e8: src/assets/v1.4.1/multi_send_call_only.json and
// src/assets/v1.5.0/multi_send_call_only.json ("canonical" address). 1.4.1 first: the app batches with it.
const TRUSTED_BATCHES = [
  '0x9641d764fc13c8B624c04430C7356C1C7C8102e2', // MultiSendCallOnly v1.4.1
  '0xA83c336B20401Af773B6219BA5027174338D1836', // MultiSendCallOnly v1.5.0
]

// SafenetPolicy binds a Consensus deployment and a genesis FROST group key at construction. As in V1's
// deploy (8ee68a8 deploy/deploy_contracts.ts) there is no sensible default, so it needs all five.
const SAFENET = {
  consensusChainId: process.env.SAFENET_CONSENSUS_CHAIN_ID,
  consensusAddress: process.env.SAFENET_CONSENSUS_ADDRESS,
  initialEpoch: process.env.SAFENET_INITIAL_EPOCH,
  groupKeyX: process.env.SAFENET_GROUP_KEY_X,
  groupKeyY: process.env.SAFENET_GROUP_KEY_Y,
}

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

/** Block of each deployed (or reused) contract by name, for `fromBlock`. */
const blocks = new Map<string, number>()

/** Sepolia's create cost of `fqn`; throws if it does not fit the per-transaction budget. */
async function checkedCreateGas(label: string, fqn: string): Promise<{ size: number; estimate: number }> {
  const size = await runtimeSize(fqn)
  const estimate = sepoliaCreateGas(size)
  if (estimate >= SEPOLIA.maxCreateGas)
    throw new Error(
      `${label}: ${size} bytes of runtime would cost ~${estimate.toLocaleString('en-US')} gas on Sepolia ` +
        `(${SEPOLIA.createBase} + ${SEPOLIA.gasPerByte} × ${size}), above the ` +
        `${SEPOLIA.maxCreateGas.toLocaleString('en-US')} budget under the 2^24 transaction cap. ` +
        'Split the contract before deploying.',
    )
  return { size, estimate }
}

/** The V2_REUSE address of `label`, after checking it holds code of the compiled runtime's length. */
async function checkedReuse(label: string, size: number): Promise<string> {
  const address = ethers.getAddress(REUSE[label].address)
  const length = ((await ethers.provider.getCode(address)).length - 2) / 2
  if (length !== size)
    throw new Error(`${label}: V2_REUSE ${address} has ${length} bytes of code, expected ${size}`)
  return address
}

/** Checks the Sepolia create budget, deploys (or reuses), waits, and prints address, gas and block. */
const deploy: Deploy = async (label, fqn, args) => {
  const { size, estimate } = await checkedCreateGas(label, fqn)
  const reused = REUSE[label]
  if (reused) {
    const address = await checkedReuse(label, size)
    blocks.set(label, reused.block)
    console.log(
      `${label.padEnd(20)} ${address}  runtime ${String(size).padStart(5)} B  reused  block ${reused.block}`,
    )
    return address
  }
  const contract = await ethers.deployContract(fqn, args, await feeOverrides())
  const receipt = await contract.deploymentTransaction()?.wait(CONFIRMATIONS)
  if (!receipt) throw new Error(`${label}: no receipt`)
  const address = await contract.getAddress()
  blocks.set(label, receipt.blockNumber)
  console.log(
    `${label.padEnd(20)} ${address}  runtime ${String(size).padStart(5)} B  ` +
      `Sepolia est. ${String(estimate).padStart(10)}  gas ${String(receipt.gasUsed).padStart(9)}  ` +
      `block ${receipt.blockNumber}`,
  )
  return address
}

function safenetArgs(chainId: bigint): SafenetArgs | undefined {
  const { consensusChainId, consensusAddress, initialEpoch, groupKeyX, groupKeyY } = SAFENET
  if (consensusChainId && consensusAddress && initialEpoch && groupKeyX && groupKeyY)
    return [
      BigInt(consensusChainId),
      ethers.getAddress(consensusAddress),
      BigInt(initialEpoch),
      { x: BigInt(groupKeyX), y: BigInt(groupKeyY) },
    ]
  if (DRY_RUN) {
    console.log('SafenetPolicy: SAFENET_* not set, dry run deploys it with a PLACEHOLDER consensus/key')
    return safenetPlaceholder(chainId)
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

  // Every create must fit on its own (checked again right before each one), every reused contract must
  // hold the expected code, and the whole plan must be affordable at today's fee: check all three before
  // the first transaction, so nothing is half-deployed.
  const safenet = safenetArgs(chainId)
  const plan = DEPLOYED.filter((fqn) => safenet || fqn !== FQN.safenet)
  let planned = 0
  let reusedCount = 0
  for (const fqn of plan) {
    const label = nameOf(fqn)
    const { size, estimate } = await checkedCreateGas(label, fqn)
    if (REUSE[label]) {
      await checkedReuse(label, size)
      reusedCount++
    } else planned += estimate
  }
  const overrides = await feeOverrides()
  const fee = overrides.maxFeePerGas ?? (await ethers.provider.getFeeData()).maxFeePerGas ?? 0n
  // Upper bound: the max fee is ~2x what is actually paid.
  const needed = BigInt(planned) * fee
  console.log(
    `Plan: ${plan.length} creates (${reusedCount} reused), ~${planned.toLocaleString('en-US')} gas at ` +
      `Sepolia's code pricing, at most ~${ethers.formatEther(needed)} ETH at ` +
      `${ethers.formatUnits(fee, 'gwei')} gwei max fee` +
      (overrides.maxPriorityFeePerGas !== undefined
        ? ` (tip ${ethers.formatUnits(overrides.maxPriorityFeePerGas, 'gwei')} gwei)`
        : ''),
  )
  if (balance < needed)
    throw new Error(
      `Balance below the ~${ethers.formatEther(needed)} ETH the plan needs: fund the deployer first.`,
    )
  console.log(
    `TimelockPolicy MAX_FREEZE ${TIMELOCK.maxFreeze} s, COOLDOWN ${TIMELOCK.cooldown} s; ` +
      `trusted batches ${TRUSTED_BATCHES.join(', ')}\n`,
  )

  const { engine, engineConfig } = await deployEngine(TRUSTED_BATCHES, deploy)
  const policies = await deployPolicies(deploy, { timelock: TIMELOCK, safenet })
  if (!safenet)
    console.log(`${nameOf(FQN.safenet).padEnd(20)} SKIPPED: set all SAFENET_* variables (address left 0x0)`)

  const deployment: V2Deployment = {
    engine,
    engineConfig,
    trustedBatches: TRUSTED_BATCHES,
    policies,
    fromBlock: blocks.get(nameOf(FQN.engine))!,
  }
  const json = JSON.stringify(deployment, null, 2)
  console.log(`\n// V2Deployment (${LABEL}): engine deployed in block ${deployment.fromBlock}`)
  console.log(json)
  console.log('\n// src/config/contracts.ts, V2_ENGINES entry')
  console.log(`{ label: '${LABEL}', deployment: parseV2Deployment(${JSON.stringify(deployment)}) },`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
