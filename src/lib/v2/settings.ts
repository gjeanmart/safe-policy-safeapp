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
  pad,
  size,
  zeroAddress,
} from 'viem'
import { argsPolicyAbi, coSignerPolicyAbi, limitPolicyAbi, timelockPolicyAbi } from './abi'
import { type PolicyName, SELECTORS, selectorName } from './policies'
import {
  ANY_SELECTOR,
  ArgsOp,
  ArgsTarget,
  MAX_ARGS_CONSTRAINTS,
  MAX_ARGS_VALUES,
  MAX_LIMIT_TOKENS,
  MAX_ROLE_MEMBERS,
  isAny,
} from './scopes'

/**
 * Per-policy settings (SPEC.md §5): `abi.encode(Settings)` of the struct in each policy interface,
 * encoded with that interface's `encodeSettings` inputs so the ABI is the single source of the
 * layout. `validateSettings` mirrors each policy's `InvalidSettings` rules so the builder refuses a
 * change before `configure` would revert.
 *
 * @example
 * const data = encodeSettings({ policy: 'limit', settings: { limits: [{ token: USDC, amount: 5_000_000_000n, period: 2_592_000n }], passUnpriced: false } })
 * decodeSettings('limit', data) // → the same object
 * settingsLabel(decodeSettings('limit', data), { tokenOf }) // → 'Budget 5,000 USDC / month'
 */

// ---------------------------------------------------------------------------------------------
// Types (mirror the Solidity structs; uint ≤ 48 bits are numbers, wider ones bigints, as viem)
// ---------------------------------------------------------------------------------------------

export type TimelockSettings = {
  /** Seconds; 0 = kill switch only (freeze, no schedule). */
  delay: number
  /** Seconds a matured schedule stays executable; 0 = never expires. */
  window: number
  guardians: readonly Address[]
  lifters: readonly Address[]
  cancellers: readonly Address[]
}

export type ArgsConstraint = {
  /** A selector, or `ANY_SELECTOR` (every call of the attachment); `0x00000000` = empty calldata. */
  selector: Hex
  target: ArgsTarget
  /** Head word index for WORD, else 0. */
  index: number
  op: ArgsOp
  /** ABI words (addresses left-padded). */
  values: readonly Hex[]
}
export type ArgsSettings = { constraints: readonly ArgsConstraint[]; strict: boolean }

/** `token = address(0)` is the native token; `period` in seconds, 0 = one-time budget. */
export type TokenLimit = { token: Address; amount: bigint; period: bigint }
export type LimitSettings = { limits: readonly TokenLimit[]; passUnpriced: boolean }

export type CoSignerSettings = { approvers: readonly Address[]; required: number }

/** A policy and its settings; Safenet has none (`settings` is empty). */
export type PolicySettings =
  | { policy: 'timelock'; settings: TimelockSettings }
  | { policy: 'args'; settings: ArgsSettings }
  | { policy: 'limit'; settings: LimitSettings }
  | { policy: 'coSigner'; settings: CoSignerSettings }
  | { policy: 'safenet'; settings: null }

export const MINUTE = 60
export const HOUR = 3600
export const DAY = 86_400
export const WEEK = 7 * DAY
/** "Month" budgets are 30-day windows (fixed grid anchored at configure). */
export const MONTH = 30 * DAY

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

const inputs = {
  timelock: getAbiItem({ abi: timelockPolicyAbi, name: 'encodeSettings' }).inputs,
  args: getAbiItem({ abi: argsPolicyAbi, name: 'encodeSettings' }).inputs,
  limit: getAbiItem({ abi: limitPolicyAbi, name: 'encodeSettings' }).inputs,
  coSigner: getAbiItem({ abi: coSignerPolicyAbi, name: 'encodeSettings' }).inputs,
}

/** `abi.encode(Settings)`, the `settings` of a POLICY change. */
export function encodeSettings(value: PolicySettings): Hex {
  switch (value.policy) {
    case 'timelock':
      return encodeAbiParameters(inputs.timelock, [value.settings])
    case 'args':
      return encodeAbiParameters(inputs.args, [value.settings])
    case 'limit':
      return encodeAbiParameters(inputs.limit, [value.settings])
    case 'coSigner':
      return encodeAbiParameters(inputs.coSigner, [value.settings])
    case 'safenet':
      return '0x'
  }
}

