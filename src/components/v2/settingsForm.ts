import {
  type Address,
  type Hex,
  isAddress,
  maxUint256,
  numberToHex,
  pad,
  parseUnits,
  zeroAddress,
} from 'viem'
import { TOKENS } from '../../config/contracts'
import { ArgOp, DAY, MONTH, type PolicyName, type PolicySettings, validateSettings } from '../../lib/v2'
import { parseAddressList, parseSelectorInput } from '../../lib/validation'

/**
 * Raw form fields of the scope builder's policy settings, and their conversion into
 * `PolicySettings` (pure). One flat record keeps every policy's inputs while the user switches
 * between policies.
 */
export type RawSettings = {
  safeWide: boolean
  actorFreeze: boolean
  delay: string
  window: string
  clearOnFreeze: boolean
  cancellers: string
  recipients: string
  spenders: string
  maxApproval: string
  strict: boolean
  token: string
  amount: string
  period: string
  passUnpriced: boolean
  argSelector: string
  argIndex: string
  argOp: string
  argValues: string
  cosigner: string
  required: string
  tierToken: string
  tierAbove: string
  tierRequired: string
}

export const NATIVE = 'native'

export const initialRaw: RawSettings = {
  safeWide: true,
  actorFreeze: true,
  delay: String(DAY),
  window: '0',
  clearOnFreeze: true,
  cancellers: '',
  recipients: '',
  spenders: '',
  maxApproval: '',
  strict: false,
  token: TOKENS.USDC.address,
  amount: '5000',
  period: String(MONTH),
  passUnpriced: false,
  argSelector: '',
  argIndex: '0',
  argOp: String(ArgOp.EQ_SAFE),
  argValues: '',
  cosigner: '',
  required: '2',
  tierToken: TOKENS.USDC.address,
  tierAbove: '10000',
  tierRequired: '3',
}

const decimalsOf = (token: string): number =>
  token === NATIVE
    ? 18
    : (Object.values(TOKENS).find((t) => t.address.toLowerCase() === token.toLowerCase())?.decimals ?? 0)

const tokenAddress = (token: string): Address => (token === NATIVE ? zeroAddress : (token as Address))

const optionalList = (input: string): Address[] | string => {
  if (!input.trim()) return []
  const parsed = parseAddressList(input)
  return parsed.ok ? parsed.value : parsed.error
}

const integer = (input: string, what: string): number | string => {
  const n = Number(input.trim())
  return Number.isInteger(n) && n >= 0 ? n : `${what} must be a whole number`
}

const amount = (input: string, token: string, what: string): bigint | string => {
  try {
    return parseUnits(input.trim() || '0', decimalsOf(token))
  } catch {
    return `${what} is not a number`
  }
}

/** A 32-byte word from a decimal number or an address. */
const word = (input: string): Hex | undefined => {
  const value = input.trim()
  if (isAddress(value, { strict: false })) return pad(value.toLowerCase() as Hex, { size: 32 })
  if (/^\d+$/.test(value)) return numberToHex(BigInt(value), { size: 32 })
  return undefined
}

/** `{ value }` when the fields make valid settings, else the first problem. */
export function buildSettings(
  policy: PolicyName,
  raw: RawSettings,
): { value?: PolicySettings; error?: string } {
  const fail = (error: string) => ({ error })
  let value: PolicySettings
  switch (policy) {
    case 'freeze':
      value = { policy, settings: { safeWide: raw.safeWide, actor: raw.actorFreeze } }
      break
    case 'timelock': {
      const delay = integer(raw.delay, 'Delay')
      const window = integer(raw.window, 'Window')
      const cancellers = optionalList(raw.cancellers)
      if (typeof delay === 'string') return fail(delay)
      if (typeof window === 'string') return fail(window)
      if (typeof cancellers === 'string') return fail(`Cancellers: ${cancellers}`)
      value = { policy, settings: { delay, window, clearOnFreeze: raw.clearOnFreeze, cancellers } }
      break
    }
    case 'recipients': {
      const recipients = optionalList(raw.recipients)
      const spenders = optionalList(raw.spenders)
      if (typeof recipients === 'string') return fail(`Recipients: ${recipients}`)
      if (typeof spenders === 'string') return fail(`Spenders: ${spenders}`)
      let maxApproval = maxUint256
      if (raw.maxApproval.trim()) {
        if (!/^\d+$/.test(raw.maxApproval.trim())) return fail('Max approval is a whole number of base units')
        maxApproval = BigInt(raw.maxApproval.trim())
      }
      value = { policy, settings: { recipients, spenders, maxApproval, strict: raw.strict } }
      break
    }
    case 'limit': {
      const parsed = amount(raw.amount, raw.token, 'Amount')
      if (typeof parsed === 'string') return fail(parsed)
      const period = integer(raw.period, 'Period')
      if (typeof period === 'string') return fail(period)
      value = {
        policy,
        settings: {
          limits: [{ token: tokenAddress(raw.token), amount: parsed, period: BigInt(period) }],
          passUnpriced: raw.passUnpriced,
        },
      }
      break
    }
    case 'args': {
      const selector = parseSelectorInput(raw.argSelector)
      if (!selector.ok) return fail(selector.error)
      const argIndex = integer(raw.argIndex, 'Argument index')
      if (typeof argIndex === 'string') return fail(argIndex)
      const op = Number(raw.argOp) as ArgOp
      const values: Hex[] = []
      for (const part of raw.argValues.split(/[\s,]+/).filter(Boolean)) {
        const w = word(part)
        if (!w) return fail(`"${part}" is neither a number nor an address`)
        values.push(w)
      }
      value = {
        policy,
        settings: { constraints: [{ selector: selector.value, argIndex, op, values }], strict: raw.strict },
      }
      break
    }
    case 'coSigner':
      if (!isAddress(raw.cosigner.trim(), { strict: false })) return fail('Enter the co-signer address')
      value = { policy, settings: { cosigner: raw.cosigner.trim() as Address } }
      break
    case 'safenet':
      value = { policy, settings: null }
      break
    case 'quorum': {
      const required = integer(raw.required, 'Required signatures')
      if (typeof required === 'string') return fail(required)
      const tiers = []
      if (raw.tierAbove.trim()) {
        const above = amount(raw.tierAbove, raw.tierToken, 'Tier amount')
        const tierRequired = integer(raw.tierRequired, 'Tier signatures')
        if (typeof above === 'string') return fail(above)
        if (typeof tierRequired === 'string') return fail(tierRequired)
        tiers.push({ token: tokenAddress(raw.tierToken), above, required: tierRequired })
      }
      value = { policy, settings: { required, tiers } }
      break
    }
  }
  const problems = validateSettings(value)
  return problems.length ? { value, error: problems[0] } : { value }
}
