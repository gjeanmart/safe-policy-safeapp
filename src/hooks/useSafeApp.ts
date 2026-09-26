import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import { useEffect, useMemo, useState } from 'react'
import { type Address, getAddress } from 'viem'
import { chain } from '../config/client'
import type { SafeTx } from '../lib/safe'

export type SafeAppConnection =
  | { mode: 'loading' }
  | { mode: 'standalone' }
  | { mode: 'safe-app'; safe: Address; chainId: number; propose: (txs: SafeTx[]) => Promise<string> }

const sdk = new SafeAppsSDK()

/** How long to wait for Safe{Wallet} to answer before assuming we are not in its iframe. */
const HANDSHAKE_TIMEOUT_MS = 1500

/**
 * Connects to Safe{Wallet} through the Safe Apps SDK. Outside its iframe the SDK never answers,
 * so after a short timeout the app falls back to standalone mode (reads and module txs only).
 */
export function useSafeApp(): SafeAppConnection {
  const [info, setInfo] = useState<{ safe: Address; chainId: number } | null | undefined>(() =>
    // Not framed at all: no Safe{Wallet} to talk to.
    window.parent === window ? null : undefined,
  )

  useEffect(() => {
    if (window.parent === window) return
    const timeout = setTimeout(() => setInfo((current) => current ?? null), HANDSHAKE_TIMEOUT_MS)
    sdk.safe
      .getInfo()
      .then(({ safeAddress, chainId }) => setInfo({ safe: getAddress(safeAddress), chainId }))
      .catch(() => setInfo(null))
    return () => clearTimeout(timeout)
  }, [])

  return useMemo<SafeAppConnection>(() => {
    if (info === undefined) return { mode: 'loading' }
    if (info === null) return { mode: 'standalone' }
    return {
      mode: 'safe-app',
      ...info,
      propose: async (txs) => {
        const { safeTxHash } = await sdk.txs.send({
          txs: txs.map(({ to, value, data }) => ({ to, value: (value ?? 0n).toString(), data })),
        })
        return safeTxHash
      },
    }
  }, [info])
}

export const isSupportedChain = (chainId: number) => chainId === chain.id
