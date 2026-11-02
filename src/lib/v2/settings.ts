import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  formatUnits,
  getAbiItem,
  getAddress,
  isAddressEqual,
  maxUint256,
  size,
  zeroAddress,
} from 'viem'
import {
  argsPolicyAbi,
  coSignerPolicyV2Abi,
  freezePolicyAbi,
  limitPolicyAbi,
  quorumPolicyV2Abi,
  recipientsPolicyAbi,
  timelockPolicyAbi,
} from './abi'
import { type PolicyName, selectorName } from './policies'

/**
 * Per-policy settings (SPEC §8): `abi.encode(Settings)` of the struct in each policy interface,
 * encoded with that interface's `encodeSettings` inputs so the ABI is the single source of the
 * layout. `validateSettings` mirrors each policy's `InvalidSettings` rules so the builder can
 * refuse a change before the engine's `configure` would revert.
 *
 * @example
 * const data = encodeSettings({ policy: 'limit', settings: { limits: [{ token: USDC, amount: 5_000_000_000n, period: 2_592_000n }], passUnpriced: false } })
 * decodeSettings('limit', data) // → the same object
 * settingsLabel({ policy: 'limit', settings: … }, { tokenOf: () => ({ symbol: 'USDC', decimals: 6 }) })
 * // → 'Limit 5,000 USDC / month'
 */

// ---------------------------------------------------------------------------------------------
// Types (mirror the Solidity structs; uint ≤ 48 bits are numbers, wider ones bigints, as viem)
// ---------------------------------------------------------------------------------------------

export type FreezeSettings = { safeWide: boolean; actor: boolean }

export type TimelockSettings = {
  /** Seconds (> 0); the engine requires `DELAY ≥ delay` at actor ANY / OWNERS. */
  delay: number
  /** Seconds a matured schedule stays executable; 0 = no expiry. */
  window: number
  clearOnFreeze: boolean
  cancellers: readonly Address[]
}

export type RecipientsSettings = {
  recipients: readonly Address[]
  spenders: readonly Address[]
  /** `maxUint256` allows unlimited approvals. */
  maxApproval: bigint
  strict: boolean
}

/** `token = address(0)` is the native token; `period` in seconds, 0 = one-time budget. */
export type TokenLimit = { token: Address; amount: bigint; period: bigint }
export type LimitSettings = { limits: readonly TokenLimit[]; passUnpriced: boolean }

export const ArgOp = { EQ: 0, NEQ: 1, IN: 2, NOT_IN: 3, LTE: 4, GTE: 5, EQ_SAFE: 6 } as const
export type ArgOp = (typeof ArgOp)[keyof typeof ArgOp]
export type ArgConstraint = { selector: Hex; argIndex: number; op: ArgOp; values: readonly Hex[] }
export type ArgsSettings = { constraints: readonly ArgConstraint[]; strict: boolean }

export type CoSignerSettings = { cosigner: Address }

export type QuorumTier = { token: Address; above: bigint; required: number }
export type QuorumSettings = { required: number; tiers: readonly QuorumTier[] }

/** A policy and its settings; Safenet has none (`data` is empty). */
export type PolicySettings =
  | { policy: 'freeze'; settings: FreezeSettings }
  | { policy: 'timelock'; settings: TimelockSettings }
  | { policy: 'recipients'; settings: RecipientsSettings }
  | { policy: 'limit'; settings: LimitSettings }
  | { policy: 'args'; settings: ArgsSettings }
  | { policy: 'coSigner'; settings: CoSignerSettings }
  | { policy: 'safenet'; settings: null }
  | { policy: 'quorum'; settings: QuorumSettings }

// ---------------------------------------------------------------------------------------------
// Caps (SPEC §8.x)
// ---------------------------------------------------------------------------------------------

export const MAX_CANCELLERS = 8
export const MAX_LIST_ENTRIES = 64
export const MAX_TOKEN_LIMITS = 16
export const MAX_ARG_CONSTRAINTS = 16
export const MAX_ARG_VALUES = 32
export const MAX_QUORUM_TIERS = 8

export const HOUR = 3600
export const DAY = 86_400
export const WEEK = 7 * DAY
/** "Month" budgets are 30-day windows (fixed grid, SPEC §8.4). */
export const MONTH = 30 * DAY

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

