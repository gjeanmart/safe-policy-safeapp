import type { Address } from 'viem'
import { guardAbi } from '../abi'
import { publicClient } from '../config/client'
import { useAsync } from './useAsync'

/** The guard's immutable configuration delay and expiry, in seconds. */
export function useGuardTiming(guard: Address) {
  return useAsync(async () => {
    const [delay, expiry] = await Promise.all([
      publicClient.readContract({ address: guard, abi: guardAbi, functionName: 'DELAY' }),
      publicClient.readContract({ address: guard, abi: guardAbi, functionName: 'EXPIRY' }),
    ])
    return { delay, expiry }
  }, guard)
}
