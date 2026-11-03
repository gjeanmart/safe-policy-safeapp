import { type Address, type Hex, isAddressEqual } from 'viem'
import { type V2Deployment, deploymentNames, isDeployed, parseV2Deployment } from '../lib/v2/policies'

/** Sepolia deployments of the Safe Policy Engine (https://github.com/safe-research/policy-engine). */
export const POLICIES = {
  allow: '0x92e94Af03982C2486dffa8DcBc5d069D33996eF2',
  deny: '0x348d9F0B2fECb0bF88655C74Ed3eFD5052A9E436',
  allowedModule: '0x4736245188E315cB18b5DC2A9D7f92893D6e8CD7',
  coSigner: '0xd9f2A31C5C68422a466754cd4F4965Be2b6024FB',
  erc20Approve: '0xfF86DD4caf79672E55e0C3e3A5410746600d60F4',
  erc20Transfer: '0x25DDa3b8974a10E93ca188F9C149A42F938Bd187',
  multiSend: '0xF933Ec646F9cd6Dd27Ae2f808D133D3f5847210c',
  nativeTransfer: '0x01b792988be451C5F6327b6e2D215Ff1d4cc7246',
} as const satisfies Record<string, Address>

export type PolicyKey = keyof typeof POLICIES

export const POLICY_LABELS: Record<PolicyKey, string> = {
  allow: 'AllowPolicy',
  deny: 'DenyPolicy',
  allowedModule: 'AllowedModulePolicy',
  coSigner: 'CoSignerPolicy',
  erc20Approve: 'ERC20ApprovePolicy',
  erc20Transfer: 'ERC20TransferPolicy',
  multiSend: 'MultiSendPolicy',
  nativeTransfer: 'NativeTransferPolicy',
}

/**
 * SafePolicyGuard deployments. They share the same bytecode and only differ by the constructor
 * `DELAY` (all use a 7-day `EXPIRY`). The delay is read on-chain; the label is only a hint.
 */
export const GUARDS = [
  { address: '0x5202B1ebE100812437d47eae769e155945fbba6a', label: '5 seconds' },
  { address: '0x55c241591E12CE3c58491D02b737F12D3199ae95', label: 'no delay' },
  { address: '0xd2fB492adADBa5BcFb7FeBE25746fd5FdE090b20', label: '1 hour' },
  { address: '0x2d4527fD0E79ca1e533E3C7BBEF7e0668b700aED', label: '1 day' },
] as const satisfies readonly { address: Address; label: string }[]

export const DEFAULT_GUARD: Address = GUARDS[0].address

export type Token = { address: Address; symbol: string; decimals: number }