/** Inverse of {@link encodeSettings}; throws on malformed data. */
export function decodeSettings(policy: PolicyName, data: Hex): PolicySettings {
  switch (policy) {
    case 'timelock':
      return { policy, settings: decodeAbiParameters(inputs.timelock, data)[0] }
    case 'args': {
      const decoded = decodeAbiParameters(inputs.args, data)[0]
      return {
        policy,
        settings: {
          strict: decoded.strict,
          constraints: decoded.constraints.map((c) => ({
            ...c,
            target: c.target as ArgsTarget,
            op: c.op as ArgsOp,
          })),
        },
      }
    }
    case 'limit':
      return { policy, settings: decodeAbiParameters(inputs.limit, data)[0] }
    case 'coSigner':
      return { policy, settings: decodeAbiParameters(inputs.coSigner, data)[0] }
    case 'safenet':
      if (size(data) !== 0) throw new Error('Safenet takes no settings')
      return { policy, settings: null }
  }
}

/** Settings as returned by a policy's `getSettings` view (the struct `encodeSettings` takes). */
export function settingsFromView(policy: PolicyName, view: unknown): PolicySettings {
  if (policy === 'safenet') return { policy, settings: null }
  // A round trip through the ABI normalizes the view's readonly tuples into the TS types.
  return decodeSettings(policy, encodeSettings({ policy, settings: view } as PolicySettings))
}

// ---------------------------------------------------------------------------------------------
// Validation (mirrors InvalidSettings and the other configure-time reverts of each policy)
// ---------------------------------------------------------------------------------------------

const duplicates = (addresses: readonly Address[]): boolean =>
  new Set(addresses.map((a) => a.toLowerCase())).size !== addresses.length

const isZero = (address: Address): boolean => isAddressEqual(address, zeroAddress)

export type SettingsContext = {
  /** The Safe: never a guardian, lifter, canceller or approver. */
  safe: Address
  /** The attachment's actor: no guardians or lifters at actor ANY. */
  actor: Address
}

