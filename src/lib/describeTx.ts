import {
  type Address,
  type Hex,
  decodeFunctionData,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  maxUint256,
  parseAbi,
  size,
  slice,
} from 'viem'
import { erc20Abi, safeAbi } from '../abi'
import { TOKENS } from '../config/contracts'
import { formatAmount, shortAddress } from './format'
import {
  type Change,
  type LabelContext,
  type V2Deployment,
  changeAttachmentId,
  describeChange,
  policyGuardAbi,
  selectorName,
} from './v2'

/** A human title for a transaction and, when it has parts, one line per part. */
export type TxSummary = { title: string; lines: string[] }

export type Call = { to: Address; value?: bigint; data: Hex }

export type DescribeContext = LabelContext & {
  deployment?: V2Deployment
  /** The attachment already exists, so an attach re-configures it. */
  isAttached?: (attachmentId: Hex) => boolean
}

const extraAbi = parseAbi([
  'function setFallbackHandler(address handler)',
  'function multiSend(bytes transactions)',
])

const tokens = Object.values(TOKENS)

const nameOf = (address: Address, ctx: DescribeContext) =>
  ctx.nameOf?.(getAddress(address)) ?? shortAddress(address)

const tokenOf = (address: Address, ctx: DescribeContext) =>
  ctx.tokenOf?.(address) ?? tokens.find((t) => isAddressEqual(t.address, address))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** MultiSend packs `operation (1) | to (20) | value (32) | length (32) | data` per call. */
function unpackMultiSend(packed: Hex): Call[] {
  const calls: Call[] = []
  let at = 0
  const total = size(packed)
  while (at < total) {
    const to = getAddress(slice(packed, at + 1, at + 21))
    const value = hexToBigInt(slice(packed, at + 21, at + 53))
    const length = hexToNumber(slice(packed, at + 53, at + 85))
    const data = length === 0 ? '0x' : slice(packed, at + 85, at + 85 + length)
    calls.push({ to, value, data })
    at += 85 + length
  }
  return calls
}

function describeConfigure(changes: readonly Change[], ctx: DescribeContext): TxSummary {
  const { deployment } = ctx
  return {
    title: `Configure: ${plural(changes.length, 'change')}`,
    lines: deployment
      ? changes.map((c) =>
          describeChange(c, deployment, ctx, ctx.isAttached?.(changeAttachmentId(c)) ?? false),
        )
      : [],
  }
}

/**
 * Decodes the calls this app makes into plain words: `Configure: 3 changes` with each change,
 * `Transfer 1 USDC to Signer 1`, `Enable module Agent`, a Safe{Wallet} batch call by call. Falls
 * back to the function name and target.
 */
export function describeCall(call: Call, ctx: DescribeContext = {}): TxSummary {
  const value = call.value ?? 0n
  const none = { lines: [] as string[] }
  if (size(call.data) === 0)
    return { title: `Send ${formatAmount(value, 18)} ETH to ${nameOf(call.to, ctx)}`, ...none }

  try {
    const { functionName, args } = decodeFunctionData({ abi: policyGuardAbi, data: call.data })
    if (functionName === 'configure') return describeConfigure(args[0] as readonly Change[], ctx)
  } catch {
    // Not an engine call.
  }

  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
    const token = tokenOf(call.to, ctx)
    const amount = (n: bigint) =>
      n === maxUint256 ? 'unlimited' : token ? `${formatAmount(n, token.decimals)} ${token.symbol}` : `${n}`
    if (decoded.functionName === 'transfer') {
      const [to, n] = decoded.args
      return { title: `Transfer ${amount(n)} to ${nameOf(to, ctx)}`, ...none }
    }
    if (decoded.functionName === 'approve') {
      const [spender, n] = decoded.args
      return { title: `Approve ${nameOf(spender, ctx)} to spend ${amount(n)}`, ...none }
    }
  } catch {
    // Not an ERC-20 call.
  }

  try {
    const decoded = decodeFunctionData({ abi: [...safeAbi, ...extraAbi], data: call.data })
    switch (decoded.functionName) {
      case 'enableModule':
        return { title: `Enable module ${nameOf(decoded.args[0], ctx)}`, ...none }
      case 'disableModule':
        return { title: `Disable module ${nameOf(decoded.args[1], ctx)}`, ...none }
      case 'addOwnerWithThreshold':
        return {
          title: `Add signer ${nameOf(decoded.args[0], ctx)} (threshold ${decoded.args[1]})`,
          ...none,
        }
      case 'setGuard':
        return { title: `Set guard ${nameOf(decoded.args[0], ctx)}`, ...none }
      case 'setModuleGuard':
        return { title: `Set module guard ${nameOf(decoded.args[0], ctx)}`, ...none }
      case 'setFallbackHandler':
        return { title: `Set fallback handler ${nameOf(decoded.args[0], ctx)}`, ...none }
      case 'multiSend': {
        const calls = unpackMultiSend(decoded.args[0])
        return {
          title: `Batch: ${plural(calls.length, 'call')}`,
          lines: calls.flatMap((c) => {
            const part = describeCall(c, ctx)
            return [part.title, ...part.lines.map((l) => `  ${l}`)]
          }),
        }
      }
    }
  } catch {
    // Not a Safe call.
  }

  const selector = call.data.slice(0, 10) as Hex
  const fn = selectorName(selector) ?? selector
  const eth = value > 0n ? ` with ${formatAmount(value, 18)} ETH` : ''
  return { title: `${fn} on ${nameOf(call.to, ctx)}${eth}`, ...none }
}

/** Several calls proposed together (Safe{Wallet} batches them). */
export function describeCalls(calls: readonly Call[], ctx: DescribeContext = {}): TxSummary {
  if (calls.length === 1) return describeCall(calls[0]!, ctx)
  return {
    title: `Batch: ${plural(calls.length, 'call')}`,
    lines: calls.flatMap((c) => {
      const part = describeCall(c, ctx)
      return [part.title, ...part.lines.map((l) => `  ${l}`)]
    }),
  }
}
