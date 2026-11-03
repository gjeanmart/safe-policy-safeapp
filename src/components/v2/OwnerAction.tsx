import { useState } from 'react'
import { chain, publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { execTransactionCall, signHashAsRole } from '../../lib/roleExec'
import {
  OWNERS,
  type OwnerCall,
  readSafeNonce,
  runPreview,
  safeTransaction,
  safeTxHash,
  sortOwnerSignatures,
} from '../../lib/v2'
import { trackOwnerTx, v2OwnerTxStore } from '../../store'
import { ProposeButton } from '../ProposeButton'
import { AsyncButton, Badge, Notice } from '../ui'
import { OwnerTxTimeline } from './OwnerTxTimeline'
import { useLocalOwners } from './Queue'
import { relay } from './relayer'
import { toSafeTxs } from './ownerCalls'

/**
 * One owner (multisig) transaction started from this app: a status line from the owners' gate
 * preview, then the route. No delay: propose it, or sign and execute it here. Under a Timelock:
 * the owners sign (in Safe{Wallet} or here) and the Queue schedules and executes it.
 */
export function OwnerAction({
  call,
  delayLabel,
  onDone,
}: {
  call: OwnerCall
  /** The owners' delay, when the caller knows it (configure). */
  delayLabel?: string
  onDone?: () => void
}) {
  const { safe, state, v2, v2Installed, reloadState } = useSandbox()
  const localOwners = useLocalOwners()
  const threshold = state?.threshold ?? 1
  const signers = localOwners.slice(0, threshold)
  const canSignHere = signers.length >= threshold
  const [signedHere, setSignedHere] = useState<string>()
  const key = `${call.to}:${call.value}:${call.data}:${v2Installed}`
  const preview = useAsync(
    async () =>
      v2 && v2Installed
        ? runPreview(publicClient, v2.deployment, safe, OWNERS, call, { chainId: chain.id })
        : undefined,
    key,
  )
  const nonce = useAsync(() => readSafeNonce(publicClient, safe), `${safe}:${key}`, 10_000)
  const outcome = preview.data?.ok ? preview.data.outcome : undefined
  const needsSchedule = !!outcome?.needs.includes('schedule')
  const denied = !!outcome && !outcome.allowed && !needsSchedule
  const signerNames = signers.map((o) => o.label).join(', ')

  const sign = async () => {
    if (nonce.data === undefined) throw new Error('Reading the Safe nonce…')
    const tx = safeTransaction(call, nonce.data)
    const hash = safeTxHash(chain.id, safe, tx)
    const sigs = []
    for (const s of signers) sigs.push(await signHashAsRole(s, hash))
    return { tx, hash, signatures: sortOwnerSignatures(sigs) }
  }

  const executeHere = async () => {
    const { tx, signatures } = await sign()
    await relay(signers[0]!, {
      ...execTransactionCall(safe, tx, signatures),
      description: `owners: ${call.description}`,
    })
    reloadState()
    onDone?.()
  }

  const signForQueue = async () => {
    if (!v2) return
    const { tx, hash, signatures } = await sign()
    v2OwnerTxStore.set((all) => ({
      ...all,
      [hash.toLowerCase()]: { safe, engine: v2.deployment.engine, tx, signatures },
    }))
    trackOwnerTx(safe, hash, call.description)
    setSignedHere(`Signed at nonce ${tx.nonce}: it is in the Queue, which schedules and executes it.`)
    onDone?.()
  }

  if (v2Installed && preview.loading && !preview.data)
    return <p className="muted small">Checking the owners&apos; policies…</p>

  return (
    <div className="stack">
      {!v2Installed && (
        <p className="small muted">No guard on the multisig path yet: the signers can execute this as is.</p>
      )}
      {preview.data && !preview.data.ok && <Notice tone="bad">Preview failed: {preview.data.reason}</Notice>}
      {outcome && (
        <div className="row wrap small">
          <Badge tone={outcome.allowed ? 'ok' : needsSchedule ? 'warn' : 'bad'}>
            {outcome.allowed
              ? 'no delay'
              : needsSchedule
                ? `delayed${delayLabel ? ` ${delayLabel}` : ''}`
                : 'denied'}
          </Badge>
          {!outcome.allowed && outcome.deciding?.reasonText && <span>{outcome.deciding.reasonText}</span>}
        </div>
      )}
      {denied && <p className="small muted">The owners&apos; rules refuse it: change them in Setup first.</p>}
      {needsSchedule && v2 && (
        <>
          <OwnerTxTimeline current="sign" delay={delayLabel} />
          <div className="row wrap">
            <ProposeButton
              label="Propose & sign in Safe{Wallet}"
              variant="primary"
              preview={false}
              txs={toSafeTxs([call])}
              trackAs={call.description}
              proposedNote="Proposed: sign it in Safe{Wallet}, do not execute."
              onProposed={() => onDone?.()}
            />
            {canSignHere && (
              <AsyncButton onClick={signForQueue} title="Signs with local signer keys at the current nonce">
                Sign here with {signerNames}
              </AsyncButton>
            )}
          </div>
          <p className="small muted">
            Sign only, do not execute
            {threshold === 1
              ? ': in a 1-of-1 Safe, Safe{Wallet} offers to execute right away, which fails under the Timelock'
              : ''}
            . It appears in the Queue (Setup), which schedules and executes it.
          </p>
          {signedHere && <Notice>{signedHere}</Notice>}
        </>
      )}
      {!needsSchedule && !denied && (
        <div className="row wrap">
          <ProposeButton
            label="Propose in Safe{Wallet}"
            variant={canSignHere ? 'secondary' : 'primary'}
            preview={false}
            txs={toSafeTxs([call])}
            trackAs={call.description}
            onProposed={() => onDone?.()}
          />
          {canSignHere ? (
            <AsyncButton variant="primary" onClick={executeHere}>
              Sign &amp; execute with {signerNames}
            </AsyncButton>
          ) : (
            <span className="muted small">
              To sign here instead: Roles → Make signer on an EOA role ({localOwners.length}/{threshold} local
              signer keys).
            </span>
          )}
        </div>
      )}
    </div>
  )
}
