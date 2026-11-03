import { type ReactNode, useState } from 'react'
import type { Hex } from 'viem'
import { useSandbox } from '../context'
import type { SafeTx } from '../lib/safe'
import { trackOwnerTx } from '../store'
import { InfoTip } from './Tooltip'
import { AsyncButton, SafeTxPreview } from './ui'

const STANDALONE_NOTE = 'open this app inside Safe{Wallet} to propose'

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
  /** Name of the transaction in the Queue (default: the call's description). */
  trackAs?: string
  /** Shown once proposed, instead of the default next step. */
  proposedNote?: ReactNode
}) {
  const { safe, propose, v2Installed } = useSandbox()
  const [proposed, setProposed] = useState<string>()

  return (
    <div className="propose">
      <div className="row">
        <AsyncButton
          variant={variant}
          disabled={!propose || txs.length === 0}
          // With an ⓘ next to the button, the explanation lives there only (no duplicate tooltip).
          title={info ? undefined : propose ? title : `${title ? `${title} — ` : ''}${STANDALONE_NOTE}`}
          onClick={async () => {
            const hash = await propose!(txs)
            trackOwnerTx(
              safe,
              hash as Hex,
              trackAs ?? (txs.length === 1 ? txs[0]!.description : `${label} (${txs.length} calls)`),
            )
            setProposed(hash)
            onProposed?.(hash)
          }}
        >
          {label}
        </AsyncButton>
        {info && (
          <InfoTip>
            {info}
            {!propose && ` (${STANDALONE_NOTE})`}
          </InfoTip>
        )}
        {proposed && (
          <span className="muted">
            {proposedNote ??
              (v2Installed
                ? 'Proposed: sign it in Safe{Wallet}, then follow it in Setup → Queue.'
                : 'Proposed: sign and execute it in the Safe{Wallet} queue.')}
          </span>
        )}
      </div>
      {preview && <SafeTxPreview txs={txs} />}
    </div>
  )
}