const inputs = {
  freeze: getAbiItem({ abi: freezePolicyAbi, name: 'encodeSettings' }).inputs,
  timelock: getAbiItem({ abi: timelockPolicyAbi, name: 'encodeSettings' }).inputs,
  recipients: getAbiItem({ abi: recipientsPolicyAbi, name: 'encodeSettings' }).inputs,
  limit: getAbiItem({ abi: limitPolicyAbi, name: 'encodeSettings' }).inputs,
  args: getAbiItem({ abi: argsPolicyAbi, name: 'encodeSettings' }).inputs,
  coSigner: getAbiItem({ abi: coSignerPolicyV2Abi, name: 'encodeSettings' }).inputs,
  quorum: getAbiItem({ abi: quorumPolicyV2Abi, name: 'encodeSettings' }).inputs,
}

/** `abi.encode(Settings)`, the `data` of a POLICY AttachmentChange. */
export function encodeSettings(value: PolicySettings): Hex {
  switch (value.policy) {
    case 'freeze':
      return encodeAbiParameters(inputs.freeze, [value.settings])
    case 'timelock':
      return encodeAbiParameters(inputs.timelock, [value.settings])
    case 'recipients':
      return encodeAbiParameters(inputs.recipients, [value.settings])
    case 'limit':
      return encodeAbiParameters(inputs.limit, [value.settings])
    case 'args':
      return encodeAbiParameters(inputs.args, [value.settings])
    case 'coSigner':
      return encodeAbiParameters(inputs.coSigner, [value.settings])
    case 'safenet':
      return '0x'
    case 'quorum':
      return encodeAbiParameters(inputs.quorum, [value.settings])
  }
}

/** Inverse of {@link encodeSettings}; throws on malformed data. */
export function decodeSettings(policy: PolicyName, data: Hex): PolicySettings {
  switch (policy) {
    case 'freeze':
      return { policy, settings: decodeAbiParameters(inputs.freeze, data)[0] }
    case 'timelock':
      return { policy, settings: decodeAbiParameters(inputs.timelock, data)[0] }
    case 'recipients':
      return { policy, settings: decodeAbiParameters(inputs.recipients, data)[0] }
    case 'limit':
      return { policy, settings: decodeAbiParameters(inputs.limit, data)[0] }
    case 'args': {
      const decoded = decodeAbiParameters(inputs.args, data)[0]
      return {
        policy,
        settings: {
          strict: decoded.strict,
          constraints: decoded.constraints.map((c) => ({ ...c, op: c.op as ArgOp })),
        },
      }
    }
    case 'coSigner':
      return { policy, settings: decodeAbiParameters(inputs.coSigner, data)[0] }
    case 'safenet':
      if (size(data) !== 0) throw new Error('Safenet takes no settings')
      return { policy, settings: null }
    case 'quorum':
      return { policy, settings: decodeAbiParameters(inputs.quorum, data)[0] }
  }
}

/**
 * Settings as returned by a policy's `getSettings` view (same struct as the encoding). Safenet has
 * no `getSettings`: pass `null`.
 */
export function settingsFromView(policy: PolicyName, view: unknown): PolicySettings {
  if (policy === 'safenet') return { policy, settings: null }
  // The view returns the exact struct `encodeSettings` takes, so a round trip normalizes it.
  return decodeSettings(policy, encodeSettings({ policy, settings: view } as PolicySettings))
}

export function defaultSettings(policy: PolicyName): PolicySettings {
  switch (policy) {
    case 'freeze':
      return { policy, settings: { safeWide: true, actor: true } }
    case 'timelock':
      return { policy, settings: { delay: DAY, window: 0, clearOnFreeze: true, cancellers: [] } }
    case 'recipients':
      return { policy, settings: { recipients: [], spenders: [], maxApproval: maxUint256, strict: false } }
    case 'limit':
      return { policy, settings: { limits: [], passUnpriced: false } }
    case 'args':
      return { policy, settings: { constraints: [], strict: false } }
    case 'coSigner':
      return { policy, settings: { cosigner: zeroAddress } }
    case 'safenet':
      return { policy, settings: null }
    case 'quorum':
      return { policy, settings: { required: 2, tiers: [] } }
  }
}

// ---------------------------------------------------------------------------------------------
// Validation (mirrors InvalidSettings)
// ---------------------------------------------------------------------------------------------

const hasDuplicates = (addresses: readonly Address[]): boolean =>
  new Set(addresses.map((a) => a.toLowerCase())).size !== addresses.length

const isZero = (address: Address): boolean => isAddressEqual(address, zeroAddress)