export const TOKENS = {
  USDC: { address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', symbol: 'USDC', decimals: 6 },
  WETH: { address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', symbol: 'WETH', decimals: 18 },
  COW: { address: '0x0625aFB445C3B6B7B929342a04A22599fd5dBB59', symbol: 'COW', decimals: 18 },
} as const satisfies Record<string, Token>

export const COW = {
  settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
  api: 'https://api.cow.fi/sepolia/api/v1',
  explorer: 'https://explorer.cow.fi/sepolia/orders',
} as const

/** Safe storage slots, see `GuardManager.GUARD_STORAGE_SLOT` / `ModuleManager.MODULE_GUARD_STORAGE_SLOT`. */
export const GUARD_STORAGE_SLOT: Hex = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
export const MODULE_GUARD_STORAGE_SLOT: Hex =
  '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947'

/** Head of the Safe module linked list. */
export const SENTINEL: Address = '0x0000000000000000000000000000000000000001'

export const EXPLORER = 'https://sepolia.etherscan.io'

/** Known addresses, used to render human-readable names. Keys are lowercased. */
export const ADDRESS_BOOK: Record<string, string> = Object.fromEntries([
  ...Object.entries(POLICIES).map(([key, address]) => [
    address.toLowerCase(),
    POLICY_LABELS[key as PolicyKey],
  ]),
  ...GUARDS.map((guard) => [guard.address.toLowerCase(), `SafePolicyGuard (${guard.label})`]),
  ...Object.values(TOKENS).map((token) => [token.address.toLowerCase(), token.symbol]),
  [COW.settlement.toLowerCase(), 'CoW GPv2Settlement'],
  [COW.vaultRelayer.toLowerCase(), 'CoW VaultRelayer'],
])

/**
 * Policy Engine V2 (contracts/contracts/v2/SPEC.md). Until it is deployed every address is a
 * zero placeholder and the app shows "V2 not deployed on this chain".
 *
 * To fill in: run `pnpm deploy:v2:sepolia` in `contracts/` and replace the entry below with the
 * printed one (`{ label: 'rev 3', deployment: parseV2Deployment({...}) }`). `parseV2Deployment`
 * validates and checksums every address; `fromBlock` (the deployment block, where the queue scan
 * starts) is part of the JSON. Safenet stays 0x0 when the deploy had no Safenet consensus: the app
 * then hides it.
 */
const V2_ZERO = '0x0000000000000000000000000000000000000000'

export type V2Engine = { label: string; deployment: V2Deployment }

export const V2_ENGINES: readonly V2Engine[] = [
  {
    // Sepolia, deployed 2026-11-03 by contracts/scripts/deploy-v2.ts (Safenet skipped: no SAFENET_* variables).
    label: 'rev 4',
    deployment: parseV2Deployment({
      engine: '0xe0Aa9874E3d4eE6fAd632d8dBCCcF8D61dfCD3B5',
      engineConfig: '0xEf696d5d3285c10C7e996D43035CB6ad97D837f0',
      trustedBatches: [
        '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
        '0xA83c336B20401Af773B6219BA5027174338D1836',
      ],
      policies: {
        timelock: '0x59a502E8A103670A0743Ba30257A8e6dCF55Cb7d',
        timelockQueue: '0x77882359557112e039E6D295DC1a7cbeBE513471',
        timelockFreeze: '0xC0192B5620E75BEdE185A16fE0c042f786cc1724',
        args: '0x196ea4bf5e99Cc18C4b401aA452C839c327D66a2',
        limit: '0xf3645eB0fD52BAAbE3F61Dd450CAB7cE982e42D5',
        coSigner: '0x6D338Fb2505262da97c61485693428929e4436d1',
        safenet: V2_ZERO,
      },
      fromBlock: 12058074,
    }),
  },
  {
    // Rev 3, superseded by rev 4. Kept only so a Safe that still runs it can schedule its uninstall
    // through the rev 3 Timelock (same schedule / execute interface); new installs use rev 4.
    label: 'rev 3 (legacy)',
    deployment: parseV2Deployment({
      engine: '0x0d08b0B71dF73F454c5c2DA2bbC4Ee82D20DdF1E',
      engineConfig: '0x647D108A63ab9050e2c1BC89e0Ac68598E452F8C',
      trustedBatches: [
        '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
        '0xA83c336B20401Af773B6219BA5027174338D1836',
      ],
      policies: {
        timelock: '0xBdA4e7B19545E61ffedf82Ac113b6d72ED1727fA',
        timelockQueue: '0xd40e50E87749Bcd9e127B6746bb1961f55812325',
        timelockFreeze: '0x4eB88b1721EcECf34537Aa29F0A10E9e10976F17',
        args: '0x5B72C80b5bA4903D0eAb3491e9dc0AF35B3317f3',
        limit: '0x814733ee7867Cf6bC521A10BaF784e1552D6d007',
        coSigner: '0x0482F1081C459D75a5c3DaF3C07D68f1c63aEa04',
        safenet: V2_ZERO,
      },
      fromBlock: 12054999,
    }),
  },
]

/** The V2 engines that exist on this chain. */
export const deployedV2Engines = (): V2Engine[] => V2_ENGINES.filter((e) => isDeployed(e.deployment))

/**
 * The deployment entry of an installed V2 engine. An engine the config does not know (deployed by
 * someone else) reuses the known policies, which serve any engine (they key state by engine).
 */
export function v2EngineFor(engine: Address): V2Engine | undefined {
  const known = V2_ENGINES.find(
    (e) => isDeployed(e.deployment) && isAddressEqual(e.deployment.engine, engine),
  )
  if (known) return known
  const base = deployedV2Engines()[0]
  return base && { label: 'unknown engine', deployment: { ...base.deployment, engine } }
}

for (const { deployment } of deployedV2Engines()) {
  const nameOf = deploymentNames(deployment)
  for (const address of [
    deployment.engine,
    deployment.engineConfig,
    ...deployment.trustedBatches,
    ...Object.values(deployment.policies),
  ]) {
    const name = nameOf(address)
    if (name) ADDRESS_BOOK[address.toLowerCase()] ??= name
  }
}
