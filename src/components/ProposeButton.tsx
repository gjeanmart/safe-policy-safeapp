import { type ReactNode, useState } from 'react'
import { useSandbox } from '../context'
import type { SafeTx } from '../lib/safe'
import { InfoTip } from './Tooltip'
import { AsyncButton, SafeTxPreview } from './ui'

const STANDALONE_NOTE = 'open this app inside Safe{Wallet} to propose'

/**
 * Proposes a batch to the Safe owners via Safe{Wallet}. The owners then sign and execute it in
 * the Safe{Wallet} queue as usual (the multisig entrypoint is untouched by this app).
 */
export function ProposeButton({
  txs,
  label,
  title,
  info,
  variant = 'primary',
  onProposed,
  preview = true,
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
}) {
  const { propose } = useSandbox()
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
          <span className="muted">Proposed — sign &amp; execute it in the Safe{'{Wallet}'} queue.</span>
        )}
      </div>
      {preview && <SafeTxPreview txs={txs} />}
    </div>
  )
}