/** Problems that would make `configure` revert `InvalidSettings()`; empty when valid. */
export function validateSettings(value: PolicySettings): string[] {
  const errors: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) errors.push(message)
  }
  switch (value.policy) {
    case 'freeze':
      check(value.settings.safeWide || value.settings.actor, 'Pick at least one freeze to read')
      break
    case 'timelock': {
      const { delay, window, cancellers } = value.settings
      check(
        Number.isInteger(delay) && delay > 0 && delay < 2 ** 32,
        'Delay must be between 1 second and ~136 years',
      )
      check(Number.isInteger(window) && window >= 0 && window < 2 ** 32, 'Invalid execution window')
      check(cancellers.length <= MAX_CANCELLERS, `At most ${MAX_CANCELLERS} cancellers`)
      check(!cancellers.some(isZero), 'A canceller cannot be the zero address')
      break
    }
    case 'recipients': {
      const { recipients, spenders } = value.settings
      check(recipients.length <= MAX_LIST_ENTRIES, `At most ${MAX_LIST_ENTRIES} recipients`)
      check(spenders.length <= MAX_LIST_ENTRIES, `At most ${MAX_LIST_ENTRIES} spenders`)
      check(!hasDuplicates(recipients) && !hasDuplicates(spenders), 'Duplicate address in a list')
      break
    }
    case 'limit': {
      const { limits } = value.settings
      check(limits.length <= MAX_TOKEN_LIMITS, `At most ${MAX_TOKEN_LIMITS} tokens`)
      check(!hasDuplicates(limits.map((l) => l.token)), 'A token appears twice')
      check(
        limits.every((l) => l.amount > 0n && l.amount < 2n ** 128n),
        'Every budget must be a positive amount',
      )
      check(
        limits.every((l) => l.period >= 0n && l.period < 2n ** 64n),
        'Invalid period',
      )
      break
    }
    case 'args': {
      const { constraints } = value.settings
      check(constraints.length <= MAX_ARG_CONSTRAINTS, `At most ${MAX_ARG_CONSTRAINTS} constraints`)
      for (const c of constraints) {
        // EQ / NEQ / LTE / GTE read values[0], IN / NOT_IN the list; EQ_SAFE reads none.
        if (c.op !== ArgOp.EQ_SAFE) check(c.values.length >= 1, 'This comparison needs a value')
        check(c.values.length <= MAX_ARG_VALUES, `At most ${MAX_ARG_VALUES} values per constraint`)
        check(
          c.values.every((v) => size(v) === 32),
          'Values are 32-byte words',
        )
        check(
          Number.isInteger(c.argIndex) && c.argIndex >= 0 && c.argIndex < 2 ** 16,
          'Invalid argument index',
        )
      }
      break
    }
    case 'coSigner':
      check(!isZero(value.settings.cosigner), 'Pick a co-signer')
      break
    case 'safenet':
      break
    case 'quorum': {
      const { required, tiers } = value.settings
      check(Number.isInteger(required) && required >= 1 && required < 256, 'At least 1 signature required')
      check(tiers.length <= MAX_QUORUM_TIERS, `At most ${MAX_QUORUM_TIERS} tiers`)
      check(
        tiers.every((t) => Number.isInteger(t.required) && t.required >= 1 && t.required < 256),
        'Every tier needs at least 1 signature',
      )
      break
    }
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export type TokenInfo = { symbol: string; decimals: number }

export type LabelContext = {
  /** Token metadata for amounts; unknown tokens are shown in base units. */
  tokenOf?: (token: Address) => TokenInfo | undefined
  /** Address book (vendor names, Safes, ...). */
  nameOf?: (address: Address) => string | undefined
  /** Native token symbol (default ETH). */
  nativeSymbol?: string
}

const short = (address: Address): string => `${address.slice(0, 6)}…${address.slice(-4)}`

export const addressLabel = (address: Address, ctx: LabelContext = {}): string =>
  ctx.nameOf?.(getAddress(address)) ?? short(address)

const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** `5,000`, `1.25`, `unlimited` for `maxUint256`. */
export function formatTokenAmount(amount: bigint, decimals: number, digits = 4): string {
  if (amount === maxUint256) return 'unlimited'
  const [whole = '0', fraction = ''] = formatUnits(amount, decimals).split('.')
  const trimmed = fraction.slice(0, digits).replace(/0+$/, '')
  return trimmed ? `${group(whole)}.${trimmed}` : group(whole)
}

/** `5,000 USDC`; native for `address(0)`; base units for unknown tokens. */
export function amountLabel(token: Address, amount: bigint, ctx: LabelContext = {}): string {
  if (isZero(token)) return `${formatTokenAmount(amount, 18)} ${ctx.nativeSymbol ?? 'ETH'}`
  const info = ctx.tokenOf?.(getAddress(token))
  return info
    ? `${formatTokenAmount(amount, info.decimals)} ${info.symbol}`
    : `${formatTokenAmount(amount, 0)} units of ${addressLabel(token, ctx)}`
}

/** `24h`, `72h`, `7d`, `30m`, `45s`: hours up to 3 days, as the UI presets. */
export function durationLabel(seconds: number | bigint): string {
  const s = Number(seconds)
  if (s < 60 || s % 60 !== 0) return `${s}s`
  if (s < HOUR || s % HOUR !== 0) return `${s / 60}m`
  if (s <= 3 * DAY || s % DAY !== 0) return `${s / HOUR}h`
  return `${s / DAY}d`
}

/** `/ month`, `/ day`, `one-time`, `/ 3d`. */
export function periodLabel(period: bigint): string {
  const named: Record<number, string> = { [HOUR]: 'hour', [DAY]: 'day', [WEEK]: 'week', [MONTH]: 'month' }
  if (period === 0n) return 'one-time'
  return `/ ${named[Number(period)] ?? durationLabel(period)}`
}

const listLabel = (addresses: readonly Address[], ctx: LabelContext): string =>
  addresses.length === 0 ? 'none' : addresses.map((a) => addressLabel(a, ctx)).join(', ')

const ARG_OP_LABELS: Record<ArgOp, string> = {
  0: '==',
  1: '!=',
  2: 'in',
  3: 'not in',
  4: '≤',
  5: '≥',
  6: '== Safe',
}

export function argConstraintLabel(c: ArgConstraint): string {
  const fn = selectorName(c.selector) ?? c.selector
  const values =
    c.op === ArgOp.EQ_SAFE ? '' : c.values.length === 1 ? ` ${BigInt(c.values[0]!)}` : ` [${c.values.length}]`
  return `${fn} arg ${c.argIndex} ${ARG_OP_LABELS[c.op]}${values}`
}

/**
 * One-line chip label: `Limit 5,000 USDC / month`, `Timelock 24h, cancellable by Spark Safe`,
 * `Recipients: vendor A, vendor B`, `Quorum 3 (5 above 10,000 USDC)`.
 */
export function settingsLabel(value: PolicySettings, ctx: LabelContext = {}): string {
  switch (value.policy) {
    case 'freeze': {
      const { safeWide, actor } = value.settings
      return `Freeze (${[safeWide && 'Safe-wide', actor && 'actor'].filter(Boolean).join(' + ')})`
    }
    case 'timelock': {
      const { delay, window, clearOnFreeze, cancellers } = value.settings
      const parts = [`Timelock ${durationLabel(delay)}`]
      if (window) parts.push(`expires after ${durationLabel(window)}`)
      if (cancellers.length) parts.push(`cancellable by ${listLabel(cancellers, ctx)}`)
      if (!clearOnFreeze) parts.push('survives a freeze')
      return parts.join(', ')
    }
    case 'recipients': {
      const { recipients, spenders, maxApproval, strict } = value.settings
      const parts = [`Recipients: ${listLabel(recipients, ctx)}`]
      if (spenders.length) parts.push(`spenders: ${listLabel(spenders, ctx)}`)
      if (maxApproval !== maxUint256) parts.push(`approvals ≤ ${formatTokenAmount(maxApproval, 0)} units`)
      if (strict) parts.push('other calls denied')
      return parts.join('; ')
    }
    case 'limit': {
      const { limits, passUnpriced } = value.settings
      const budgets = limits.map((l) => `${amountLabel(l.token, l.amount, ctx)} ${periodLabel(l.period)}`)
      return `Limit ${budgets.join(', ') || '(no token)'}${passUnpriced ? ' (unpriced calls pass)' : ''}`
    }
    case 'args': {
      const { constraints, strict } = value.settings
      return `Arguments: ${constraints.map(argConstraintLabel).join(', ') || 'none'}${strict ? ' (strict)' : ''}`
    }
    case 'coSigner':
      return `Co-signer ${addressLabel(value.settings.cosigner, ctx)}`
    case 'safenet':
      return 'Safenet attestation'
    case 'quorum': {
      const { required, tiers } = value.settings
      const tierLabels = tiers.map((t) => `${t.required} above ${amountLabel(t.token, t.above, ctx)}`)
      return `Quorum ${required}${tierLabels.length ? ` (${tierLabels.join(', ')})` : ''}`
    }
  }
}
