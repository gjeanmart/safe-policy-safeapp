import { type Address, type Hex, isAddress, numberToHex, pad, parseUnits, zeroAddress } from 'viem'
import { TOKENS } from '../../config/contracts'
import {
  ANY_SELECTOR,
  type ArgsConstraint,
  ArgsOp,
  type ArgsPreset,
  type ArgsSettings,
  ArgsTarget,
  DAY,
  MONTH,
  type PolicyName,
  type PolicySettings,
  type SettingsContext,
  receiverIsSafeConstraint,
  recipientsConstraints,
  spendersConstraints,
  validateSettings,
} from '../../lib/v2'
import { parseAddressList, parseSelectorInput } from '../../lib/validation'

/**
 * Raw form fields of the scope builder's settings and the Allow row's conditions, and their
 * conversion into `PolicySettings` (pure). One flat record keeps every policy's inputs while the
 * user switches between policies.
 */
export type RawSettings = {
  delay: string
  window: string
  guardians: string
  lifters: string
  cancellers: string
  token: string
  amount: string
  period: string
  passUnpriced: boolean
  approvers: string
  required: string
  argSelector: string
  argTarget: string
  argIndex: string
  argOp: string
  argValues: string
  strict: boolean
  /** The Allow row's conditions (ArgsPolicy at the same scope). */
  conditions: 'none' | ArgsPreset
  condAddresses: string
  condCap: string
  condIndex: string
}

export const NATIVE = 'native'

export const initialRaw: RawSettings = {
  delay: String(DAY),
  window: '0',
  guardians: '',
  lifters: '',
  cancellers: '',
  token: TOKENS.USDC.address,
  amount: '5000',
  period: String(MONTH),
  passUnpriced: false,
  approvers: '',
  required: '1',
  argSelector: '',
  argTarget: String(ArgsTarget.WORD),
  argIndex: '0',
  argOp: String(ArgsOp.EQ_SAFE),
  argValues: '',
  strict: false,
  conditions: 'none',
  condAddresses: '',
  condCap: '',
  condIndex: '0',
}

export const decimalsOf = (token: string): number =>
  token === NATIVE
    ? 18
    : (Object.values(TOKENS).find((t) => t.address.toLowerCase() === token.toLowerCase())?.decimals ?? 0)

const tokenAddress = (token: string): Address => (token === NATIVE ? zeroAddress : (token as Address))

const list = (input: string): Address[] | string => {
  if (!input.trim()) return []
  const parsed = parseAddressList(input)
  return parsed.ok ? parsed.value : parsed.error
}

const integer = (input: string, what: string): number | string => {
  const n = Number(input.trim())
  return Number.isInteger(n) && n >= 0 ? n : `${what} must be a whole number`
}

/** A 32-byte word from a decimal number or an address. */
const word = (input: string): Hex | undefined => {
  const value = input.trim()
  if (isAddress(value, { strict: false })) return pad(value.toLowerCase() as Hex, { size: 32 })
  if (/^\d+$/.test(value)) return numberToHex(BigInt(value), { size: 32 })
  return undefined
}

type Built<T> = { value?: T; error?: string }

/** `{ value }` when the fields make valid settings, else the first problem. */
export function buildSettings(
  policy: PolicyName,
  raw: RawSettings,
  context: SettingsContext,
): Built<PolicySettings> {
  const fail = (error: string) => ({ error })
  let value: PolicySettings
  switch (policy) {
    case 'timelock': {
      const delay = integer(raw.delay, 'Delay')
      const window = integer(raw.window, 'Window')
      const guardians = list(raw.guardians)
      const lifters = list(raw.lifters)
      const cancellers = list(raw.cancellers)
      if (typeof delay === 'string') return fail(delay)
      if (typeof window === 'string') return fail(window)
      if (typeof guardians === 'string') return fail(`Guardians: ${guardians}`)
      if (typeof lifters === 'string') return fail(`Lifters: ${lifters}`)
      if (typeof cancellers === 'string') return fail(`Cancellers: ${cancellers}`)
      value = { policy, settings: { delay, window, guardians, lifters, cancellers } }
      break
    }
    case 'limit': {
      let amount: bigint
      try {
        amount = parseUnits(raw.amount.trim() || '0', decimalsOf(raw.token))
      } catch {
        return fail('Amount is not a number')
      }
      const period = integer(raw.period, 'Period')
      if (typeof period === 'string') return fail(period)
      value = {
        policy,
        settings: {
          limits: [{ token: tokenAddress(raw.token), amount, period: BigInt(period) }],
          passUnpriced: raw.passUnpriced,
        },
      }
      break
    }
    case 'coSigner': {
      const approvers = list(raw.approvers)
      if (typeof approvers === 'string') return fail(`Approvers: ${approvers}`)
      const required = integer(raw.required, 'Required')
      if (typeof required === 'string') return fail(required)
      value = { policy, settings: { approvers, required } }
      break
    }
    case 'args': {
      const selector = raw.argSelector.trim() ? parseSelectorInput(raw.argSelector) : undefined
      if (selector && !selector.ok) return fail(selector.error)
      const index = integer(raw.argIndex, 'Argument index')
      if (typeof index === 'string') return fail(index)
      const values: Hex[] = []
      for (const part of raw.argValues.split(/[\s,]+/).filter(Boolean)) {
        const w = word(part)
        if (!w) return fail(`"${part}" is neither a number nor an address`)
        values.push(w)
      }
      const target = Number(raw.argTarget) as ArgsTarget
      const constraint: ArgsConstraint = {
        selector: selector?.ok ? selector.value : ANY_SELECTOR,
        target,
        index: target === ArgsTarget.WORD ? index : 0,
        op: Number(raw.argOp) as ArgsOp,
        values,
      }
      value = { policy, settings: { constraints: [constraint], strict: raw.strict } }
      break
    }
    case 'safenet':
      value = { policy, settings: null }
      break
  }
  const problems = validateSettings(value, context)
  return problems.length ? { value, error: problems[0] } : { value }
}

/**
 * The Allow row's optional conditions, as ArgsPolicy settings at the same scope (undefined: none).
 * `selector` is the scope's function (Receiver-is-the-Safe needs one).
 */
export function buildConditions(
  raw: RawSettings,
  selector: Hex | undefined,
): Built<ArgsSettings | undefined> {
  if (raw.conditions === 'none') return {}
  if (raw.conditions === 'receiverIsSafe') {
    if (!selector) return { error: 'Receiver-is-the-Safe needs one function in the scope' }
    const index = integer(raw.condIndex, 'Argument index')
    if (typeof index === 'string') return { error: index }
    return { value: { constraints: [receiverIsSafeConstraint(selector, index)], strict: false } }
  }
  const addresses = list(raw.condAddresses)
  if (typeof addresses === 'string') return { error: addresses }
  if (addresses.length === 0) return { error: 'Enter at least one address' }
  if (raw.conditions === 'recipients')
    return { value: { constraints: recipientsConstraints(addresses), strict: false } }
  let cap: bigint | undefined
  if (raw.condCap.trim()) {
    if (!/^\d+$/.test(raw.condCap.trim())) return { error: 'The cap is a whole number of base units' }
    cap = BigInt(raw.condCap.trim())
  }
  return { value: { constraints: spendersConstraints(addresses, cap), strict: false } }
}
