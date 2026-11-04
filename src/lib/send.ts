import {
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
  keccak256,
} from 'viem'
import { sendRawTransaction } from 'viem/actions'
import { chain, publicClient } from '../config/client'
import { type RpcStep, RpcStepError, describeError, isLimitError } from './errors'

const RETRIES = 4
const BACKOFF_MS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retries `fn` with exponential backoff (1 s, 2 s, 4 s) while the RPC answers with a rate or size
 * limit. viem's own retries are ~1 s in total, too short for a public RPC's rate window.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= RETRIES || !isLimitError(error)) throw error
      await sleep(BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 300)
    }
  }
}

/** One RPC call of a send, retried on limits; a failure names the step. */
export const rpcStep = <T>(step: RpcStep, fn: () => Promise<T>): Promise<T> =>
  withRetry(fn).catch((error: unknown) => {
    throw error instanceof RpcStepError ? error : new RpcStepError(step, error)
  })

/** Policies read state that can move between the estimate and the block. */
const withMargin = (gas: bigint) => (gas * 13n) / 10n

export type SendRequest = { to: Address; data: Hex; value?: bigint; gas?: bigint }

/**
 * Signs and sends with every field filled here: gas (estimate + 30%), EIP-1559 fees from the
 * public client and the pending nonce. Nothing depends on `eth_fillTransaction` or another
 * all-in-one call a public RPC may limit. A set `gas` skips the estimate (a force-send that should
 * land even if it reverts).
 */
export async function sendSigned(account: LocalAccount, request: SendRequest): Promise<Hash> {
  const client = publicClient
  const { to, data } = request
  const value = request.value ?? 0n
  const gas =
    request.gas ??
    withMargin(
      await rpcStep('estimate', () => client.estimateGas({ account: account.address, to, data, value })),
    )
  const fees = await rpcStep('fees', () => client.estimateFeesPerGas())
  const nonce = await rpcStep('nonce', () =>
    client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  )
  const serializedTransaction = await account.signTransaction({
    chainId: chain.id,
    type: 'eip1559',
    to,
    data,
    value,
    gas,
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  })
  try {
    return await rpcStep('send', () => sendRawTransaction(client, { serializedTransaction }))
  } catch (error) {
    // A retry after a limit can find the first attempt already in the pool.
    if (/already known|known transaction/i.test(describeError(error))) return keccak256(serializedTransaction)
    throw error
  }
}

/** Waits for the receipt, retried on limits; a failure says it was the receipt step. */
export const waitForReceipt = (hash: Hash): Promise<TransactionReceipt> =>
  rpcStep('receipt', () => publicClient.waitForTransactionReceipt({ hash }))
