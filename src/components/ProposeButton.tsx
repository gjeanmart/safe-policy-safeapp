import { type ReactNode, useState } from 'react'
import type { Hex } from 'viem'
import { useSandbox } from '../context'
import type { SafeTx } from '../lib/safe'
import { trackOwnerTx } from '../store'
import { InfoTip } from './Tooltip'
import { AsyncButton, SafeTxPreview } from './ui'
import { useLogProposal } from './useDescribe'

const STANDALONE_NOTE = 'open this app inside Safe{Wallet} to propose'

/**
 * Proposes txs to the owners in Safe{Wallet}, then tracks it (Queue) and logs it (Activity).
 * Returns the Safe transaction hash. Several txs are batched by Safe{Wallet} into one.
 */
export function useProposeAndTrack(): ((txs: SafeTx[], trackAs?: string) => Promise<Hex>) | undefined {
  const { safe, propose } = useSandbox()
  const logProposal = useLogProposal()
  if (!propose) return undefined
  return async (txs, trackAs) => {
    const hash = (await propose(txs)) as Hex
    const summary = logProposal(txs, hash)
    const only = txs.length === 1 ? txs[0]! : undefined
    trackOwnerTx(
      safe,
      hash,
      trackAs ?? summary.title,
      only && { to: only.to, value: only.value ?? 0n, data: only.data },
    )
    return hash
  }
}

/**
 * Proposes a batch to the Safe owners via Safe{Wallet}. The owners then sign it in the Safe{Wallet}
 * queue as usual. Every proposal is tracked (by its Safe transaction hash) so that, under Policy
 * Engine V2, the Queue can schedule and execute it once signed.
 */
export function ProposeButton({
  txs,
  label,
  title,
  info,
  variant = 'primary',
  onProposed,
  preview = true,
  trackAs,
  proposedNote,
}: {
  txs: SafeTx[]
  label: string
  /** Tooltip describing what the owners will be asked to sign. */
  title?: string
  /** Explanatory copy behind an ⓘ next to the button. */
  info?: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  onProposed?: (safeTxHash: string) => void
  preview?: boolean
  /** Name of the transaction in the Queue (default: the decoded call). */
  trackAs?: string
  /** Shown once proposed, instead of the default next step. */
  proposedNote?: ReactNode
}) {
  const { v2Installed } = useSandbox()
  const proposeAndTrack = useProposeAndTrack()
  const [proposed, setProposed] = useState<string>()

  return (
    <div className="propose">
      <div className="row">
        <AsyncButton
          variant={variant}
          disabled={!proposeAndTrack || txs.length === 0}
          busyLabel="Proposing…"
          // With an ⓘ next to the button, the explanation lives there only (no duplicate tooltip).
          title={
            info ? undefined : proposeAndTrack ? title : `${title ? `${title}. ` : ''}${STANDALONE_NOTE}`
          }
          onClick={async () => {
            const hash = await proposeAndTrack!(txs, trackAs)
            setProposed(hash)
            onProposed?.(hash)
          }}
        >
          {label}
        </AsyncButton>
        {info && (
          <InfoTip>
            {info}
            {!proposeAndTrack && ` (${STANDALONE_NOTE})`}
          </InfoTip>
        )}
        {proposed && (
          <span className="muted small">
            {proposedNote ??
              (v2Installed
                ? 'Proposed: sign it in Safe{Wallet}, then follow it in the Queue.'
                : 'Proposed: sign and execute it in Safe{Wallet}.')}
          </span>
        )}
      </div>
      {preview && <SafeTxPreview txs={txs} />}
    </div>
  )
}
