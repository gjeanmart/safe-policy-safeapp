import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { type Address, type Hex, encodeFunctionData, isAddressEqual } from 'viem'
import { safeAbi } from '../../abi'
import { chain, publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { describeCall } from '../../lib/describeTx'
import { formatAgo, formatClock, formatDuration, formatTime, shortAddress } from '../../lib/format'
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
  noteOwnerTx,
  roleKind,
  rolesStore,
  settleProposal,
  untrackOwnerTx,
} from '../../store'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { Term } from '../Term'
import { BotIcon, UsersIcon } from '../icons'
import { AsyncButton, ErrorLine, ShortHash } from '../ui'
import { useDescribeContext } from '../useDescribe'
import { PreviewView } from './GatePreview'
import { type AuditEvent, AuditLog } from './OwnerTxTimeline'
import {
  type OwnerRowData,
  type TimedSimulation,
  hasGasFields,
  readMergedTimelock,
  readOwnerRow,
  simulateAtTime,
} from './ownerTx'
import { type RelayLog, relay, useRelayer } from './relayer'
import { type ChipTone, QueueItem } from './QueueItem'
import { useSafeNonce } from './useQueueData'
import { useLabelContext } from './useV2'

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

/** The decoded call: its title, each change or batch call, then identifiers in small print. */
function CallDetails({ title, lines, meta }: { title: string; lines: readonly string[]; meta: ReactNode }) {
  return (
    <>
      <strong>{title}</strong>
      {lines.length > 0 && (
        <ul className="queue-lines small">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <div className="queue-meta">{meta}</div>
    </>
  )
}

/** Who sent a transaction: for a schedule, the relayer (owners) or the module itself. */
function useSender(tx?: Hex) {
  return useAsync(
    async () => (tx ? (await publicClient.getTransaction({ hash: tx })).from : undefined),
    tx ?? 'none',
  ).data
}

const at = (seconds: bigint) => formatTime(Number(seconds) * 1000)

/** Scheduled / ready / executed lines of the audit log, shared by owner and module schedules. */
function scheduleEvents({
  schedule,
  status,
  scheduledBy,
  executed,
  now,
}: {
  schedule?: { scheduledAt: bigint }
  status?: { status: ScheduleStatus; readyAt: bigint; expiresAt?: bigint }
  scheduledBy?: string
  executed: boolean
  now: bigint
}): AuditEvent[] {
  const s = status?.status
  const lapsed = s === 'void' || s === 'expired'
  return [
    {
      key: 'scheduled',
      label: lapsed ? (s === 'void' ? 'Void after a freeze' : 'Expired') : 'Scheduled',
      detail: schedule
        ? `${scheduledBy ? `by ${scheduledBy} · ` : ''}${at(schedule.scheduledAt)}${lapsed ? ' · schedule it again' : ''}`
        : undefined,
      state: lapsed ? 'bad' : schedule ? 'done' : 'current',
    },
    {
      key: 'ready',
      label:
        status && s !== 'ready' && !executed && !lapsed
          ? s === 'frozen'
            ? 'Frozen'
            : `Ready in ${formatDuration(status.readyAt - now)}`
          : 'Ready',
      detail: status
        ? `${at(status.readyAt)}${status.expiresAt !== undefined ? ` · expires ${formatClock(status.expiresAt)}` : ''}`
        : undefined,
      state:
        executed || s === 'ready' ? 'done' : s === 'frozen' ? 'bad' : s === 'waiting' ? 'current' : 'todo',
    },
    {
      key: 'executed',
      label: 'Executed',
      state: executed ? 'done' : s === 'ready' ? 'current' : 'todo',
    },
  ]
}

/** What one owner row knows, derived the same way for the store note and the render. */
function ownerFacts(
  d: OwnerRowData | undefined,
  entry: QueueEntry | undefined,
  tracked: TrackedOwnerTx | undefined,
  currentNonce: bigint | undefined,
) {
  const nonce = d?.data?.tx.nonce ?? entry?.nonce ?? tracked?.nonce
  const nonceState =
    nonce !== undefined && currentNonce !== undefined ? ownerNonceState(nonce, currentNonce) : undefined
  const executed = !!d?.data?.executed || entry?.state === 'executed' || !!tracked?.executed
  const cancelled = !executed && entry?.state === 'cancelled'
  const closed: TrackedOwnerTx['closed'] = executed
    ? 'executed'
    : cancelled
      ? 'cancelled'
      : nonceState === 'stale'
        ? 'replaced'
        : undefined
  return { nonce, nonceState, executed, cancelled, closed }
}

/** The owners' audit log: proposed, signed, scheduled (by whom), ready, executed. */
function OwnerLog({
  d,
  tracked,
  threshold,
  status,
  scheduledTx,
  executed,
  closed,
  nameOf,
}: {
  d: OwnerRowData
  tracked?: TrackedOwnerTx
  threshold: number
  status?: { status: ScheduleStatus; readyAt: bigint; expiresAt?: bigint }
  scheduledTx?: Hex
  executed: boolean
  closed?: TrackedOwnerTx['closed']
  nameOf: (a: Address) => string
}) {
  const now = BigInt(useNow())
  const sender = useSender(scheduledTx)
  const data = d.data
  const signed = !!data && data.count >= threshold
  const proposedAt = data?.proposedAt ?? tracked?.addedAt
  const events: AuditEvent[] = [
    {
      key: 'created',
      label: data?.proposer ? `Proposed by ${nameOf(data.proposer)}` : tracked ? 'Created here' : 'Created',
      detail: proposedAt ? formatTime(proposedAt) : undefined,
      state: 'done',
    },
    {
      key: 'signed',
      label: data ? `Signed (${data.count}/${threshold})` : 'Signed',
      detail: data?.signers?.length
        ? data.signers.map((s) => nameOf(s.signer)).join(', ')
        : !data
          ? 'Signatures not readable here'
          : undefined,
      // A schedule or an execution needed the signatures, even when they cannot be read here.
      state: signed || executed || d.schedule ? 'done' : 'current',
    },
    ...(d.route?.route === 'now' && !d.schedule
      ? [
          { key: 'now', label: 'No delay needed', state: 'done' as const },
          { key: 'executed', label: 'Executed', state: executed ? ('done' as const) : ('current' as const) },
        ]
      : scheduleEvents({
          schedule: d.schedule,
          status,
          scheduledBy: sender && nameOf(sender),
          executed,
          now,
        }).map((e) =>
          e.key === 'scheduled' && !signed && !d.schedule ? { ...e, state: 'todo' as const } : e,
        )),
  ]
  if (closed === 'cancelled') events.push({ key: 'closed', label: 'Cancelled for good', state: 'bad' })
  if (closed === 'replaced')
    events.push({ key: 'closed', label: 'Nonce used by another transaction', state: 'bad' })
  return <AuditLog events={events} />
}

/**
 * One owner transaction, from signatures to execution: tracked by this app (proposed or signed
 * here) or found scheduled on-chain. One line (nonce, title, time, signatures, status, next
 * action), expanding to the decoded call and the audit log.
 */
export function OwnerTxRow({
  hash,
  entry,
  tracked,
  engine,
  model,
  currentNonce,
  onChange,
  showNonce = true,
}: {
  hash: Hex
  entry?: QueueEntry
  tracked?: TrackedOwnerTx
  engine: V2Engine
  model: SafeV2Model
  currentNonce?: bigint
  onChange: () => void
  showNonce?: boolean
}) {
  const { safe, state, getQueuedTx } = useSandbox()
  const { deployment } = engine
  const now = BigInt(useNow())
  const relayer = useRelayer()
  const describeCtx = useRowDescribe(model)
  const ctx = useLabelContext(engine)
  const nameOf = (a: Address) => ctx.nameOf?.(a) ?? shortAddress(a)
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
  const facts = ownerFacts(d, entry, tracked, currentNonce)
  const isTracked = !!tracked
  // Remember the nonce and the outcome, so the Queue groups and closes it before rows load.
  useEffect(() => {
    if (isTracked && facts.nonce !== undefined)
      noteOwnerTx(safe, hash, { nonce: facts.nonce, closed: facts.closed })
  }, [isTracked, safe, hash, facts.nonce, facts.closed])

  const remove = tracked && (
    <ConfirmIconButton
      title="Stop following it here (nothing changes on-chain)"
      onConfirm={() => untrackOwnerTx(safe, hash)}
    />
  )
  const nonceCell = showNonce ? facts.nonce?.toString() : undefined
  if (!d) {
    return (
      <QueueItem
        nonce={nonceCell}
        icon={<UsersIcon />}
        title={tracked?.label ?? 'Owner transaction'}
        status={
          live.error !== undefined
            ? { tone: 'bad', label: 'Could not be read' }
            : { tone: 'neutral', label: 'Loading…' }
        }
        call={
          <>
            {live.error !== undefined && <ErrorLine message={String(live.error)} />}
            <div className="queue-meta">
              <ShortHash hash={hash} label="Safe tx" />
              {remove}
            </div>
          </>
        }
        log={null}
      />
    )
  }

  const { nonce, nonceState, executed, cancelled, closed } = facts
  const tx = d.data?.tx
  const call = tx ?? fallback
  const summary = call ? describeCall(call, describeCtx) : undefined
  const title = summary?.title ?? tracked?.label ?? 'Owner transaction'
  const lines = summary?.lines ?? []
  const status = d.schedule && d.merged ? scheduleStatus(d.schedule, d.merged, now) : undefined
  const badGas = !!tx && hasGasFields(tx)
  const signed = !!d.data && d.data.count >= threshold && !d.data.unusable
  const delay = d.merged && d.merged.delay > 0n ? durationLabel(d.merged.delay) : undefined
  const log: RelayLog = { label: title, safeTxHash: hash, nonce, lines }
  const proposedAt =
    d.data?.proposedAt ?? tracked?.addedAt ?? (d.schedule && Number(d.schedule.scheduledAt) * 1000)

  const step: 'sign' | 'schedule' | 'wait' | 'execute' | 'done' = executed
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

  const by = relayer ? ` with ${relayer.label}` : ' (add a relayer in Roles first)'
  const blocked = badGas || !!d.data?.unusable || d.route?.route === 'denied'
  const chip: { tone: ChipTone; label: string } = executed
    ? { tone: 'ok', label: 'Executed' }
    : cancelled
      ? { tone: 'bad', label: 'Cancelled' }
      : closed === 'replaced'
        ? { tone: 'bad', label: 'Replaced' }
        : blocked
          ? { tone: 'bad', label: 'Cannot run' }
          : step === 'sign'
            ? { tone: 'warn', label: 'Needs signatures' }
            : step === 'schedule'
              ? status
                ? { tone: 'bad', label: status.status === 'void' ? 'Void' : 'Expired' }
                : { tone: 'warn', label: 'Needs scheduling' }
              : step === 'wait'
                ? status?.status === 'frozen'
                  ? { tone: 'bad', label: 'Frozen' }
                  : { tone: 'neutral', label: 'Waiting' }
                : nonceState === 'later'
                  ? { tone: 'neutral', label: `After nonce ${currentNonce}` }
                  : { tone: 'ok', label: 'Ready' }

  const action =
    closed || blocked ? undefined : step === 'schedule' && signed ? (
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
    ) : step === 'wait' && status?.status === 'waiting' ? (
      <span className="qi-countdown small">in {formatDuration(status.readyAt - now)}</span>
    ) : step === 'execute' && signed && nonceState === 'next' ? (
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
    ) : step === 'execute' && !signed && d.schedule ? (
      // Only when the signatures cannot be read here (standalone): the app cannot send it itself.
      <span className="small">Execute it in Safe{'{Wallet}'}</span>
    ) : undefined

  const more = !closed && (
    <>
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
    </>
  )

  return (
    <QueueItem
      nonce={nonceCell}
      icon={<UsersIcon />}
      title={title}
      time={proposedAt ? formatAgo(proposedAt, Number(now) * 1000) : undefined}
      signatures={d.data && !executed ? { count: d.data.count, threshold } : undefined}
      status={chip}
      action={action}
      more={more}
      call={
        <>
          <CallDetails
            title={title}
            lines={lines}
            meta={
              <>
                {nonce !== undefined && (
                  <span>
                    <Term k="nonce">nonce</Term> {nonce.toString()}
                  </span>
                )}
                <ShortHash hash={hash} label="Safe tx" />
                {delay && (
                  <span>
                    <Term k="timelock">delay</Term> {delay}
                  </span>
                )}
                {remove}
              </>
            }
          />
          {!d.data && !d.schedule && (
            <p className="muted small">
              Signatures not found{getQueuedTx ? ' in Safe{Wallet}' : ''}: open the app inside Safe
              {'{Wallet}'} to read them.
            </p>
          )}
          {step === 'sign' && d.data && !blocked && (
            <p className="small">
              Sign it in Safe{'{Wallet}'}, <strong>do not execute</strong>: the relayer schedules it.
            </p>
          )}
          {d.data?.unusable && <ErrorLine message={d.data.unusable} />}
          {badGas && (
            <ErrorLine message="safeTxGas or gasPrice is set, which V2 refuses: propose it again." />
          )}
          {d.route?.route === 'denied' && <ErrorLine message={d.route.reason} />}
        </>
      }
      log={
        <OwnerLog
          d={d}
          tracked={tracked}
          threshold={threshold}
          status={status}
          scheduledTx={entry?.scheduledTx}
          executed={executed}
          closed={closed}
          nameOf={nameOf}
        />
      }
    />
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
> & { scheduledTx?: Hex }

/** The module's audit log: scheduled (by the module), ready, executed. */
function ModuleLog({
  schedule,
  status,
  actor,
}: {
  schedule: { scheduledAt: bigint }
  status: { status: ScheduleStatus; readyAt: bigint; expiresAt?: bigint }
  actor: string
}) {
  const now = BigInt(useNow())
  return <AuditLog events={scheduleEvents({ schedule, status, scheduledBy: actor, executed: false, now })} />
}

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
  const actor = actorLabel(entry.actor, ctx.nameOf)
  const summary = describeCall(entry, describeCtx)
  const title = `${actor}: ${summary.title}`
  if (!data)
    return (
      <QueueItem
        icon={<BotIcon />}
        title={title}
        status={{ tone: 'neutral', label: 'Loading…' }}
        call={<CallDetails title={title} lines={summary.lines} meta={null} />}
        log={null}
      />
    )
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
  const chip: { tone: ChipTone; label: string } =
    status.status === 'ready'
      ? { tone: 'ok', label: 'Ready' }
      : status.status === 'waiting'
        ? { tone: 'neutral', label: 'Waiting' }
        : {
            tone: 'bad',
            label: status.status === 'frozen' ? 'Frozen' : status.status === 'void' ? 'Void' : 'Expired',
          }

  const action =
    status.status === 'ready' && actorRole ? (
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
        Execute
      </AsyncButton>
    ) : status.status === 'waiting' ? (
      <span className="qi-countdown small">in {formatDuration(status.readyAt - now)}</span>
    ) : undefined

  return (
    <QueueItem
      icon={<BotIcon />}
      title={title}
      time={formatAgo(Number(data.schedule.scheduledAt) * 1000, Number(now) * 1000)}
      status={chip}
      action={action}
      more={
        <>
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
        </>
      }
      call={
        <>
          <CallDetails
            title={summary.title}
            lines={summary.lines}
            meta={
              <>
                <span>
                  <Term k="timelock">delay</Term> {durationLabel(merged.delay)}
                  {merged.window > 0n && `, window ${durationLabel(merged.window)}`}
                </span>
                <ShortHash hash={entry.txHash} label="call" />
              </>
            }
          />
          {status.status === 'ready' && !actorRole && (
            <p className="muted small">Ready: {actor} executes it itself (its key is not in this browser).</p>
          )}
        </>
      }
      log={<ModuleLog schedule={data.schedule} status={status} actor={actor} />}
    />
  )
}
