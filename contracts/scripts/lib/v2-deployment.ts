import { artifacts, ethers } from 'hardhat'
import type { IPolicyGuard } from '../../typechain-types'

/**
 * What a Policy Engine V2 (rev 3) deployment is made of, and how to deploy it, shared by
 * `scripts/deploy-v2.ts` and the tests (so the tests deploy exactly what the script deploys).
 *
 * Sepolia prices deployed code at ~1,542 gas per byte (plus ~210k per create) and caps a
 * transaction at 2^24 gas (EIP-7825), so no contract may exceed ~10 KB of runtime and every
 * contract is its own transaction: the engine is `PolicyGuard` plus the `PolicyGuardConfig` it
 * DELEGATECALLs, and TimelockPolicy a policy plus its `TimelockPolicyQueue` and `TimelockPolicyFreeze`.
 */

/** Fully qualified names: some V1 vendor names (ISafe, IERC165) clash in the artifact namespace. */
export const FQN = {
  engineConfig: 'contracts/v2/PolicyGuardConfig.sol:PolicyGuardConfig',
  engine: 'contracts/v2/PolicyGuard.sol:PolicyGuard',
  timelockQueue: 'contracts/v2/policies/TimelockPolicyQueue.sol:TimelockPolicyQueue',
  timelockFreeze: 'contracts/v2/policies/TimelockPolicyFreeze.sol:TimelockPolicyFreeze',
  timelock: 'contracts/v2/policies/TimelockPolicy.sol:TimelockPolicy',
  args: 'contracts/v2/policies/ArgsPolicy.sol:ArgsPolicy',
  limit: 'contracts/v2/policies/LimitPolicy.sol:LimitPolicy',
  coSigner: 'contracts/v2/policies/CoSignerPolicy.sol:CoSignerPolicy',
  safenet: 'contracts/v2/policies/SafenetPolicy.sol:SafenetPolicy',
} as const

/** Every contract `scripts/deploy-v2.ts` deploys, in deployment order (Safenet only with SAFENET_*). */
export const DEPLOYED: readonly string[] = [
  FQN.engineConfig,
  FQN.engine,
  FQN.timelockQueue,
  FQN.timelockFreeze,
  FQN.timelock,
  FQN.args,
  FQN.limit,
  FQN.coSigner,
  FQN.safenet,
]

/** The contract name of a fully qualified name; also its label in logs and in `V2_REUSE`. */
export const nameOf = (fqn: string): string => fqn.split(':')[1]

/** Largest runtime a V2 contract may have: deployable on Sepolia with margin (see SEPOLIA). */
export const MAX_RUNTIME_BYTES = 10_000

/** Sepolia's measured create cost (eth_estimateGas, reth 2.8) and the budget a create must fit. */
export const SEPOLIA = { createBase: 210_000, gasPerByte: 1_542, maxCreateGas: 16_000_000 } as const

/** `SEPOLIA.createBase + SEPOLIA.gasPerByte × runtime bytes`: what Sepolia charges for one create. */
export function sepoliaCreateGas(runtimeBytes: number): number {
  return SEPOLIA.createBase + SEPOLIA.gasPerByte * runtimeBytes
}

/** Runtime size in bytes of a compiled contract (immutables included, as zero placeholders). */
export async function runtimeSize(fqn: string): Promise<number> {
  const { deployedBytecode } = await artifacts.readArtifact(fqn)
  return (deployedBytecode.length - 2) / 2
}

const HOUR = 3600n
const DAY = 24n * HOUR

/** TimelockPolicy's immutables (SPEC §5.1): MAX_FREEZE (F) 7 days, COOLDOWN (C) 12 hours. */
export const TIMELOCK = { maxFreeze: 7n * DAY, cooldown: 12n * HOUR } as const

/** SafenetPolicy's constructor: Consensus chain id and address, genesis epoch and FROST group key. */
export type SafenetArgs = [bigint, string, bigint, { x: bigint; y: bigint }]

