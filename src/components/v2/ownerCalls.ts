import { type Address, type Hex, getAddress } from 'viem'
import { publicClient } from '../../config/client'
import type { SafeTx } from '../../lib/safe'
import { type OwnerCall, Operation } from '../../lib/v2'

/**
 * Owner calls as Safe{Wallet} proposals. The Safe Apps SDK only proposes CALLs; several calls in one
 * proposal are batched by Safe{Wallet} through MultiSendCallOnly, which the V2 engine trusts. A
 * configuration call (request / apply / invalidate) must be proposed alone: inside a batch it is
 * `GuardTargetDenied`.
 */
export function toSafeTxs(calls: readonly OwnerCall[]): SafeTx[] {
  return calls.map((c) => {
    if (c.operation !== Operation.CALL)
      throw new Error(`${c.description}: Safe{Wallet} proposals are CALLs only`)
    return { to: c.to, value: c.value, data: c.data, description: c.description }
  })
}

/** `FallbackManager.FALLBACK_HANDLER_STORAGE_SLOT`. */
const FALLBACK_HANDLER_SLOT: Hex = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'

export async function readFallbackHandler(safe: Address): Promise<Address> {
  const word = await publicClient.getStorageAt({ address: safe, slot: FALLBACK_HANDLER_SLOT })
  return getAddress(`0x${(word ?? '0x').slice(-40).padStart(40, '0')}`)
}
