import { type Address, type Hex, getAddress, isAddress, isHex, parseUnits, toFunctionSelector } from 'viem'
import { SELECTORS } from './configurations'

/**
 * Form validation helpers. Each parser returns either the parsed value or a user-facing error.
 * Empty input is reported as `missing` (not an error) so forms can decide when to flag it,
 * typically only after a submit attempt.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; missing?: boolean }

const missing = (error: string): Parsed<never> => ({ ok: false, error, missing: true })
const invalid = (error: string): Parsed<never> => ({ ok: false, error })

export function parseAddressInput(input: string, what = 'address'): Parsed<Address> {
  const value = input.trim()
  if (!value) return missing(`Enter an ${what}.`)
  if (!isAddress(value, { strict: false }))
    return invalid(`Not a valid ${what} (0x followed by 40 hex characters).`)
  return { ok: true, value: getAddress(value) }
}

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

/** Comma / space separated addresses; reports the first invalid entry by position. */
export function parseAddressList(input: string): Parsed<Address[]> {
  const parts = input.split(/[\s,]+/).filter(Boolean)
  if (parts.length === 0) return missing('Enter at least one address.')
  const addresses: Address[] = []
  for (const [i, part] of parts.entries()) {
    if (!isAddress(part, { strict: false })) {
      if (parts.length === 1) return invalid('Not a valid address (0x followed by 40 hex characters).')
      const shown = part.length > 14 ? `${part.slice(0, 12)}…` : part
      return invalid(`The ${ordinal(i + 1)} address ("${shown}") is not valid.`)
    }
    addresses.push(getAddress(part))
  }
  const unique = new Set(addresses.map((a) => a.toLowerCase()))
  if (unique.size !== addresses.length) return invalid('The list contains the same address twice.')
  return { ok: true, value: addresses }
}

/** Non-negative decimal amount in token units; `required: false` treats empty as 0. */
export function parseAmountInput(input: string, decimals: number, { required = true } = {}): Parsed<bigint> {
  const value = input.trim()
  if (!value) return required ? missing('Enter an amount.') : { ok: true, value: 0n }
  if (!/^\d*\.?\d*$/.test(value) || value === '.') return invalid('Enter a positive number, e.g. 1.5')
  const fraction = value.split('.')[1] ?? ''
  if (fraction.length > decimals) return invalid(`At most ${decimals} decimals for this token.`)
  return { ok: true, value: parseUnits(value, decimals) }
}

/** `0x12345678`, a signature like `transfer(address,uint256)`, or empty for "no selector". */
export function parseSelectorInput(input: string): Parsed<Hex> {
  const value = input.trim()
  if (!value) return { ok: true, value: SELECTORS.none }
  if (value.startsWith('0x')) {
    return isHex(value) && value.length === 10
      ? { ok: true, value: value.toLowerCase() as Hex }
      : invalid('A selector is 0x followed by 8 hex characters.')
  }
  try {
    return { ok: true, value: toFunctionSelector(value) }
  } catch {
    return invalid('Not a function signature, e.g. transfer(address,uint256).')
  }
}

export function parseHexInput(input: string, what = 'Calldata'): Parsed<Hex> {
  const value = input.trim() || '0x'
  if (!isHex(value)) return invalid(`${what} must be hex (0x…).`)
  if (value.length % 2 !== 0) return invalid(`${what} must have an even number of hex characters.`)
  return { ok: true, value }
}

/**
 * The message to show under a field: invalid input always, a missing value only once the user
 * tried to submit the form.
 */
export const fieldError = (parsed: Parsed<unknown>, submitted: boolean): string | undefined =>
  parsed.ok || (parsed.missing && !submitted) ? undefined : parsed.error

/** A secp256k1 private key: 0x + 64 hex characters (the 0x prefix is added if omitted). */
export function parsePrivateKeyInput(input: string): Parsed<Hex> {
  const raw = input.trim()
  if (!raw) return missing('Paste a private key.')
  const value = (raw.startsWith('0x') ? raw : '0x' + raw).toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(value)) return invalid('A private key is 0x followed by 64 hex characters.')
  if (/^0x0+$/.test(value)) return invalid('Not a valid private key.')
  return { ok: true, value: value as Hex }
}

/** RPC endpoint URL, restricted by isAllowedRpcUrl (https, or http for a local node). */
export function parseRpcUrlInput(input: string, isAllowed: (url: string) => boolean): Parsed<string> {
  const value = input.trim()
  if (!value) return missing('Enter an RPC URL.')
  if (!isAllowed(value)) {
    return invalid('Must be https:// (plain http:// only for localhost), without credentials in the URL.')
  }
  return { ok: true, value }
}
