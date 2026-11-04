import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, getAddress, isAddress, isAddressEqual } from 'viem'
import { DEFAULT_RPC_URL } from '../../src/config/client'
import { ADDRESS_BOOK, TOKENS } from '../../src/config/contracts'
import { CliError } from './output'

/**
 * State lives in `~/.safe-role` (override with SAFE_ROLE_HOME): config, encrypted keystore, MCP
 * token and the signer's history. Plans are scratch data, kept in the temp dir.
 */
export const HOME = process.env.SAFE_ROLE_HOME ?? join(homedir(), '.safe-role')
export const CONFIG_PATH = join(HOME, 'config.json')
export const KEYSTORE_PATH = join(HOME, 'keystore.json')
export const AUDIT_PATH = join(HOME, 'audit.jsonl')
export const PLANS_DIR = process.env.SAFE_ROLE_PLANS ?? join(tmpdir(), 'safe-role', 'plans')

export const SEPOLIA_CHAIN_ID = 11155111

/**
 * What the role may do is decided on-chain by the Safe's policies, not here. The config only says
 * which Safe and role to act for, and gives names to addresses.
 */
export type Config = {
  chainId: number
  rpcUrl: string
  safe: Address
  /** The role EOA, derived from the keystore at init. */
  role: Address
  /** Names for addresses, so plans and approvals read "Owner1" instead of hex. Labels only. */
  addressBook: Record<string, Address>
  /** How far back `policies` scans guard events by default. */
  lookbackBlocks: number
  /**
   * Seconds a suggested co-signer approval / Safenet attestation stays valid beyond any Timelock
   * wait on the call (default 3600). Edit config.json to change it.
   */
  proofLifetime?: number
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new CliError(
      `No configuration at ${CONFIG_PATH}.`,
      'The user must run `safe-role init` in their own terminal first.',
    )
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config> & Pick<Config, 'safe' | 'role'>
  return {
    chainId: raw.chainId ?? SEPOLIA_CHAIN_ID,
    rpcUrl: raw.rpcUrl ?? DEFAULT_RPC_URL,
    safe: getAddress(raw.safe),
    role: getAddress(raw.role),
    addressBook: Object.fromEntries(
      Object.entries(raw.addressBook ?? {}).map(([name, address]) => [name, getAddress(address)]),
    ),
    lookbackBlocks: raw.lookbackBlocks ?? 200_000,
    ...(raw.proofLifetime !== undefined ? { proofLifetime: Number(raw.proofLifetime) } : {}),
  }
}

export function ensureHome(): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  chmodSync(HOME, 0o700)
}

export function saveConfig(config: Config): void {
  ensureHome()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/** An address and where its name came from. */
export type Resolved = {
  address: Address
  name?: string
  source: 'book' | 'safe' | 'role' | 'known' | 'unknown'
}

/** Resolves a name or address against the address book, the Safe, the role and known contracts. */
export function resolveAddress(config: Config, input: string): Resolved {
  const key = input.trim()
  const lower = key.toLowerCase()
  if (lower === 'safe') return { address: config.safe, name: 'Safe', source: 'safe' }
  if (lower === 'role') return { address: config.role, name: 'Role', source: 'role' }
  const entry = Object.entries(config.addressBook).find(([name]) => name.toLowerCase() === lower)
  if (entry) return { address: entry[1], name: entry[0], source: 'book' }
  if (!isAddress(key, { strict: false })) {
    throw new CliError(
      `"${input}" is neither an address nor a name in the address book.`,
      `Known names: ${Object.keys(config.addressBook).join(', ') || '(none)'}. Run \`safe-role book\`.`,
    )
  }
  return nameAddress(config, getAddress(key))
}

/** Looks an address up in every source the CLI knows. */
export function nameAddress(config: Config, address: Address): Resolved {
  if (isAddressEqual(address, config.safe)) return { address, name: 'Safe', source: 'safe' }
  if (isAddressEqual(address, config.role)) return { address, name: 'Role', source: 'role' }
  const entry = Object.entries(config.addressBook).find(([, a]) => isAddressEqual(a, address))
  if (entry) return { address, name: entry[0], source: 'book' }
  const known = ADDRESS_BOOK[address.toLowerCase()]
  if (known) return { address, name: known, source: 'known' }
  return { address, source: 'unknown' }
}

export const label = (r: Resolved): string => (r.name ? `${r.name} (${r.address})` : `${r.address} (unnamed)`)

export type TokenInfo = { symbol: string; address?: Address; decimals: number }

/** `ETH` or a known ERC-20 by symbol or address. */
export function resolveToken(input: string): TokenInfo {
  const upper = input.trim().toUpperCase()
  if (upper === 'ETH') return { symbol: 'ETH', decimals: 18 }
  const token = Object.values(TOKENS).find(
    (t) => t.symbol === upper || t.address.toLowerCase() === input.trim().toLowerCase(),
  )
  if (!token) {
    throw new CliError(
      `Unknown token "${input}".`,
      `Supported: ETH, ${Object.values(TOKENS)
        .map((t) => t.symbol)
        .join(', ')}.`,
    )
  }
  return { symbol: token.symbol, address: getAddress(token.address), decimals: token.decimals }
}

export const tokenByAddress = (address: Address): TokenInfo | undefined => {
  const token = Object.values(TOKENS).find((t) => isAddressEqual(t.address, address))
  return token && { symbol: token.symbol, address: getAddress(token.address), decimals: token.decimals }
}
