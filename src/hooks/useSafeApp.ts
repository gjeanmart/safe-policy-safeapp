import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import { useEffect, useMemo, useState } from 'react'
import { type Address, type Hex, getAddress } from 'viem'
import { chain } from '../config/client'
import type { SafeTx } from '../lib/safe'

/** A transaction from the Safe{Wallet} queue, with the owners' signatures collected so far. */
export type QueuedSafeTx = {
  safeTxHash: Hex
  to: Address
  value: bigint
  data: Hex
  operation: number
  safeTxGas: bigint
  baseGas: bigint
  gasPrice: bigint
  gasToken: Address
  refundReceiver: Address
  nonce: bigint
  confirmationsRequired: number
  signatures: { signer: Address; signature: Hex }[]
  executed: boolean
}

export type SafeAppConnection =
  | { mode: 'loading' }
  | { mode: 'standalone' }
  | {
      mode: 'safe-app'
      safe: Address
      chainId: number
      propose: (txs: SafeTx[]) => Promise<string>
      getQueuedTx: (safeTxHash: string) => Promise<QueuedSafeTx>
    }

/**
 * Only accept postMessage traffic from Safe{Wallet} itself, so another site embedding this app in
 * an iframe cannot impersonate it (fake Safe address, fake proposal results). Keep in sync with
 * `frame-ancestors` in public/_headers.
 */
const SAFE_WALLET_ORIGINS = [
  // Production
  /^https:\/\/app\.safe\.global$/,
  // Safe{Wallet} staging / dev / preview deployments
  /^https:\/\/([a-z0-9-]+\.)*5afe\.dev$/,
  // A locally running Safe{Wallet}
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
]

const sdk = new SafeAppsSDK({ allowedDomains: SAFE_WALLET_ORIGINS })

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
      getQueuedTx: async (safeTxHash) => {
        const details = await sdk.txs.getBySafeTxHash(safeTxHash)
        const info = details.detailedExecutionInfo
        if (!details.txData || !info || !('confirmations' in info))
          throw new Error('Not a multisig transaction of this Safe')
        return {
          safeTxHash: info.safeTxHash as Hex,
          to: getAddress(details.txData.to.value),
          value: BigInt(details.txData.value ?? '0'),
          data: (details.txData.hexData ?? '0x') as Hex,
          operation: Number(details.txData.operation),
          safeTxGas: BigInt(info.safeTxGas),
          baseGas: BigInt(info.baseGas),
          gasPrice: BigInt(info.gasPrice),
          gasToken: getAddress(info.gasToken),
          refundReceiver: getAddress(info.refundReceiver.value),
          nonce: BigInt(info.nonce),
          confirmationsRequired: info.confirmationsRequired,
          signatures: info.confirmations.flatMap((c) =>
            c.signature ? [{ signer: getAddress(c.signer.value), signature: c.signature as Hex }] : [],
          ),
          executed: details.executedAt != null,
        }
      },
    }
  }, [info])
}

export const isSupportedChain = (chainId: number) => chainId === chain.id
