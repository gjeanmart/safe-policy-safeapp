import { useState } from 'react'
import type { Hex } from 'viem'
import { chain, publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { describeCall } from '../../lib/describeTx'
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
import { logActivity, trackOwnerTx, v2OwnerTxStore, v2TrackedStore } from '../../store'
import { useProposeAndTrack } from '../ProposeButton'
import { Term } from '../Term'
import { AsyncButton, Badge, Notice } from '../ui'
import { useDescribeContext } from '../useDescribe'
import { PreviewView } from './GatePreview'
import { InlineOwnerTx, useLocalOwners } from './QueueRows'
import { relay } from './relayer'
import { toSafeTxs } from './ownerCalls'
import { useV2 } from './useV2'

const sameCall = (a: { to: string; value: bigint; data: Hex }, b: { to: string; value: bigint; data: Hex }) =>
  a.to.toLowerCase() === b.to.toLowerCase() &&
  a.value === b.value &&
  a.data.toLowerCase() === b.data.toLowerCase()

/** The latest tracked, not yet executed, owner transaction carrying exactly `call`. */
function useTrackedFor(call: OwnerCall) {
  const { safe } = useSandbox()
  const list = v2TrackedStore.use()[safe.toLowerCase()] ?? []
  return list.find((t) => !t.executed && t.call && sameCall(t.call, call))
}

/** The Queue rows of the transactions started here, so they can be followed to execution in place. */
function Progress({ hashes }: { hashes: readonly Hex[] }) {
  const { safe } = useSandbox()
  const view = useV2()
  const tracked = v2TrackedStore.use()[safe.toLowerCase()] ?? []
  if (!view.model) return null
  return (
    <>
      {hashes.map((h) => (
        <InlineOwnerTx
          key={h}
          hash={h}
          tracked={tracked.find((t) => t.hash.toLowerCase() === h.toLowerCase())}
          engine={view.engine}
          model={view.model!}
          onChange={view.reload}
        />
      ))}
    </>
  )
}

/**
 * One owner (multisig) transaction started from this app: simulate it (every gate), then propose it
 * in Safe{Wallet} or sign it with local signer keys; once it exists, its Queue row (timeline, next
 * action) shows right here, so it can be scheduled, simulated at ready time and executed in place.
 * `followUps` are proposed as separate owner transactions right after it (next nonces), e.g. an
 * enableModule that must not share a batch with engine.configure.
 */
export function OwnerAction({
  call,
  delayLabel,
  followUps = [],
  onDone,
}: {
  call: OwnerCall
  /** The owners' delay, when the caller knows it (configure). */
  delayLabel?: string
  followUps?: readonly OwnerCall[]
  onDone?: () => void
}) {
  const { safe, state, v2, v2Installed, reloadState } = useSandbox()
  const proposeAndTrack = useProposeAndTrack()
  const describeCtx = useDescribeContext()
  const localOwners = useLocalOwners()
  const threshold = state?.threshold ?? 1
  const signers = localOwners.slice(0, threshold)
  const canSignHere = signers.length >= threshold
  const existing = useTrackedFor(call)
  const [started, setStarted] = useState<Hex[]>()
  const [showGates, setShowGates] = useState(false)
  const key = `${call.to}:${call.value}:${call.data}:${v2Installed}`
  const preview = useAsync(
    async () =>
      v2 && v2Installed
        ? runPreview(publicClient, v2.deployment, safe, OWNERS, call, { chainId: chain.id, ctx: describeCtx })
        : undefined,
    key,
  )
  const outcome = preview.data?.ok ? preview.data.outcome : undefined
  const needsSchedule = !!outcome?.needs.includes('schedule')
  const denied = !!outcome && !outcome.allowed && !needsSchedule
  const signerNames = signers.map((o) => o.label).join(', ')
  const all = [call, ...followUps]
  const hashes = started ?? (existing ? [existing.hash] : [])

  /** Signs `c` at `nonce` with the local signer keys; keeps the signatures and tracks it. */
  const signAt = async (c: OwnerCall, nonce: bigint) => {
    const tx = safeTransaction(c, nonce)
    const hash = safeTxHash(chain.id, safe, tx)
    const sigs = []
    for (const s of signers) sigs.push(await signHashAsRole(s, hash))
    const signatures = sortOwnerSignatures(sigs)
    const summary = describeCall(c, describeCtx)
    return { tx, hash, signatures, summary }
  }

  const propose = async () => {
    const out: Hex[] = []
    for (const c of all) out.push(await proposeAndTrack!(toSafeTxs([c])))
    setStarted(out)
    onDone?.()
  }

  const signForQueue = async () => {
    if (!v2) return
    const base = await readSafeNonce(publicClient, safe)
    const out: Hex[] = []
    for (const [i, c] of all.entries()) {
      const { tx, hash, signatures, summary } = await signAt(c, base + BigInt(i))
      v2OwnerTxStore.set((m) => ({
        ...m,
        [hash.toLowerCase()]: { safe, engine: v2.deployment.engine, tx, signatures },
      }))
      trackOwnerTx(safe, hash, summary.title, { to: c.to, value: c.value, data: c.data })
      logActivity({
        role: safe,
        mode: 'propose',
        label: summary.title,
        status: 'proposed',
        detail: `signed here by ${signerNames}`,
        safeTxHash: hash,
        nonce: tx.nonce,
        lines: summary.lines,
      })
      out.push(hash)
    }
    setStarted(out)
    onDone?.()
  }

  const executeHere = async () => {
    let last: Hex | undefined
    for (const c of all) {
      const { tx, hash, signatures, summary } = await signAt(c, await readSafeNonce(publicClient, safe))
      last = await relay(
        signers[0]!,
        { ...execTransactionCall(safe, tx, signatures), description: `execute ${summary.title}` },
        { mode: 'execute', label: summary.title, safeTxHash: hash, nonce: tx.nonce, lines: summary.lines },
      )
    }
    reloadState()
    onDone?.()
    return last
  }

  if (v2Installed && preview.loading && !preview.data)
    return <p className="muted small">Checking the owners&apos; rules…</p>

  const twoTxs =
    followUps.length > 0 &&
    `${all.length} owner transactions: ${all.map((c) => describeCall(c, describeCtx).title).join(', then ')}.`
  const blockedHere = !!existing && !started

  return (
    <div className="stack">
      {!v2Installed && (
        <p className="small muted">No guard on the owners yet: the signers can execute this as is.</p>
      )}
      {preview.data && !preview.data.ok && (
        <Notice tone="bad" title="Could not simulate">
          {preview.data.reason}
        </Notice>
      )}
      {outcome && (
        <div className="row wrap small">
          <Badge tone={outcome.allowed ? 'ok' : needsSchedule ? 'warn' : 'bad'}>
            {outcome.allowed
              ? 'no delay'
              : needsSchedule
                ? `delayed${delayLabel ? ` ${delayLabel}` : ''}`
                : 'denied'}
          </Badge>
          {needsSchedule ? (
            <span>
              A <Term k="timelock">Timelock</Term> applies: sign, <Term k="schedule">schedule</Term>, wait,
              then execute.
            </span>
          ) : (
            !outcome.allowed && outcome.deciding?.reasonText && <span>{outcome.deciding.reasonText}</span>
          )}
        </div>
      )}
      {denied && <p className="small muted">The owners&apos; rules refuse it: change them in Setup first.</p>}
      {twoTxs && <p className="small">{twoTxs}</p>}
      {!denied && !blockedHere && (
        <div className="row wrap">
          {v2Installed && (
            <AsyncButton
              onClick={async () => {
                setShowGates(true)
                preview.reload()
              }}
              title="Checks every gate now (eth_call): nothing is sent"
            >
              Simulate
            </AsyncButton>
          )}
          <AsyncButton
            variant={canSignHere && !needsSchedule ? 'secondary' : 'primary'}
            disabled={!proposeAndTrack}
            busyLabel="Proposing…"
            onClick={propose}
            title={
              proposeAndTrack
                ? needsSchedule
                  ? 'The owners sign it in Safe{Wallet} (sign only, do not execute)'
                  : 'The owners sign and execute it in Safe{Wallet}'
                : 'Open this app inside Safe{Wallet} to propose'
            }
          >
            {needsSchedule ? 'Propose & sign in Safe{Wallet}' : 'Propose in Safe{Wallet}'}
          </AsyncButton>
          {canSignHere &&
            (needsSchedule ? (
              <AsyncButton
                busyLabel="Signing…"
                onClick={signForQueue}
                title="Signs with the local signer keys at the current nonce"
              >
                Sign here with {signerNames}
              </AsyncButton>
            ) : (
              <AsyncButton
                variant="primary"
                busyLabel="Executing…"
                doneLabel="Executed"
                onClick={executeHere}
                title="Signs with the local signer keys, then sends execTransaction"
              >
                Sign &amp; execute with {signerNames}
              </AsyncButton>
            ))}
        </div>
      )}
      {showGates && preview.data && <PreviewView result={preview.data} />}
      {needsSchedule && threshold === 1 && hashes.length === 0 && (
        <p className="small muted">
          In Safe{'{Wallet}'}, sign only: on a 1-of-1 Safe it offers to execute right away, which fails under
          the Timelock.
        </p>
      )}
      {v2 && v2Installed && hashes.length > 0 && <Progress hashes={hashes} />}
      {!canSignHere && !needsSchedule && !denied && state && (
        <span className="muted small">
          To sign here instead: Make signer on an EOA role in Roles ({localOwners.length}/{threshold} local
          signer keys).
        </span>
      )}
    </div>
  )
}
