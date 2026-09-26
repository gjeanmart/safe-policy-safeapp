import type { Address, Hex } from 'viem'

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
