import { type ReactNode, useState } from 'react'
import { useSandbox } from '../context'
import { describeError } from '../lib/errors'
import type { SafeTx } from '../lib/safe'
import { ConfirmIconButton } from './ConfirmIconButton'
import { TrashIcon } from './icons'

/**
 * Compact icon button that proposes `txs` to the Safe owners after an inline confirmation;
 * `title` doubles as its tooltip.
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
  const { propose } = useSandbox()
  const [status, setStatus] = useState<'idle' | 'busy' | 'proposed' | 'failed'>('idle')
  const [error, setError] = useState<string>()

  const run = async () => {
    setStatus('busy')
    try {
      await propose!(txs)
      setStatus('proposed')
    } catch (err) {
      setError(describeError(err))
      setStatus('failed')
    }
  }

  if (status === 'proposed') {
    return <span className="muted small">proposed — sign it in the Safe{'{Wallet}'} queue</span>
  }
  return (
    <>
      <ConfirmIconButton
        title={propose ? title : `${title} (open inside Safe{Wallet} to propose)`}
        icon={icon}
        disabled={!propose || status === 'busy' || txs.length === 0}
        onConfirm={run}
      />
      {status === 'failed' && <span className="error-text"> {error}</span>}
    </>
  )
}
