import { useCallback, useState } from 'react'
import { type Address, type Hex, encodeFunctionData, isAddressEqual } from 'viem'
import { safeAbi } from '../../abi'
import { chain, publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { describeCall } from '../../lib/describeTx'
import { formatClock, formatDuration } from '../../lib/format'
import { execTransactionCall, signHashAsRole } from '../../lib/roleExec'
import { runSteps } from '../../lib/runner'
import {
  type LabelContext,
  OWNERS,
  Operation,
  type PreviewResult,
  type QueueEntry,
  type SafeV2Model,
  type ScheduleStatus,
  actorLabel,
  cancellersOf,
  durationLabel,
  ownerNonceState,
  readCancelDigest,
  readSchedule,
  runPreview,
  scheduleStatus,
  sortOwnerSignatures,
  timelockCalls,
} from '../../lib/v2'
import {
  type Role,
  type TrackedOwnerTx,
  hasLocalKey,
  markOwnerTxExecuted,
  roleKind,
  rolesStore,
  settleProposal,
  untrackOwnerTx,
} from '../../store'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { Term } from '../Term'
import { AsyncButton, Badge, ErrorLine, ShortHash } from '../ui'
import { useDescribeContext } from '../useDescribe'
import { PreviewView } from './GatePreview'
import { type OwnerStep, OwnerTxTimeline } from './OwnerTxTimeline'
import {
  type TimedSimulation,
  hasGasFields,
  readMergedTimelock,
  readOwnerRow,
  simulateAtTime,
} from './ownerTx'
import { type RelayLog, relay, useRelayer } from './relayer'
import { useSafeNonce } from './useQueueData'

const ROW_REFRESH_MS = 15_000

/** A schedule only changes while it waits, is ready (executed by someone) or is frozen (lifted). */
const LIVE_STATUSES: readonly ScheduleStatus[] = ['waiting', 'ready', 'frozen']

/** Owners local to this browser: EOA roles that are owners of the Safe. */
export function useLocalOwners(): Role[] {
  const { state } = useSandbox()
  return rolesStore
    .use()
    .filter((r) => roleKind(r) === 'eoa' && (state?.owners ?? []).some((o) => isAddressEqual(o, r.address)))
}

/** Countdown, ready, frozen, void or expired, as the Timelock check would judge it now. */
function StatusBadge({
  status,
  frozenUntil,
  isConfiguration,
}: {
  status: { status: ScheduleStatus; readyAt: bigint; expiresAt?: bigint }
  frozenUntil: bigint
  isConfiguration: boolean
}) {
  const now = BigInt(useNow())
  switch (status.status) {
    case 'waiting':
      return (
        <Badge tone="warn">
          ready in {formatDuration(status.readyAt - now)} ({formatClock(status.readyAt)})
        </Badge>
      )
    case 'ready':
      return (
        <Badge tone="ok">
          ready{status.expiresAt !== undefined && ` · expires in ${formatDuration(status.expiresAt - now)}`}
        </Badge>
      )
    case 'frozen':
      return (
        <Badge tone="bad">
          frozen until {formatClock(frozenUntil)}
          {!isConfiguration && ', then void'}
        </Badge>
      )
    case 'void':
      return <Badge tone="bad">void after a freeze: schedule again</Badge>
    case 'expired':
      return <Badge tone="bad">expired: schedule again</Badge>
  }
}

/**
 * "Simulate execution at ready time": an eth_call with the block time set to when the Timelock
 * opens. If the RPC refuses block overrides, says when it will be ready and checks the other gates.
 */
export function ReadySimulation({
  readyAt,
  simulate,
  fallback,
}: {
  readyAt: bigint
  simulate: (time: bigint) => Promise<TimedSimulation>
  fallback: () => Promise<PreviewResult>
}) {
  const [result, setResult] = useState<{ timed: TimedSimulation; gates?: PreviewResult }>()
  const at = formatClock(readyAt)
  const run = async () => {
    const timed = await simulate(readyAt + 1n)
    setResult({ timed, gates: 'unsupported' in timed ? await fallback() : undefined })
  }
  return (
    <div className="stack-tight">
      <AsyncButton
        onClick={run}
        busyLabel="Simulating…"
        title={`eth_call with the block time set to ${at}: nothing is sent`}
      >
        Simulate execution at ready time
      </AsyncButton>
      {result &&
        ('unsupported' in result.timed ? (
          <div className="small">
            <span className="muted">
              This RPC cannot simulate a later time. It will be ready at {at}; the other gates now:
            </span>
            {result.gates && <PreviewView result={result.gates} />}
          </div>
        ) : result.timed.ok ? (
          <span className="done-label small">Would execute at {at}</span>
        ) : (
          <ErrorLine message={`Would fail at ${at}: ${result.timed.reason}`} />
        ))}
    </div>
  )
}

/** Cancel buttons a local key can press: the owners (threshold local signer keys) or a listed canceller. */
function OwnerCancel({
  engine,
  model,
  txHash,
  attachmentIds,
  isConfiguration,
  log,
  onChange,
}: {
  engine: V2Engine
  model: SafeV2Model
  txHash: Hex
  attachmentIds: readonly Hex[]
  isConfiguration: boolean
  log: RelayLog
  onChange: () => void
}) {
  const { safe, state } = useSandbox()
  const { deployment } = engine
  const relayer = useRelayer()
  const localOwners = useLocalOwners()
  const roles = rolesStore.use()
  const threshold = state?.threshold ?? 1
  const scheduledIds = new Set(attachmentIds)
  const cancellers = cancellersOf(
    { isConfiguration },
    model.attachments
      .filter((a) => scheduledIds.has(a.attachmentId))
      .flatMap((a) => (a.settings?.policy === 'timelock' ? a.settings.settings.cancellers : [])),
  )
  const cancellerRole = roles.find(
    (r) => hasLocalKey(r) && cancellers.some((c) => isAddressEqual(c, r.address)),
  )
  const cancelLog: RelayLog = { ...log, mode: 'cancel', label: `Cancel: ${log.label}` }

  const cancelAsOwners = async () => {
    if (!relayer) throw new Error('Add a relayer in Roles first')
    const digest = await readCancelDigest(publicClient, deployment, safe, txHash)
    const sigs = []
    for (const s of localOwners.slice(0, threshold)) sigs.push(await signHashAsRole(s, digest))
    const hash = await relay(
      relayer,
      timelockCalls.cancelAsOwners(deployment, safe, txHash, sortOwnerSignatures(sigs)),
      cancelLog,
    )
    onChange()
    return hash
  }

  return (
    <>
      {localOwners.length >= threshold && (
        <AsyncButton
          variant="danger"
          disabled={!relayer}
          onClick={cancelAsOwners}
          busyLabel="Cancelling…"
          doneLabel="Cancelled"
          title="Signed by the local signer keys. Final: this transaction can never be scheduled again."
        >
          Cancel
        </AsyncButton>
      )}
      {cancellerRole && (
        <AsyncButton
          variant="danger"
          busyLabel="Cancelling…"
          doneLabel="Cancelled"
          onClick={async () => {
            const hash = await relay(cancellerRole, timelockCalls.cancel(deployment, safe, txHash), cancelLog)
            onChange()
            return hash
          }}
          title={`${cancellerRole.label} is a listed canceller`}
        >
          Cancel as {cancellerRole.label}
        </AsyncButton>
      )}
    </>
  )
}

/** Names and decoded configure changes for the rows, judged against the current attachments. */
function useRowDescribe(model: SafeV2Model) {
  const isAttached = useCallback(
    (id: Hex) => model.attachments.some((a) => a.attachmentId === id),
    [model.attachments],
  )
  return useDescribeContext(isAttached)
}

/** The decoded parts of a transaction (configure changes, batch calls), folded. */
function Lines({ lines, what }: { lines: readonly string[]; what: string }) {
  if (lines.length === 0) return null
  return (
    <details className="queue-lines small">
      <summary>{what}</summary>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </details>
  )
}

/**
 * One owner transaction, from signatures to execution: tracked by this app (proposed or signed
 * here) or found scheduled on-chain. A human title, the timeline, the one next action, then the
 * nonce and Safe transaction hash in small print.
 */
export function OwnerTxRow({
  hash,
  entry,
  tracked,
  engine,
  model,
  currentNonce,
  onChange,
}: {
  hash: Hex
  entry?: QueueEntry
  tracked?: TrackedOwnerTx
  engine: V2Engine
  model: SafeV2Model
  currentNonce?: bigint
  onChange: () => void
}) {
  const { safe, state, getQueuedTx } = useSandbox()
  const { deployment } = engine
  const now = BigInt(useNow())
  const relayer = useRelayer()
  const describeCtx = useRowDescribe(model)
  const threshold = state?.threshold ?? 1
  const fallback = entry
    ? { to: entry.to, value: entry.value, data: entry.data, operation: entry.operation }
    : tracked?.call && { ...tracked.call, operation: Operation.CALL }
  const closedOnChain = entry?.state === 'executed' || entry?.state === 'cancelled' || !!tracked?.executed
  const live = useAsync(
    () => readOwnerRow(deployment, safe, hash, model, threshold, fallback, getQueuedTx),
    `${hash}:${model.attachments.length}:${threshold}:${entry?.state}`,
    // Before a schedule the signatures can still arrive; after, only a live schedule changes.
    (row) =>
      closedOnChain || row?.data?.executed
        ? undefined
        : row?.schedule && row.merged
          ? LIVE_STATUSES.includes(scheduleStatus(row.schedule, row.merged, now).status)
            ? ROW_REFRESH_MS
            : undefined
          : ROW_REFRESH_MS,
  )
  const d = live.data
  const remove = tracked && (
    <ConfirmIconButton
      title="Stop following it here (nothing changes on-chain)"
      onConfirm={() => untrackOwnerTx(safe, hash)}
    />
  )
  if (!d) {
    return (
      <li className="queue-entry">
        <div className="queue-head">
          <strong>{tracked?.label ?? 'Owner transaction'}</strong>
          {live.error !== undefined ? (
            <ErrorLine message={`Could not be read: ${String(live.error)}`} />
          ) : (
            <span className="muted small">loading…</span>
          )}
          <span className="queue-end">{remove}</span>
        </div>
      </li>
    )
  }

  const tx = d.data?.tx
  const call = tx ?? fallback
  const summary = call ? describeCall(call, describeCtx) : undefined
  const title = summary?.title ?? tracked?.label ?? 'Owner transaction'
  const lines = summary?.lines ?? []
  const nonce = tx?.nonce ?? entry?.nonce
  const nonceState =
    nonce !== undefined && currentNonce !== undefined ? ownerNonceState(nonce, currentNonce) : undefined
  const executed = !!d.data?.executed || entry?.state === 'executed' || !!tracked?.executed
  const cancelled = entry?.state === 'cancelled'
  const status = d.schedule && d.merged ? scheduleStatus(d.schedule, d.merged, now) : undefined
  const badGas = !!tx && hasGasFields(tx)
  const signed = !!d.data && d.data.count >= threshold && !d.data.unusable
  const closed = executed || cancelled || nonceState === 'stale'
  const delay = d.merged && d.merged.delay > 0n ? durationLabel(d.merged.delay) : undefined
  const log: RelayLog = { label: title, safeTxHash: hash, nonce, lines }

  const step: OwnerStep = executed
    ? 'done'
    : !d.schedule && !signed
      ? 'sign'
      : !d.schedule
        ? d.route?.route === 'now'
          ? 'execute'
          : 'schedule'
        : status?.status === 'ready'
          ? 'execute'
          : status?.status === 'void' || status?.status === 'expired'
            ? 'schedule'
            : 'wait'

  const schedule = async () => {
    if (!relayer) throw new Error('Add a relayer in Roles first')
    const sent = await relay(
      relayer,
      timelockCalls.schedule(deployment, safe, d.data!.tx, d.data!.signatures),
      { ...log, mode: 'schedule', label: `Schedule: ${title}` },
    )
    settleProposal(hash, 'scheduled')
    onChange()
    return sent
  }

  const execute = async () => {
    if (!relayer) throw new Error('Add a relayer in Roles first')
    const sent = await relay(
      relayer,
      { ...execTransactionCall(safe, d.data!.tx, d.data!.signatures), description: `execute ${title}` },
      { ...log, mode: 'execute' },
    )
    markOwnerTxExecuted(safe, hash)
    settleProposal(hash, 'executed')
    onChange()
    return sent
  }

  const by = relayer ? ` with ${relayer.label}` : ''

  return (
    <li className="queue-entry">
      <div className="queue-head">
        <strong className="queue-title">{title}</strong>
        {executed && <Badge tone="ok">executed</Badge>}
        {!executed && cancelled && <Badge tone="bad">cancelled for good</Badge>}
        {!executed && !cancelled && nonceState === 'stale' && (
          <Badge tone="bad">dead: nonce already used</Badge>
        )}
        {!closed && status && d.merged && (
          <StatusBadge
            status={status}
            frozenUntil={d.merged.frozenUntil}
            isConfiguration={!!d.schedule?.isConfiguration}
          />
        )}
        {!closed && nonceState === 'later' && (
          <Badge tone="warn">after {(nonce! - currentNonce!).toString()} earlier owner transaction(s)</Badge>
        )}
        <span className="queue-end">{remove}</span>
      </div>
      <Lines lines={lines} what={lines.length === 1 ? '1 detail' : `${lines.length} details`} />
      {!closed && <OwnerTxTimeline current={step} delay={delay} />}
      {!closed && (
        <div className="row wrap queue-actions">
          {!d.data && !d.schedule && (
            <span className="muted small">
              Signatures not found{getQueuedTx ? ' in Safe{Wallet}' : ''}: open the app inside Safe
              {'{Wallet}'} to read them.
            </span>
          )}
          {d.data?.unusable && <ErrorLine message={d.data.unusable} />}
          {badGas && (
            <ErrorLine message="safeTxGas or gasPrice is set, which V2 refuses: propose it again." />
          )}
          {step === 'sign' && d.data && !badGas && (
            <span className="small">
              {d.data.count}/{threshold} signatures: sign it in Safe{'{Wallet}'},{' '}
              <strong>do not execute</strong>.
            </span>
          )}
          {step === 'schedule' && signed && !badGas && d.route?.route !== 'denied' && (
            <AsyncButton
              variant="primary"
              disabled={!relayer}
              onClick={schedule}
              busyLabel="Scheduling…"
              doneLabel="Scheduled"
              title={`Sends the signatures to the Timelock${by}`}
            >
              Schedule
            </AsyncButton>
          )}
          {d.route?.route === 'denied' && <ErrorLine message={d.route.reason} />}
          {step === 'wait' && signed && status && (
            <ReadySimulation
              readyAt={status.readyAt}
              simulate={(time) =>
                simulateAtTime(
                  relayer?.address ?? state?.owners[0] ?? safe,
                  execTransactionCall(safe, d.data!.tx, d.data!.signatures),
                  time,
                )
              }
              fallback={() =>
                runPreview(publicClient, deployment, safe, OWNERS, d.data!.tx, {
                  chainId: chain.id,
                  ownerNonce: d.data!.tx.nonce,
                  ctx: describeCtx,
                })
              }
            />
          )}
          {step === 'execute' && signed && !badGas && nonceState === 'next' && (
            <AsyncButton
              variant="primary"
              disabled={!relayer}
              onClick={execute}
              busyLabel="Executing…"
              doneLabel="Executed"
              title={`execTransaction with the owners' signatures${by}`}
            >
              Execute
            </AsyncButton>
          )}
          {step === 'execute' && !signed && d.schedule && (
            <span className="small">Ready: execute it from the Safe{'{Wallet}'} queue.</span>
          )}
          {d.schedule && !executed && (
            <OwnerCancel
              engine={engine}
              model={model}
              txHash={hash}
              attachmentIds={d.schedule.attachmentIds}
              isConfiguration={d.schedule.isConfiguration}
              log={log}
              onChange={onChange}
            />
          )}
        </div>
      )}
      <div className="queue-meta">
        {nonce !== undefined && (
          <span>
            <Term k="nonce">nonce</Term> {nonce.toString()}
          </span>
        )}
        <ShortHash hash={hash} label="Safe tx" />
        {d.data && !executed && (
          <span>
            {d.data.count}/{threshold} signatures
          </span>
        )}
      </div>
    </li>
  )
}

/** An owner transaction under an action (playground, draft): the Queue row, with its own nonce read. */
export function InlineOwnerTx({
  hash,
  tracked,
  engine,
  model,
  onChange,
}: {
  hash: Hex
  tracked?: TrackedOwnerTx
  engine: V2Engine
  model: SafeV2Model
  onChange?: () => void
}) {
  const { safe } = useSandbox()
  const nonce = useSafeNonce(safe)
  return (
    <ul className="plain inline-row">
      <OwnerTxRow
        hash={hash}
        tracked={tracked}
        engine={engine}
        model={model}
        currentNonce={nonce.data}
        onChange={() => {
          nonce.reload()
          onChange?.()
        }}
      />
    </ul>
  )
}

/** What a module schedule row needs: a Timelock queue entry, or the call a role just scheduled. */
export type ModuleEntry = Pick<
  QueueEntry,
  'txHash' | 'actor' | 'to' | 'value' | 'data' | 'operation' | 'isConfiguration'
>

/** A module's own schedule: countdown, execute and cancel as that module when its key is here. */
export function ModuleEntryRow({
  entry,
  engine,
  model,
  ctx,
  onChange,
}: {
  entry: ModuleEntry
  engine: V2Engine
  model: SafeV2Model
  ctx: LabelContext
  onChange: () => void
}) {
  const { safe } = useSandbox()
  const { deployment } = engine
  const now = BigInt(useNow())
  const roles = rolesStore.use()
  const describeCtx = useRowDescribe(model)
  const live = useAsync(
    async () => {
      const [schedule, merged] = await Promise.all([
        readSchedule(publicClient, deployment, safe, entry.txHash),
        readMergedTimelock(deployment, safe, entry.actor, entry, model),
      ])
      return { schedule, merged }
    },
    `${entry.txHash}:${model.attachments.length}`,
    (row) =>
      !row || (row.schedule && LIVE_STATUSES.includes(scheduleStatus(row.schedule, row.merged, now).status))
        ? ROW_REFRESH_MS
        : undefined,
  )
  const data = live.data
  if (!data) return <li className="muted small queue-entry">loading…</li>
  if (!data.schedule) return null
  const { merged } = data
  const status = scheduleStatus(data.schedule, merged, now)
  const scheduledIds = new Set(data.schedule.attachmentIds)
  const cancellers = cancellersOf(
    entry,
    model.attachments
      .filter((a) => scheduledIds.has(a.attachmentId))
      .flatMap((a) => (a.settings?.policy === 'timelock' ? a.settings.settings.cancellers : [])),
  )
  const cancellerRole = roles.find(
    (r) => hasLocalKey(r) && cancellers.some((c) => isAddressEqual(c, r.address)),
  )
  const actorRole = roles.find((r) => isAddressEqual(r.address, entry.actor))
  const actor = actorLabel(entry.actor, ctx.nameOf)
  const summary = describeCall(entry, describeCtx)
  const title = `${actor}: ${summary.title}`
  const step: OwnerStep =
    status.status === 'ready' ? 'execute' : status.status === 'waiting' ? 'wait' : 'schedule'
  const call = { to: entry.to, value: entry.value, data: entry.data, operation: entry.operation }
  const cancelAs = (role: Role) => async () => {
    const hash = await relay(role, timelockCalls.cancel(deployment, safe, entry.txHash), {
      mode: 'cancel',
      label: `Cancel: ${title}`,
      lines: summary.lines,
    })
    onChange()
    return hash
  }

  return (
    <li className="queue-entry">
      <div className="queue-head">
        <strong className="queue-title">{title}</strong>
        <StatusBadge
          status={status}
          frozenUntil={merged.frozenUntil}
          isConfiguration={entry.isConfiguration}
        />
      </div>
      <Lines lines={summary.lines} what={`${summary.lines.length} details`} />
      <OwnerTxTimeline module current={step} delay={durationLabel(merged.delay)} />
      <div className="row wrap queue-actions">
        {actorRole && status.status === 'ready' && (
          <AsyncButton
            variant="primary"
            busyLabel="Executing…"
            doneLabel="Executed"
            onClick={async () => {
              const ok = await runSteps(safe, actorRole, [{ label: summary.title, tx: call }], 'execute')
              onChange()
              if (!ok) throw new Error('Refused or reverted: see Activity')
            }}
            title={`Executes the scheduled call as ${actorRole.label}`}
          >
            Execute as {actorRole.label}
          </AsyncButton>
        )}
        {status.status === 'waiting' && (
          <ReadySimulation
            readyAt={status.readyAt}
            simulate={(time) =>
              simulateAtTime(
                entry.actor,
                {
                  to: safe,
                  data: encodeFunctionData({
                    abi: safeAbi,
                    functionName: 'execTransactionFromModule',
                    args: [entry.to, entry.value, entry.data, entry.operation],
                  }),
                },
                time,
              )
            }
            fallback={() =>
              runPreview(publicClient, deployment, safe, entry.actor as Address, call, {
                chainId: chain.id,
                ctx: describeCtx,
              })
            }
          />
        )}
        {actorRole && roleKind(actorRole) === 'eoa' && (
          <AsyncButton
            variant="danger"
            busyLabel="Cancelling…"
            doneLabel="Cancelled"
            onClick={cancelAs(actorRole)}
            title={`${actorRole.label} scheduled it, so it may cancel it`}
          >
            Cancel as {actorRole.label}
          </AsyncButton>
        )}
        {cancellerRole && (
          <AsyncButton
            variant="danger"
            busyLabel="Cancelling…"
            doneLabel="Cancelled"
            onClick={cancelAs(cancellerRole)}
            title={`${cancellerRole.label} is a listed canceller`}
          >
            Cancel as {cancellerRole.label}
          </AsyncButton>
        )}
      </div>
      <div className="queue-meta">
        <span>
          <Term k="timelock">delay</Term> {durationLabel(merged.delay)}
          {merged.window > 0n && `, window ${durationLabel(merged.window)}`}
        </span>
        <ShortHash hash={entry.txHash} label="call" />
      </div>
    </li>
  )
}
