import type { Address } from 'viem'
import { erc20Abi } from '../abi'
import { publicClient } from '../config/client'
import { TOKENS } from '../config/contracts'
import { useAsync } from './useAsync'

export type Balances = { eth: bigint; usdc: bigint; weth: bigint }

const REFRESH_MS = 15_000

const tokenBalance = (token: Address, owner: Address) =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

async function fetchBalances(owner: Address): Promise<Balances> {
  const [eth, usdc, weth] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    tokenBalance(TOKENS.USDC.address, owner),
    tokenBalance(TOKENS.WETH.address, owner),
  ])
  return { eth, usdc, weth }
}

/** ETH / USDC / WETH balances for each address, refreshed periodically. */
export function useBalances(addresses: readonly Address[]) {
  const key = addresses.join(',')
  return useAsync(
    async () => {
      const entries = await Promise.all(addresses.map(async (a) => [a, await fetchBalances(a)] as const))
      return Object.fromEntries(entries) as Record<Address, Balances>
    },
    key,
    REFRESH_MS,
  )
}
