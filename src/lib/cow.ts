import { type Address, type Hex, concat, hashTypedData, numberToHex, zeroAddress } from 'viem'
import { chain } from '../config/client'
import { COW } from '../config/contracts'

/** Subset of the CoW order-book quote response that this app uses. */
export type CowQuote = {
  sellToken: Address
  buyToken: Address
  receiver: Address | null
  sellAmount: string
  buyAmount: string
  feeAmount: string
  validTo: number
  appData: string
  appDataHash: Hex
  kind: 'sell' | 'buy'
  partiallyFillable: boolean
  sellTokenBalance: 'erc20' | 'external' | 'internal'
  buyTokenBalance: 'erc20' | 'internal'
}

/** The order as signed (here: pre-signed) by the Safe, i.e. `GPv2Order.Data`. */
export type CowOrder = {
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  appData: Hex
  feeAmount: bigint
  kind: 'sell' | 'buy'
  partiallyFillable: boolean
  sellTokenBalance: string
  buyTokenBalance: string
}

const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const

const DOMAIN = {
  name: 'Gnosis Protocol',
  version: 'v2',
  chainId: chain.id,
  verifyingContract: COW.settlement,
} as const

async function cowFetch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${COW.api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = await response.json()
  if (!response.ok) {
    const { errorType, description } = json as { errorType?: string; description?: string }
    throw new Error(`CoW API ${errorType ?? response.status}: ${description ?? 'request failed'}`)
  }
  return json as T
}

/** Quotes a sell order placed by the Safe (`from`) and paid out to `receiver`. */
export async function getQuote(params: {
  from: Address
  receiver: Address
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
}): Promise<CowQuote> {
  const { quote } = await cowFetch<{ quote: CowQuote }>('/quote', {
    from: params.from,
    receiver: params.receiver,
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    kind: 'sell',
    sellAmountBeforeFee: params.sellAmount.toString(),
    signingScheme: 'presign',
    appData: '{}',
  })
  return quote
}

/**
 * Turns a quote into the order to pre-sign. Fees are folded into the limit price (`feeAmount`
 * must be 0), so the sell amount is the quoted amount plus fee, and the buy amount is reduced by
 * the slippage tolerance.
 */
export function buildOrder(quote: CowQuote, slippageBps: number): CowOrder {
  return {
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    receiver: quote.receiver ?? zeroAddress,
    sellAmount: BigInt(quote.sellAmount) + BigInt(quote.feeAmount),
    buyAmount: (BigInt(quote.buyAmount) * BigInt(10_000 - slippageBps)) / 10_000n,
    validTo: quote.validTo,
    appData: quote.appDataHash,
    feeAmount: 0n,
    kind: quote.kind,
    partiallyFillable: quote.partiallyFillable,
    sellTokenBalance: quote.sellTokenBalance,
    buyTokenBalance: quote.buyTokenBalance,
  }
}

/**
 * The order UID, computed locally: `abi.encodePacked(orderDigest, owner, validTo)`, as in
 * `GPv2Order.packOrderUidParams`. This is exactly what `setPreSignature` receives, so the module
 * transactions can be simulated before the order is posted.
 */
export function orderUid(order: CowOrder, owner: Address): Hex {
  const digest = hashTypedData({ domain: DOMAIN, types: ORDER_TYPES, primaryType: 'Order', message: order })
  return concat([digest, owner, numberToHex(order.validTo, { size: 4 })])
}

/**
 * Posts a pre-sign order and returns its UID. Nothing is signed off-chain: the order is inert
 * until the Safe calls `GPv2Settlement.setPreSignature(uid, true)`.
 */
export function postPresignOrder(order: CowOrder, quote: CowQuote, owner: Address): Promise<Hex> {
  return cowFetch<Hex>('/orders', {
    ...order,
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    feeAmount: '0',
    appData: quote.appData,
    appDataHash: quote.appDataHash,
    signingScheme: 'presign',
    signature: '0x',
    from: owner,
  })
}

export const orderUrl = (uid: Hex): string => `${COW.explorer}/${uid}`
