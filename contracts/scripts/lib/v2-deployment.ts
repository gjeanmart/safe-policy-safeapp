import { artifacts, ethers } from 'hardhat'
import type { ISafePolicyGuardV2 } from '../../typechain-types'

/**
 * What a Policy Engine V2 deployment is made of, and how to deploy it, shared by
 * `scripts/deploy-v2.ts` and the tests (so the tests deploy exactly what the script deploys).
 *
 * Sepolia prices deployed code at ~1,542 gas per byte (plus ~210k per create) and caps a
 * transaction at 2^24 gas (EIP-7825), so no contract may exceed ~10 KB of runtime and every
 * contract is its own transaction: the engine is a guard plus five modules it DELEGATECALLs,
 * TimelockPolicy a policy plus its scheduling module (SPEC.md §14, D-14).
 */

/** Fully qualified names: some V1 vendor names (ISafe, IERC165) clash in the artifact namespace. */
export const FQN = {
  signLib: 'contracts/v2/erc1271/PolicySignLib.sol:PolicySignLib',
  engineConfig: 'contracts/v2/engine/PolicyEngineV2Config.sol:PolicyEngineV2Config',
  engineFreeze: 'contracts/v2/engine/PolicyEngineV2Freeze.sol:PolicyEngineV2Freeze',
  enginePreview: 'contracts/v2/engine/PolicyEngineV2Preview.sol:PolicyEngineV2Preview',
  engineViews: 'contracts/v2/engine/PolicyEngineV2Views.sol:PolicyEngineV2Views',
  engineRunner: 'contracts/v2/engine/PolicyEngineV2Runner.sol:PolicyEngineV2Runner',
  engine: 'contracts/v2/SafePolicyGuardV2.sol:SafePolicyGuardV2',
  fallbackHandler: 'contracts/v2/erc1271/PolicyFallbackHandler.sol:PolicyFallbackHandler',
  freeze: 'contracts/v2/policies/FreezePolicy.sol:FreezePolicy',
  timelockQueue: 'contracts/v2/policies/TimelockPolicyQueue.sol:TimelockPolicyQueue',
  timelock: 'contracts/v2/policies/TimelockPolicy.sol:TimelockPolicy',
  recipients: 'contracts/v2/policies/RecipientsPolicy.sol:RecipientsPolicy',
  limit: 'contracts/v2/policies/LimitPolicy.sol:LimitPolicy',
  args: 'contracts/v2/policies/ArgsPolicy.sol:ArgsPolicy',
  coSigner: 'contracts/v2/policies/CoSignerPolicyV2.sol:CoSignerPolicyV2',
  safenet: 'contracts/v2/policies/SafenetPolicyV2.sol:SafenetPolicyV2',
  quorum: 'contracts/v2/policies/QuorumPolicyV2.sol:QuorumPolicyV2',
} as const

/** The engine's modules, in the order of the guard's `modules` constructor argument. */
export const ENGINE_MODULES = [
  FQN.engineConfig,
  FQN.engineFreeze,
  FQN.enginePreview,
  FQN.engineViews,
  FQN.engineRunner,
] as const

/** Every contract `scripts/deploy-v2.ts` deploys (each once per engine for the engine pieces). */
export const DEPLOYED_V2_CONTRACTS: readonly string[] = [
  FQN.signLib,
  ...ENGINE_MODULES,
  FQN.engine,
  FQN.fallbackHandler,
  FQN.freeze,
  FQN.timelockQueue,
  FQN.timelock,
  FQN.recipients,
  FQN.limit,
  FQN.args,
  FQN.coSigner,
  FQN.safenet,
  FQN.quorum,
]

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

/** The engine's constructor arguments (SPEC.md §5.4), shared by the guard and its modules. */
export type EngineArgs = {
  delay: bigint
  expiry: bigint
  maxFreeze: bigint
  freezeCooldown: bigint
  trustedBatches: string[]
  signLib: string
}

/** Deploys `fqn` with `args`, waits for it, returns its address. `label` names it in logs. */
export type Deploy = (label: string, fqn: string, args: unknown[]) => Promise<string>

export const deployQuietly: Deploy = async (_label, fqn, args) => {
  const contract = await ethers.deployContract(fqn, args)
  await contract.waitForDeployment()
  return contract.getAddress()
}

export type EngineDeployment = { engine: string; modules: string[] }

/** The five modules, then the guard that DELEGATECALLs them (it checks they share its arguments). */
export async function deployEngineV2(
  args: EngineArgs,
  deploy: Deploy = deployQuietly,
  suffix = '',
): Promise<EngineDeployment> {
  const params = [
    args.delay,
    args.expiry,
    args.maxFreeze,
    args.freezeCooldown,
    args.trustedBatches,
    args.signLib,
  ]
  const modules: string[] = []
  for (const fqn of ENGINE_MODULES) modules.push(await deploy(`${fqn.split(':')[1]}${suffix}`, fqn, params))
  const engine = await deploy(`SafePolicyGuardV2${suffix}`, FQN.engine, [...params, modules])
  return { engine, modules }
}

/** The engine at `address` with its full ABI ({ISafePolicyGuardV2}). */
export async function engineAt(address: string): Promise<ISafePolicyGuardV2> {
  return (await ethers.getContractAt('ISafePolicyGuardV2', address)) as unknown as ISafePolicyGuardV2
}

/** TimelockPolicyQueue, then the TimelockPolicy that DELEGATECALLs it. */
export async function deployTimelockPolicy(deploy: Deploy = deployQuietly): Promise<string> {
  const queue = await deploy('TimelockPolicyQueue', FQN.timelockQueue, [])
  return deploy('TimelockPolicy', FQN.timelock, [queue])
}
