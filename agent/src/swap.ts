import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  isAddressEqual,
  parseUnits,
  zeroAddress,
} from 'viem'
import { cowSettlementAbi, erc20Abi } from '../../src/abi'
import { publicClient } from '../../src/config/client'
import { COW } from '../../src/config/contracts'
import { Operation } from '../../src/lib/configurations'
import {
  type CowOrder,
  type CowQuote,
  buildOrder,
  getQuote,
  orderUid,
  orderUrl,
  postPresignOrder,
} from '../../src/lib/cow'
import type { ModuleTx } from '../../src/lib/moduleTx'
import { type Config, label, nameAddress, resolveToken, tokenByAddress } from './config'
import { CliError } from './output'
import type { Intent, Plan, PlanArgs } from './plans'

/**
 * CoW swaps from the Safe: approve the VaultRelayer, then `setPreSignature(uid, true)`. On-chain,
 * AllowedModulePolicy only checks who pre-signs: the order behind the UID (receiver, price) is
 * invisible to the policies. So the plan carries the full order, and the signer decodes it for the
 * user's approval (after checking the UID really is that order's).
 */

/** How long a planned order stays valid. */
const ORDER_VALIDITY_SECONDS = 20 * 60
const DEFAULT_SLIPPAGE_BPS = 50

/** `CowOrder` with bigints as strings, as stored in a plan file. */
export type StoredOrder = Omit<CowOrder, 'sellAmount' | 'buyAmount' | 'feeAmount'> & {
  sellAmount: string
  buyAmount: string
  feeAmount: string
}

export type CowAttachment = { order: StoredOrder; appData: string; appDataHash: Hex }

const toOrder = (o: StoredOrder): CowOrder => ({
  ...o,
  sellAmount: BigInt(o.sellAmount),
  buyAmount: BigInt(o.buyAmount),
  feeAmount: BigInt(o.feeAmount),
})

const storeOrder = (o: CowOrder): StoredOrder => ({
  ...o,
  sellAmount: o.sellAmount.toString(),
  buyAmount: o.buyAmount.toString(),
  feeAmount: o.feeAmount.toString(),
})

const presignTx = (uid: Hex, signed = true): ModuleTx => ({
  to: COW.settlement,
  value: 0n,
  data: encodeFunctionData({ abi: cowSettlementAbi, functionName: 'setPreSignature', args: [uid, signed] }),
  operation: Operation.CALL,
})

/** Decodes a `setPreSignature` call, or undefined for any other transaction. */
function decodePresign(tx: ModuleTx): { uid: Hex; signed: boolean } | undefined {
  if (!isAddressEqual(tx.to, COW.settlement)) return undefined
  try {
    const { functionName, args } = decodeFunctionData({ abi: cowSettlementAbi, data: tx.data })
    if (functionName !== 'setPreSignature') return undefined
    const [uid, signed] = args
    return { uid, signed }
  } catch {
    return undefined
  }
}

const tokenName = (address: Address) => tokenByAddress(address)?.symbol ?? address

/** Describes a pre-sign from the order it carries; the UID alone says nothing about the order. */
export function describePresign(config: Config, tx: ModuleTx, cow?: CowAttachment): Intent | undefined {
  const presign = decodePresign(tx)
  if (!presign) return undefined
  if (!presign.signed) {
    return { kind: 'presign', text: `cancel CoW order ${presign.uid.slice(0, 18)}…`, warnings: [] }
  }
  if (!cow) {
    return {
      kind: 'presign',
      text: `pre-sign CoW order ${presign.uid.slice(0, 18)}… (order details unknown)`,
      warnings: ['Pre-signs an order whose receiver and price cannot be checked'],
    }
  }
  const order = toOrder(cow.order)
  const sell = tokenByAddress(order.sellToken)
  const buy = tokenByAddress(order.buyToken)
  const receiver = nameAddress(config, order.receiver === zeroAddress ? config.safe : order.receiver)
  const warnings: string[] = []
  if (orderUid(order, config.safe).toLowerCase() !== presign.uid.toLowerCase()) {
    warnings.push('ORDER UID MISMATCH: the attached order is not the one being pre-signed')
  }
  if (receiver.source !== 'safe') warnings.push(`RECEIVER IS NOT THE SAFE: ${label(receiver)}`)
  const until = new Date(order.validTo * 1000).toISOString().slice(11, 16)
  return {
    kind: 'swap',
    text:
      `swap ${sell ? formatUnits(order.sellAmount, sell.decimals) : order.sellAmount} ${tokenName(order.sellToken)} ` +
      `for at least ${buy ? formatUnits(order.buyAmount, buy.decimals) : order.buyAmount} ${tokenName(order.buyToken)} ` +
      `on CoW, paid to ${label(receiver)}, valid until ${until} UTC`,
    ...(sell ? { symbol: sell.symbol, amount: order.sellAmount, decimals: sell.decimals } : {}),
    counterparty: receiver,
    warnings,
  }
}

