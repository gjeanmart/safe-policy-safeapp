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
  /** `submittedAt`: when the owner confirmed, in ms. */
  signatures: { signer: Address; signature: Hex; submittedAt?: number }[]
  executed: boolean
  /** Who proposed it in Safe{Wallet}, and when (ms). */
  proposer?: Address
  submittedAt?: number
}

/** Which Safe Apps SDK signing call a message probe uses. */
export type MessageProbeKind = 'signMessage' | 'signTypedMessage'

/** Everything Safe{Wallet} answered to a test message signature, raw, for the Settings spike. */
export type MessageProbe = {
  kind: MessageProbeKind
  /** From `sdk.safe.getInfo()`: whether off-chain (ERC-1271) signing can work depends on it. */
  safe?: { version: string | null; fallbackHandler: string | null; threshold: number }
  /** `sdk.eth.setSafeSettings([{ offChainSigning: true }])`: what Safe{Wallet} kept. */
  settings?: unknown
  /** EIP-191 / EIP-712 hash of the message itself (not the Safe message hash). */
  messageHash: string
  /** `{ messageHash }`: signed off-chain; `{ safeTxHash }`: a signMessage transaction was proposed. */
  response?: unknown
  /** `sdk.safe.getOffChainSignature(messageHash)`: the combined owner signatures once complete. */
  offChainSignature?: string
  /** The message as the Safe Client Gateway stores it (confirmations, prepared signature). */
  gateway?: unknown
  /** `sdk.safe.isMessageHashSigned`: the Safe's isValidSignature, through Safe{Wallet}'s RPC. */
  validOnChain?: boolean
  errors: { step: string; message: string }[]
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
      probeMessageSigning: (kind: MessageProbeKind) => Promise<MessageProbe>
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

const PROBE_TEXT = 'Safe Policy Sandbox: off-chain signing test'

/** A minimal EIP-712 payload: one string field, domain bound to this chain. */
const probeTypedData = () => ({
  domain: { name: 'Safe Policy Sandbox', version: '1', chainId: chain.id },
  types: { Test: [{ name: 'text', type: 'string' }] },
  primaryType: 'Test',
  message: { text: PROBE_TEXT },
})

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)

/**
 * Asks Safe{Wallet} to sign a test message and records every answer, so the user can see whether
 * this Safe signs off-chain (a message hash, then signatures) or proposes an on-chain signMessage
 * transaction. Each step runs even when an earlier one failed.
 */
async function probeMessageSigning(kind: MessageProbeKind, chainId: number): Promise<MessageProbe> {
  const errors: MessageProbe['errors'] = []
  const attempt = async <T>(step: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      errors.push({ step, message: errorText(error) })
      return undefined
    }
  }
  const typed = probeTypedData()
  const info = await attempt('getInfo', () => sdk.safe.getInfo())
  const settings = await attempt('setSafeSettings', () =>
    sdk.eth.setSafeSettings([{ offChainSigning: true }]),
  )
  const messageHash =
    kind === 'signMessage'
      ? sdk.safe.calculateMessageHash(PROBE_TEXT)
      : sdk.safe.calculateTypedMessageHash(typed)
  const response = await attempt(kind, () =>
    kind === 'signMessage' ? sdk.txs.signMessage(PROBE_TEXT) : sdk.txs.signTypedMessage(typed),
  )
  const safeMessageHash = response && 'messageHash' in response ? response.messageHash : undefined
  const offChainSignature = safeMessageHash
    ? await attempt('getOffChainSignature', () => sdk.safe.getOffChainSignature(safeMessageHash))
    : undefined
  const gateway = safeMessageHash
    ? await attempt('gateway message', async () => {
        const res = await fetch(
          `https://safe-client.safe.global/v1/chains/${chainId}/messages/${safeMessageHash}`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as unknown
      })
    : undefined
  const validOnChain = await attempt('isMessageHashSigned', () =>
    sdk.safe.isMessageHashSigned(messageHash, offChainSignature || '0x'),
  )
  return {
    kind,
    safe: info && { version: info.version, fallbackHandler: info.fallbackHandler, threshold: info.threshold },
    settings,
    messageHash,
    response,
    offChainSignature,
    gateway,
    validOnChain,
    errors,
  }
}

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
          // Policy Engine V2 refuses a non-zero safeTxGas; 0 is also what Safe >= 1.3 needs.
          params: { safeTxGas: 0 },
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
            c.signature
              ? [
                  {
                    signer: getAddress(c.signer.value),
                    signature: c.signature as Hex,
                    submittedAt: c.submittedAt,
                  },
                ]
              : [],
          ),
          executed: details.executedAt != null,
          proposer: info.proposer ? getAddress(info.proposer.value) : undefined,
          submittedAt: info.submittedAt,
        }
      },
      probeMessageSigning: (kind) => probeMessageSigning(kind, info.chainId),
    }
  }, [info])
}

export const isSupportedChain = (chainId: number) => chainId === chain.id