/** Problems that would make the policy's `configure` revert; empty when valid. */
export function validateSettings(value: PolicySettings, context: SettingsContext): string[] {
  const errors: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) errors.push(message)
  }
  const list = (addresses: readonly Address[], what: string, max = MAX_ROLE_MEMBERS) => {
    check(addresses.length <= max, max === 0 ? `No ${what} for Everyone` : `At most ${max} ${what}`)
    check(!addresses.some(isZero), `A ${what.replace(/s$/, '')} cannot be the zero address`)
    check(
      !addresses.some((a) => isAddressEqual(a, context.safe)),
      `The Safe itself cannot be a ${what.replace(/s$/, '')}`,
    )
    check(!duplicates(addresses), `Duplicate in ${what}`)
  }
  switch (value.policy) {
    case 'timelock': {
      const { delay, window, guardians, lifters, cancellers } = value.settings
      check(Number.isInteger(delay) && delay >= 0 && delay < 2 ** 32, 'Invalid delay')
      check(Number.isInteger(window) && window >= 0 && window < 2 ** 32, 'Invalid execution window')
      // A guardian at actor ANY could freeze recovery too.
      const roleCap = isAny(context.actor) ? 0 : MAX_ROLE_MEMBERS
      list(guardians, 'guardians', roleCap)
      list(lifters, 'lifters', roleCap)
      list(cancellers, 'cancellers')
      break
    }
    case 'args': {
      const { constraints, strict } = value.settings
      check(constraints.length <= MAX_ARGS_CONSTRAINTS, `At most ${MAX_ARGS_CONSTRAINTS} conditions`)
      check(constraints.length > 0 || strict, 'No condition: add one, or tick "deny other calls"')
      for (const c of constraints) {
        check(c.target === ArgsTarget.WORD || c.index === 0, 'Only an argument condition has an index')
        check(Number.isInteger(c.index) && c.index >= 0 && c.index < 2 ** 16, 'Invalid argument index')
        check(
          c.values.every((v) => size(v) === 32),
          'Values are 32-byte words',
        )
        if (c.op === ArgsOp.EQ_SAFE) check(c.values.length === 0, '"is the Safe" takes no value')
        else if (c.op === ArgsOp.IN || c.op === ArgsOp.NOT_IN)
          check(
            c.values.length >= 1 && c.values.length <= MAX_ARGS_VALUES,
            `A list takes 1 to ${MAX_ARGS_VALUES} values`,
          )
        else check(c.values.length === 1, 'This comparison takes exactly one value')
      }
      break
    }
    case 'limit': {
      const { limits } = value.settings
      check(limits.length >= 1 && limits.length <= MAX_LIMIT_TOKENS, `1 to ${MAX_LIMIT_TOKENS} tokens`)
      check(!duplicates(limits.map((l) => l.token)), 'A token appears twice')
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
    case 'coSigner': {
      const { approvers, required } = value.settings
      check(approvers.length >= 1, 'At least one approver')
      list(approvers, 'approvers')
      check(
        Number.isInteger(required) && required >= 1 && required <= approvers.length,
        `Required must be between 1 and ${approvers.length || 1}`,
      )
      break
    }
    case 'safenet':
      break
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Args presets (SPEC.md §5.2): what the app shows as "Allow + conditions"
// ---------------------------------------------------------------------------------------------

export const addressWord = (address: Address): Hex => pad(address.toLowerCase() as Hex, { size: 32 })
export const uintWord = (value: bigint): Hex => pad(`0x${value.toString(16)}`, { size: 32 })
export const wordAddress = (word: Hex): Address => getAddress(`0x${word.slice(-40)}`)

export type ArgsPreset = 'recipients' | 'spenders' | 'receiverIsSafe'

export const ARGS_PRESETS: Record<ArgsPreset, { label: string; help: string }> = {
  recipients: {
    label: 'Recipients',
    help: 'transfer / transferFrom pay only these addresses; native value goes only to them, whatever the calldata (list a protocol you pay ETH to).',
  },
  spenders: {
    label: 'Spenders',
    help: 'approve only these spenders, optionally up to a cap per approval.',
  },
  receiverIsSafe: {
    label: 'Receiver is the Safe',
    help: 'One argument of the function (the receiver / onBehalfOf of a protocol call) must be the Safe.',
  },
}

/**
 * `transfer` word 0 IN, `transferFrom` word 1 IN, and any call with value: VALUE_TO IN. Tokens by
 * `transfer` / `transferFrom`, ETH by destination whatever the calldata (a payable protocol call
 * needs the protocol listed).
 */
export const recipientsConstraints = (recipients: readonly Address[]): ArgsConstraint[] => {
  const values = recipients.map(addressWord)
  return [
    { selector: SELECTORS.transfer, target: ArgsTarget.WORD, index: 0, op: ArgsOp.IN, values },
    { selector: SELECTORS.transferFrom, target: ArgsTarget.WORD, index: 1, op: ArgsOp.IN, values },
    { selector: ANY_SELECTOR, target: ArgsTarget.VALUE_TO, index: 0, op: ArgsOp.IN, values },
  ]
}

/** `approve` word 0 IN spenders, and word 1 ≤ `cap` when given. */
export const spendersConstraints = (spenders: readonly Address[], cap?: bigint): ArgsConstraint[] => [
  {
    selector: SELECTORS.approve,
    target: ArgsTarget.WORD,
    index: 0,
    op: ArgsOp.IN,
    values: spenders.map(addressWord),
  },
  ...(cap === undefined
    ? []
    : [
        {
          selector: SELECTORS.approve,
          target: ArgsTarget.WORD,
          index: 1,
          op: ArgsOp.LTE,
          values: [uintWord(cap)],
        },
      ]),
]

/** Word `index` of `selector` must be the Safe (EQ_SAFE). */
export const receiverIsSafeConstraint = (selector: Hex, index: number): ArgsConstraint => ({
  selector,
  target: ArgsTarget.WORD,
  index,
  op: ArgsOp.EQ_SAFE,
  values: [],
})

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export type TokenInfo = { symbol: string; decimals: number }

export type LabelContext = {
  /** Token metadata for amounts; unknown tokens are shown in base units. */
  tokenOf?: (token: Address) => TokenInfo | undefined
  /** Address book (roles, Safes, owners, known contracts). */
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

/** `24h`, `72h`, `7d`, `30m`, `45s`, `0s`: hours up to 3 days, as the UI presets. */
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

export const listLabel = (addresses: readonly Address[], ctx: LabelContext): string =>
  addresses.length === 0 ? 'none' : addresses.map((a) => addressLabel(a, ctx)).join(', ')

const OP_LABELS: Record<ArgsOp, string> = {
  0: '=',
  1: '≠',
  2: 'in',
  3: 'not in',
  4: '≤',
  5: '≥',
  6: 'is the Safe',
}

const TARGET_LABELS: Record<ArgsTarget, string> = {
  0: 'argument',
  1: 'target',
  2: 'value',
  3: 'destination when value moves',
}

const wordLabel = (word: Hex, ctx: LabelContext): string => {
  const n = BigInt(word)
  // A word with 12 leading zero bytes and a non-trivial tail reads best as an address.
  return n >= 2n ** 64n && n < 2n ** 160n ? addressLabel(wordAddress(word), ctx) : n.toString()
}

/** `transfer argument 0 in [Vendor A, Vendor B]`, `any call: value ≤ 1000`. */
export function argsConstraintLabel(c: ArgsConstraint, ctx: LabelContext = {}): string {
  const fn = c.selector.toLowerCase() === ANY_SELECTOR ? 'any call' : (selectorName(c.selector) ?? c.selector)
  const what = c.target === ArgsTarget.WORD ? `argument ${c.index}` : TARGET_LABELS[c.target]
  const values =
    c.op === ArgsOp.EQ_SAFE
      ? ''
      : c.values.length === 1
        ? ` ${wordLabel(c.values[0]!, ctx)}`
        : ` [${c.values.map((v) => wordLabel(v, ctx)).join(', ')}]`
  return `${fn}: ${what} ${OP_LABELS[c.op]}${values}`
}

/** The preset an Args setting was built from, if any, as one short phrase (`to Vendor A, Vendor B`). */
export function argsPresetLabel(settings: ArgsSettings, ctx: LabelContext = {}): string | undefined {
  const { constraints } = settings
  const first = constraints[0]
  if (!first) return undefined
  const sameValues = (a: ArgsConstraint, b: ArgsConstraint) =>
    a.values.length === b.values.length &&
    a.values.every((v, i) => v.toLowerCase() === b.values[i]?.toLowerCase())
  const recipients = recipientsConstraints(first.values.map(wordAddress))
  const isRecipients =
    first.op === ArgsOp.IN &&
    constraints.length === recipients.length &&
    constraints.every(
      (c, i) =>
        c.selector.toLowerCase() === recipients[i]!.selector &&
        c.target === recipients[i]!.target &&
        c.index === recipients[i]!.index &&
        c.op === ArgsOp.IN &&
        sameValues(c, first),
    )
  if (isRecipients) return `to ${listLabel(first.values.map(wordAddress), ctx)}`
  if (
    first.selector.toLowerCase() === SELECTORS.approve &&
    first.index === 0 &&
    first.op === ArgsOp.IN &&
    constraints.length <= 2
  ) {
    const cap = constraints[1]
    return `spender ${listLabel(first.values.map(wordAddress), ctx)}${cap ? `, ≤ ${BigInt(cap.values[0] ?? '0x0')} units` : ''}`
  }
  if (constraints.length === 1 && first.op === ArgsOp.EQ_SAFE)
    return `${selectorName(first.selector) ?? first.selector} argument ${first.index} is the Safe`
  return undefined
}

/** The conditions of an Args attachment, short (`to Vendor A`) or each rule. */
export function argsLabel(settings: ArgsSettings, ctx: LabelContext = {}): string {
  const preset = argsPresetLabel(settings, ctx)
  const body =
    preset ?? (settings.constraints.map((c) => argsConstraintLabel(c, ctx)).join('; ') || 'nothing')
  return `${body}${settings.strict ? ' (other calls denied)' : ''}`
}

/** `Timelock 24h, guardians G1, G2`, `Kill switch (guardian G)`, `Budget 5,000 USDC / month`. */
export function settingsLabel(value: PolicySettings, ctx: LabelContext = {}): string {
  switch (value.policy) {
    case 'timelock': {
      const { delay, window, guardians, lifters, cancellers } = value.settings
      const parts = [delay === 0 ? 'Kill switch' : `Timelock ${durationLabel(delay)}`]
      if (window) parts.push(`expires ${durationLabel(window)} after ready`)
      if (guardians.length) parts.push(`guardians ${listLabel(guardians, ctx)}`)
      if (lifters.length) parts.push(`lifters ${listLabel(lifters, ctx)}`)
      if (cancellers.length) parts.push(`cancellers ${listLabel(cancellers, ctx)}`)
      return parts.join(', ')
    }
    case 'args':
      return `Conditions: ${argsLabel(value.settings, ctx)}`
    case 'limit': {
      const { limits, passUnpriced } = value.settings
      const budgets = limits.map((l) => `${amountLabel(l.token, l.amount, ctx)} ${periodLabel(l.period)}`)
      return `Budget ${budgets.join(', ') || '(no token)'}${passUnpriced ? ' (other calls pass)' : ''}`
    }
    case 'coSigner': {
      const { approvers, required } = value.settings
      return `Co-signer ${required} of ${listLabel(approvers, ctx)}`
    }
    case 'safenet':
      return 'Safenet attestation'
  }
}
