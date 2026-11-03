import { chain, publicClient } from '../../config/client'
import { EXPLORER } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { execOwnerTxAsRole, signHashAsRole } from '../../lib/roleExec'
import {
  OWNERS,
  type OwnerCall,
  readSafeNonce,
  runPreview,
  safeTransaction,
  safeTxHash,
  sortOwnerSignatures,
} from '../../lib/v2'
import { logActivity } from '../../store'
import { ProposeButton } from '../ProposeButton'
import { AsyncButton, Badge, Notice } from '../ui'
import { ScheduleOwnerTx, ScheduleSteps, useLocalOwners } from './Queue'
import { toSafeTxs } from './ownerCalls'

/**
 * One owner (multisig) transaction started from this app. It reads what the owners' policies say
 * (a gate preview as Owners) and offers the right route: execute it now, or, under a Timelock, the
 * sign → schedule → wait → execute steps. Without V2 installed nothing checks the multisig path.
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

  const executeHere = async () => {
    if (nonce.data === undefined) throw new Error('Reading the Safe nonce…')
    const signers = localOwners.slice(0, threshold)
    const tx = safeTransaction(call, nonce.data)
    const hash = safeTxHash(chain.id, safe, tx)
    const sigs = []
    for (const s of signers) sigs.push(await signHashAsRole(s, hash))
    const sent = await execOwnerTxAsRole(signers[0]!, safe, tx, sortOwnerSignatures(sigs))
    logActivity({
      role: signers[0]!.address,
      mode: 'execute',
      label: `owners: ${call.description}`,
      status: 'sent',
      txHash: sent,
      link: `${EXPLORER}/tx/${sent}`,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: sent })
    if (receipt.status !== 'success') throw new Error('Reverted on-chain')
    reloadState()
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
            {outcome.allowed ? 'allowed now' : needsSchedule ? 'needs a schedule' : 'denied'}
          </Badge>
          {outcome.deciding?.reasonText && <span>{outcome.deciding.reasonText}</span>}
        </div>
      )}
      {denied && (
        <p className="small muted">
          The owners&apos; rules refuse it, so there is nothing to sign. Change the rules (Setup → V2) first.
        </p>
      )}
      {needsSchedule && v2 ? (
        <>
          <p className="small">
            The owners&apos; Timelock delays this transaction{delayLabel ? ` by ${delayLabel}` : ''}. It goes
            through four steps:
          </p>
          <ScheduleSteps delay={delayLabel} />
          <ScheduleOwnerTx
            engine={v2}
            currentNonce={nonce.data}
            call={call}
            onScheduled={() => {
              reloadState()
              onDone?.()
            }}
          />
          <p className="small muted">Once scheduled, follow it and execute it in Setup → V2 → Queue.</p>
        </>
      ) : (
        !denied && (
          <div className="row wrap">
            <ProposeButton
              label="Propose in Safe{Wallet}"
              variant={localOwners.length >= threshold ? 'secondary' : 'primary'}
              preview={false}
              txs={toSafeTxs([call])}
              info="The signers sign and execute it in the Safe{Wallet} queue."
              onProposed={() => onDone?.()}
            />
            {localOwners.length >= threshold ? (
              <AsyncButton variant="primary" onClick={executeHere}>
                Sign &amp; execute with{' '}
                {localOwners
                  .slice(0, threshold)
                  .map((o) => o.label)
                  .join(', ')}
              </AsyncButton>
            ) : (
              <span className="muted small">
                To sign here instead: Roles → Make signer on an EOA role ({localOwners.length}/{threshold}{' '}
                local signer keys).
              </span>
            )}
          </div>
        )
      )}
    </div>
  )
}
