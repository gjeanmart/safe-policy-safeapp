import { type Address, type Hex, formatUnits, getAddress, isAddressEqual, toFunctionSelector } from 'viem'
import { ANY, CallMatch, type DecodedError, OWNERS, type Scope } from './client'

/** Plain-language labels for rev 3 scopes, settings, times and errors. */

/** Names an address: address book, Safe, role, tokens, the engine and its policies. */
export type Names = (address: Address) => string

export const isoTime = (seconds: bigint | number): string =>
  new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z')

/** `3m 05s`, `4h 12m`, `2d 3h`. */
export function countdown(seconds: bigint | number): string {
  let s = Math.max(0, Math.round(Number(seconds)))
  const d = Math.floor(s / 86_400)
  s -= d * 86_400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** A configured duration: `90s`, `15m`, `24h`, `7d`, `1d 12h`. */
export function duration(seconds: bigint | number): string {
  const s = Number(seconds)
  if (s === 0) return '0s'
  if (s % 86_400 === 0) return `${s / 86_400}d`
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  if (s > 86_400) return countdown(s)
  return `${s}s`
}

const FUNCTIONS = [
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'increaseAllowance(address,uint256)',
  'decreaseAllowance(address,uint256)',
  'deposit()',
  'withdraw(uint256)',
  'setPreSignature(bytes,bool)',
  'multiSend(bytes)',
  'configure((bool,(address,address,bytes4,uint8),uint8,address,uint8,bytes)[])',
  'enableModule(address)',
  'disableModule(address,address)',
  'setGuard(address)',
  'setModuleGuard(address)',
  'setFallbackHandler(address)',
  'addOwnerWithThreshold(address,uint256)',
  'removeOwner(address,address,uint256)',
  'swapOwner(address,address,address)',
  'changeThreshold(uint256)',
]
const SELECTORS = new Map(FUNCTIONS.map((f) => [toFunctionSelector(f), f.slice(0, f.indexOf('('))]))

/** Argument names of the head words, for Args conditions. */
const ARG_NAMES: Record<string, string[]> = {
  transfer: ['recipient', 'amount'],
  transferFrom: ['from', 'recipient', 'amount'],
  approve: ['spender', 'amount'],
  increaseAllowance: ['spender', 'amount'],
  decreaseAllowance: ['spender', 'amount'],
  withdraw: ['amount'],
}

export const selectorName = (selector: Hex): string =>
  SELECTORS.get(selector.toLowerCase() as Hex) ?? selector

export function actorLabel(actor: Address, role: Address, names: Names): string {
  if (isAddressEqual(actor, ANY)) return 'Everyone'
  if (isAddressEqual(actor, OWNERS)) return 'Owners'
  if (isAddressEqual(actor, role)) return 'This role'
  return names(actor)
}

/** `(This role, USDC.transfer)`, `(Everyone, *)`, `(Owners, Safe.*)`. */
export function scopeLabel(scope: Scope, role: Address, names: Names): string {
  const call =
    scope.callMatch === CallMatch.ANY
      ? '*'
      : scope.callMatch === CallMatch.CONTRACT
        ? `${names(scope.to)}.*`
        : `${names(scope.to)}.${BigInt(scope.selector) === 0n ? '(plain call)' : selectorName(scope.selector)}`
  return `(${actorLabel(scope.actor, role, names)}, ${call})`
}

export const opsLabel = (mask: number): string =>
  mask === 2 ? 'DELEGATECALL' : mask === 3 ? 'CALL + DELEGATECALL' : 'CALL'

export type TokenLabel = (token: Address) => { symbol: string; decimals: number } | undefined

export function amountLabel(token: Address, amount: bigint, tokenOf: TokenLabel): string {
  if (BigInt(token) === 0n) return `${formatUnits(amount, 18)} ETH`
  const t = tokenOf(token)
  return t ? `${formatUnits(amount, t.decimals)} ${t.symbol}` : `${amount} units of ${token}`
}

// ---------------------------------------------------------------------------------------------
// Args conditions
// ---------------------------------------------------------------------------------------------

const ARGS_OPS = ['==', '!=', 'in', 'not in', '<=', '>=', '== the Safe']

/** A word as an address when it looks like one, else as a number. */
function wordLabel(word: Hex, names: Names): string {
  const n = BigInt(word)
  if (n !== 0n && n < 1n << 160n && n > 1n << 100n)
    return names(getAddress(`0x${n.toString(16).padStart(40, '0')}`))
  return n.toString()
}

export function constraintLabel(
  c: { selector: Hex; target: number; index: number; op: number; values: readonly Hex[] },
  names: Names,
): string {
  const fn = c.selector.toLowerCase() === '0xffffffff' ? 'any call' : selectorName(c.selector)
  const subject =
    c.target === 1
      ? 'target'
      : c.target === 2
        ? 'ETH value'
        : (ARG_NAMES[fn]?.[c.index] ?? `argument ${c.index}`)
  const values = c.values.map((v) => wordLabel(v, names))
  const operand =
    c.op === 6 ? '' : c.op === 2 || c.op === 3 ? ` [${values.join(', ')}]` : ` ${values[0] ?? ''}`
  return `${fn}: ${subject} ${ARGS_OPS[c.op] ?? `op ${c.op}`}${operand}`
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type ErrorContext = {
  names: Names
  tokenOf: TokenLabel
  /** Labels an attachment id with its scope and policy, when known. */
  attachment: (id: Hex) => string
}

/** One sentence for a decoded rev 3 error. */
export function errorText(e: DecodedError, ctx: ErrorContext): string {
  const a = e.args
  const call = (i: unknown) => `call ${i}`
  switch (e.name) {
    case 'NotGranted':
      return `no Allow for this role covers ${names(ctx, a[1])}.${selectorName(a[2] as Hex)} (${call(a[0])}): denied by default`
    case 'Denied':
      return `a Deny matches ${call(a[0])}: ${ctx.attachment(a[1] as Hex)}`
    case 'GuardTargetDenied':
      return `${call(a[0])} targets the engine: only the owners configure it`
    case 'InvalidSelector':
      return `${call(a[0])} has 1 to 3 bytes of calldata`
    case 'MalformedBatch':
      return 'the batch does not decode, is empty or carries value'
    case 'BatchTooLarge':
      return 'the batch has more than 8 calls'
    case 'NestedBatch':
      return `${call(a[0])} nests a batch`
    case 'Reentrancy':
      return 'the engine was re-entered during a check'
    case 'ModuleExecutionFailed':
      return 'every gate passed, but the call itself reverted'
    // Timelock
    case 'AttachmentFrozen':
      return `frozen until ${isoTime(a[1] as bigint)} (${ctx.attachment(a[0] as Hex)})`
    case 'NotScheduled':
      return 'needs to be scheduled first'
    case 'NotReady':
      return `scheduled; executable from ${isoTime(a[1] as bigint)}`
    case 'ScheduleExpired':
      return `the schedule expired at ${isoTime(a[1] as bigint)}`
    case 'VoidedByFreeze':
      return `the schedule was voided by a freeze of ${ctx.attachment(a[1] as Hex)}`
    case 'AlreadyScheduled':
      return 'already scheduled'
    case 'CancelledTransaction':
      return 'the owners cancelled this signed transaction for good: it can never be scheduled again (sign a new one at another nonce)'
    case 'NoTimelock':
      return 'no Timelock applies to this call'
    case 'NotCanceller':
      return `${names(ctx, a[0])} is not a canceller of this schedule`
    case 'NotGuardian':
      return `not a guardian of ${ctx.attachment(a[0] as Hex)}`
    case 'NotGuardianOrLifter':
      return `not a guardian or lifter of ${ctx.attachment(a[0] as Hex)}`
    case 'NotFrozen':
      return `${ctx.attachment(a[0] as Hex)} is not frozen`
    case 'NotOwnersQueue':
      return 'not an owner-path schedule'
    // Limit
    case 'LimitExceeded': {
      const token = a[2] as Address
      return (
        `over budget on ${call(a[0])}: ${amountLabel(token, a[3] as bigint, ctx.tokenOf)} requested, ` +
        `${amountLabel(token, a[4] as bigint, ctx.tokenOf)} left (${ctx.attachment(a[1] as Hex)})`
      )
    }
    case 'Unpriced': {
      const token = a[2] as Address
      return BigInt(token) === 0n && BigInt(a[3] as Hex) !== 0n
        ? `the budget cannot price ${call(a[0])} (${selectorName(a[3] as Hex)}): not a known spend (${ctx.attachment(a[1] as Hex)})`
        : `no budget for ${BigInt(token) === 0n ? 'ETH' : names(ctx, token)} on ${call(a[0])} (${ctx.attachment(a[1] as Hex)})`
    }
    // Args
    case 'ConstraintFailed':
      return `${call(a[0])} breaks condition ${a[2]} of ${ctx.attachment(a[1] as Hex)}`
    case 'ArgumentMissing':
      return `${call(a[0])} is too short for condition ${a[2]} of ${ctx.attachment(a[1] as Hex)}`
    case 'NoConstraint':
      return `no condition of ${ctx.attachment(a[1] as Hex)} covers ${call(a[0])} (strict)`
    // Co-signer
    case 'MissingApprovals':
      return `needs ${a[1]} approval(s), has ${a[2]} (${ctx.attachment(a[0] as Hex)})`
    case 'ApprovalExpired':
      return `validUntil ${isoTime(a[0] as bigint)} is in the past`
    // Safenet
    case 'MissingAttestation':
      return 'needs a Safenet attestation'
    case 'AttestationExpired':
      return `the Safenet attestation expired at ${isoTime(a[0] as bigint)}`
    case 'Error':
      return String(a[0])
    default:
      return a.length ? `${e.name}(${a.map(String).join(', ')})` : e.name
  }
}

const names = (ctx: ErrorContext, a: unknown) => ctx.names(a as Address)