/**
 * Tests and dry runs only: a dummy Consensus and the secp256k1 generator as genesis key. No real
 * attestation can ever satisfy a policy built from these.
 */
export const safenetPlaceholder = (chainId: bigint): SafenetArgs => [
  chainId,
  '0x000000000000000000000000000000000000dEaD',
  0n,
  {
    x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  },
]

/**
 * What the deploy script prints, as `src/lib/v2/policies.ts` types it. `safenet` is the zero
 * address when it was not deployed; `fromBlock` is the engine's deployment block (where the app
 * starts scanning for engine and Timelock events).
 */
export type V2Deployment = {
  engine: string
  engineConfig: string
  trustedBatches: string[]
  policies: {
    timelock: string
    timelockQueue: string
    timelockFreeze: string
    args: string
    limit: string
    coSigner: string
    safenet: string
  }
  fromBlock: number
}

/** Deploys `fqn` with `args`, waits for it, returns its address. `label` names it in logs. */
export type Deploy = (label: string, fqn: string, args: unknown[]) => Promise<string>

export const deployQuietly: Deploy = async (_label, fqn, args) => {
  const contract = await ethers.deployContract(fqn, args)
  await contract.waitForDeployment()
  return contract.getAddress()
}

/** `PolicyGuardConfig`, then the `PolicyGuard` that DELEGATECALLs it (1 to 4 trusted batches). */
export async function deployEngine(
  trustedBatches: string[],
  deploy: Deploy = deployQuietly,
): Promise<{ engine: string; engineConfig: string }> {
  const engineConfig = await deploy(nameOf(FQN.engineConfig), FQN.engineConfig, [])
  const engine = await deploy(nameOf(FQN.engine), FQN.engine, [trustedBatches, engineConfig])
  return { engine, engineConfig }
}

export type PolicyOptions = {
  /** TimelockPolicy immutables; default {@link TIMELOCK}. */
  timelock?: { maxFreeze: bigint; cooldown: bigint }
  /** SafenetPolicy's constructor; skipped (zero address) when absent. */
  safenet?: SafenetArgs
}

/**
 * The policies: `TimelockPolicyQueue` and `TimelockPolicyFreeze` (built with F and C), then the
 * `TimelockPolicy` that DELEGATECALLs both, `ArgsPolicy`,
 * `LimitPolicy`, `CoSignerPolicy`, and `SafenetPolicy` when given its arguments. Policies key their
 * state by engine (msg.sender), so they do not depend on the engine's address.
 */
export async function deployPolicies(
  deploy: Deploy = deployQuietly,
  { timelock = TIMELOCK, safenet }: PolicyOptions = {},
): Promise<V2Deployment['policies']> {
  const timelockQueue = await deploy(nameOf(FQN.timelockQueue), FQN.timelockQueue, [])
  const timelockFreeze = await deploy(nameOf(FQN.timelockFreeze), FQN.timelockFreeze, [
    timelock.maxFreeze,
    timelock.cooldown,
  ])
  return {
    timelock: await deploy(nameOf(FQN.timelock), FQN.timelock, [
      timelock.maxFreeze,
      timelock.cooldown,
      timelockQueue,
      timelockFreeze,
    ]),
    timelockQueue,
    timelockFreeze,
    args: await deploy(nameOf(FQN.args), FQN.args, []),
    limit: await deploy(nameOf(FQN.limit), FQN.limit, []),
    coSigner: await deploy(nameOf(FQN.coSigner), FQN.coSigner, []),
    safenet: safenet ? await deploy(nameOf(FQN.safenet), FQN.safenet, safenet) : ethers.ZeroAddress,
  }
}

/** The engine at `address` with its full ABI ({IPolicyGuard}: the guard's own ABI is partial). */
export async function engineAt(address: string): Promise<IPolicyGuard> {
  return (await ethers.getContractAt('IPolicyGuard', address)) as unknown as IPolicyGuard
}
