import { type ReactNode, useState } from 'react'
import { describeError } from '../lib/errors'
import type { SafeTx } from '../lib/safe'
import { ConfirmIconButton } from './ConfirmIconButton'
import { TrashIcon } from './icons'
import { useProposeAndTrack } from './ProposeButton'
import { ErrorLine } from './ui'

/**
 * Compact icon button that proposes `txs` to the Safe owners after an inline confirmation;
 * `title` doubles as its tooltip. Tracked and logged like any proposal.
 */
export function ProposeIconButton({
  txs,
  title,
  icon = <TrashIcon />,
}: {
  txs: SafeTx[]
  title: string
  icon?: ReactNode
}) {
  const proposeAndTrack = useProposeAndTrack()
  const [status, setStatus] = useState<'idle' | 'busy' | 'proposed' | 'failed'>('idle')
  const [error, setError] = useState<string>()

  const run = async () => {
    setStatus('busy')
    try {
      await proposeAndTrack!(txs)
      setStatus('proposed')
    } catch (err) {
      setError(describeError(err))
      setStatus('failed')
    }
  }

  if (status === 'proposed') {
    return <span className="muted small">Proposed: sign it in Safe{'{Wallet}'}</span>
  }
  return (
    <>
      <ConfirmIconButton
        title={proposeAndTrack ? title : `${title} (open inside Safe{Wallet} to propose)`}
        icon={icon}
        disabled={!proposeAndTrack || status === 'busy' || txs.length === 0}
        onConfirm={run}
      />
      {status === 'failed' && error && <ErrorLine message={error} />}
    </>
  )
}