export type SwapPlan = { tx: ModuleTx; cow?: CowAttachment; label: string }

/**
 * Quotes a sell order paid to the Safe and returns the transactions to plan: an exact approval
 * of the VaultRelayer when the allowance is short, then the pre-signature.
 */
export async function buildSwap(config: Config, args: PlanArgs): Promise<SwapPlan[]> {
  const sell = resolveToken(args.sell ?? '')
  const buy = resolveToken(args.buy ?? '')
  if (!sell.address || !buy.address) {
    throw new CliError('CoW swaps are between ERC-20s.', 'Use WETH instead of ETH (plan wrap first).')
  }
  if (isAddressEqual(sell.address, buy.address)) throw new CliError('Sell and buy tokens must differ.')
  let sellAmount: bigint
  try {
    sellAmount = parseUnits(args.amount ?? '', sell.decimals)
  } catch {
    throw new CliError(`Invalid amount "${args.amount}".`, 'Use a decimal amount of the sell token, e.g. 20.')
  }
  if (sellAmount <= 0n) throw new CliError('Missing --amount.', 'Pass the amount to sell, e.g. --amount 20')
  const slippageBps = args.slippage ? Number(args.slippage) : DEFAULT_SLIPPAGE_BPS
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new CliError('Slippage must be an integer number of basis points between 0 and 5000.')
  }

  let quote: CowQuote
  try {
    quote = await getQuote({
      from: config.safe,
      receiver: config.safe,
      sellToken: sell.address,
      buyToken: buy.address,
      sellAmount,
    })
  } catch (error) {
    throw new CliError(
      `No CoW quote: ${(error as Error).message}`,
      'Sepolia liquidity is thin: try a larger amount (around 20 USDC) or another pair.',
    )
  }
  const order: CowOrder = {
    ...buildOrder(quote, slippageBps),
    receiver: config.safe,
    validTo: Math.floor(Date.now() / 1000) + ORDER_VALIDITY_SECONDS,
  }
  const uid = orderUid(order, config.safe)

  const allowance = await publicClient.readContract({
    address: sell.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [config.safe, COW.vaultRelayer],
  })
  const steps: SwapPlan[] = []
  if (allowance < order.sellAmount) {
    steps.push({
      label: 'approve',
      tx: {
        to: sell.address,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [COW.vaultRelayer, order.sellAmount],
        }),
        operation: Operation.CALL,
      },
    })
  }
  steps.push({
    label: 'presign',
    tx: presignTx(uid),
    cow: { order: storeOrder(order), appData: quote.appData, appDataHash: quote.appDataHash },
  })
  return steps
}

/**
 * Integrity, not policy: when a pre-sign carries its order, the UID must be that order's, so what
 * the user is shown (receiver, amounts, expiry) is what gets signed. Returns a reason to refuse.
 */
export function verifyPresign(config: Config, plan: Plan, tx: ModuleTx): string | undefined {
  const presign = decodePresign(tx)
  if (!presign || !presign.signed || !plan.cow) return undefined
  if (orderUid(toOrder(plan.cow.order), config.safe).toLowerCase() !== presign.uid.toLowerCase()) {
    return 'the attached CoW order does not match the pre-signed UID'
  }
  return undefined
}

/** Posts the order to the CoW order book (inert until pre-signed) and checks the UID it returns. */
export async function postOrder(config: Config, cow: CowAttachment): Promise<Hex> {
  const order = toOrder(cow.order)
  const expected = orderUid(order, config.safe)
  let uid: Hex
  try {
    uid = await postPresignOrder(
      order,
      { appData: cow.appData, appDataHash: cow.appDataHash } as CowQuote,
      config.safe,
    )
  } catch (error) {
    const message = (error as Error).message
    // Re-posting after a failed or declined exec is fine: the order book already has it.
    if (/DuplicatedOrder|DuplicateOrder/i.test(message)) return expected
    throw new CliError(
      `CoW rejected the order: ${message}`,
      'Plan the swap again (the quote may have moved).',
    )
  }
  if (uid.toLowerCase() !== expected.toLowerCase()) {
    throw new CliError(`CoW returned order ${uid}, expected ${expected}. Not signing.`)
  }
  return uid
}

export { orderUrl }
