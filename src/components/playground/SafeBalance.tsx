import { formatUnits } from 'viem'
import { erc20Abi } from '../../abi'
import { publicClient } from '../../config/client'
import type { Token } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { formatAmount } from '../../lib/format'

const REFRESH_MS = 10_000

/** Native ETH, for the value-bearing actions. */
export const ETH: Token = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'ETH',
  decimals: 18,
}

/**
 * The Safe's balance of `token` (the module spends the Safe's funds, not its own), with a
 * shortcut to fill the full amount.
 */
export function SafeBalance({ token, onMax }: { token: Token; onMax?: (amount: string) => void }) {
  const { safe } = useSandbox()
  const balance = useAsync(
    () =>
      token === ETH
        ? publicClient.getBalance({ address: safe })
        : publicClient.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [safe],
          }),
    `${safe}:${token.address}`,
    REFRESH_MS,
  )

  if (balance.data === undefined) return <>Safe balance: …</>
  return (
    <>
      Safe balance: {formatAmount(balance.data, token.decimals, 6)} {token.symbol}
      {onMax && balance.data > 0n && (
        <>
          {' · '}
          <button
            type="button"
            className="link"
            onClick={() => onMax(formatUnits(balance.data!, token.decimals))}
          >
            max
          </button>
        </>
      )}
    </>
  )
}
