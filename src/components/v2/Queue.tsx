import { useState } from 'react'
import { type Address, type Hex, isAddressEqual, parseEther } from 'viem'
import { chain, publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { formatDuration, formatTime, shortAddress } from '../../lib/format'
import { execTransactionCall, signHashAsRole } from '../../lib/roleExec'
import { runSteps } from '../../lib/runner'
import {
  type Attachment,
  type LabelContext,
  OWNERS,
  Operation,
  type QueueEntry,
  type SafeV2Model,
  type ScheduleStatus,
  actorLabel,
  callPhrase,
  cancelOutcome,
  cancellersOf,
  durationLabel,
  freezePhase,
  isOwnerEntry,
  listLabel,
  ownerNonceState,
  readCancelDigest,
  readSafeNonce,
  readSchedule,
  readTimelockLogs,
  runPreview,
  safeTransaction,
  safeTxHash,
  scheduleStatus,
  selectorName,
  sortOwnerSignatures,
  timelockCalls,
} from '../../lib/v2'
import { parseAddressInput, parseHexInput } from '../../lib/validation'
import {
  type Role,
  type TrackedOwnerTx,
  hasLocalKey,
  markOwnerTxExecuted,
  roleKind,
  rolesStore,
  trackOwnerTx,
  untrackOwnerTx,
  v2OwnerTxStore,
  v2TrackedStore,
} from '../../store'
import { InfoTip } from '../Tooltip'
import { AddressView, AsyncButton, Badge, Card, CopyButton, Field, Notice } from '../ui'
import { FreezeBadge } from './OrgChart'
import { type OwnerStep, OwnerTxTimeline } from './OwnerTxTimeline'
import { hasGasFields, readMergedTimelock, readOwnerRow } from './ownerTx'
import { RelayerBar, relay, useRelayer } from './relayer'

const QUEUE_REFRESH_MS = 30_000
const ROW_REFRESH_MS = 15_000
const NONCE_REFRESH_MS = 10_000
/** Without a known deployment block, scan roughly the last three weeks of Sepolia. */
const DEFAULT_LOOKBACK = 150_000n
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

/** Owners local to this browser: EOA roles that are owners of the Safe. */
export function useLocalOwners(): Role[] {
  const { state } = useSandbox()
  return rolesStore
    .use()
    .filter((r) => roleKind(r) === 'eoa' && (state?.owners ?? []).some((o) => isAddressEqual(o, r.address)))
}

const STATUS_TEXT = {
  frozen: 'frozen',
  void: 'void (scheduled before a freeze ended): schedule again',
  expired: 'expired: schedule again',
} as const

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
  if (status.status === 'waiting')
    return (
      <Badge tone="warn">
        ready in {formatDuration(status.readyAt - now)} ({formatTime(Number(status.readyAt) * 1000)})
      </Badge>
    )
  if (status.status === 'ready')
    return (
      <Badge tone="ok">
        ready{status.expiresAt !== undefined && ` · expires in ${formatDuration(status.expiresAt - now)}`}
      </Badge>
    )
  if (status.status === 'frozen')
    return (
      <Badge tone="bad">
        frozen until {formatTime(Number(frozenUntil) * 1000)}
        {!isConfiguration && ': then void'}
      </Badge>
    )
  return <Badge tone="bad">{STATUS_TEXT[status.status]}</Badge>
}

/** Cancel buttons a local key can press: the owners (threshold local signer keys) or a listed canceller. */
function OwnerCancel({
  engine,
  model,
  txHash,
  attachmentIds,
  isConfiguration,
  onChange,
}: {
  engine: V2Engine
  model: SafeV2Model
  txHash: Hex
  attachmentIds: readonly Hex[]
  isConfiguration: boolean
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

  const cancelAsOwners = async () => {
    if (!relayer) throw new Error('Add a relayer in Roles first')
    const digest = await readCancelDigest(publicClient, deployment, safe, txHash)
    const sigs = []
    for (const s of localOwners.slice(0, threshold)) sigs.push(await signHashAsRole(s, digest))
    await relay(relayer, timelockCalls.cancelAsOwners(deployment, safe, txHash, sortOwnerSignatures(sigs)))
    onChange()
  }

  return (
    <>
      {localOwners.length >= threshold ? (
        <AsyncButton
          variant="danger"
          disabled={!relayer}
          onClick={cancelAsOwners}
          title="Owner signatures over the Timelock's cancel digest, from local signer keys. Final: this signed transaction can never be scheduled again."
        >
          Cancel for good as owners
        </AsyncButton>
      ) : (
        !cancellerRole && (
          <span className="muted small">
            To cancel: {threshold} local signer key{threshold === 1 ? '' : 's'} or a canceller key.
          </span>
        )
      )}
      {cancellerRole && (
        <AsyncButton
          variant="danger"
          onClick={async () => {
            await relay(cancellerRole, timelockCalls.cancel(deployment, safe, txHash))
            onChange()
          }}
          title={`${cancellerRole.label} is a listed canceller`}
        >
          Cancel as {cancellerRole.label}
        </AsyncButton>
      )}
    </>
  )
}

/**
 * One owner transaction, from signatures to execution: tracked by this app (proposed here or
 * added by hash) or found scheduled on-chain. Shows one next action for its state.
 */
function OwnerTxRow({
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
  const threshold = state?.threshold ?? 1
  const fallback = entry && { to: entry.to, value: entry.value, data: entry.data, operation: entry.operation }
  const live = useAsync(
    () => readOwnerRow(deployment, safe, hash, model, threshold, fallback, getQueuedTx),
    `${hash}:${model.attachments.length}:${threshold}:${entry?.state}`,
    ROW_REFRESH_MS,
  )
  const d = live.data
  if (!d) {
    return (
      <li className="muted small">
        {tracked?.label ?? `${hash.slice(0, 18)}…`}{' '}
        {live.error !== undefined ? `could not be read: ${String(live.error)}` : 'loading…'}
      </li>
    )
  }

  const tx = d.data?.tx
  const call = tx ?? fallback
  const nonce = tx?.nonce ?? entry?.nonce
  const nonceState =
    nonce !== undefined && currentNonce !== undefined ? ownerNonceState(nonce, currentNonce) : undefined
  const executed = !!d.data?.executed || entry?.state === 'executed' || !!tracked?.executed
  const cancelled = entry?.state === 'cancelled'
  const status = d.schedule && d.merged ? scheduleStatus(d.schedule, d.merged, now) : undefined
  const badGas = !!tx && hasGasFields(tx)
  const signed = !!d.data && d.data.count >= threshold && !d.data.unusable
  const closed = executed || cancelled || nonceState === 'stale'
  const fn = call ? (selectorName(call.data.slice(0, 10) as Hex) ?? call.data.slice(0, 10)) : undefined
  const delay = d.merged && d.merged.delay > 0n ? durationLabel(d.merged.delay) : undefined

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
    await relay(relayer, timelockCalls.schedule(deployment, safe, d.data!.tx, d.data!.signatures))
    onChange()
  }

  const execute = async () => {
    if (!relayer) throw new Error('Add a relayer in Roles first')
    await relay(relayer, {
      ...execTransactionCall(safe, d.data!.tx, d.data!.signatures),
      description: `execute owner transaction #${nonce}`,
    })
    markOwnerTxExecuted(safe, hash)
    onChange()
  }

  const canExecute = signed && !badGas && nonceState === 'next'
  const executeButton = (
    <AsyncButton
      variant="primary"
      disabled={!relayer}
      onClick={execute}
      title="execTransaction with the owners' signatures"
    >
      Execute{relayer ? ` with ${relayer.label}` : ''}
    </AsyncButton>
  )

  return (
    <li className="queue-entry stack">
      <div className="row wrap">
        <strong>{tracked?.label ?? 'Owners'}</strong>
        {call && (
          <span>
            {entry?.isConfiguration ? <Badge tone="warn">configuration change</Badge> : null} {fn} on{' '}
            <AddressView address={call.to} />
            {call.value > 0n && ` · ${call.value} wei`}
            {call.operation === Operation.DELEGATECALL && ' · DELEGATECALL'}
          </span>
        )}
        {nonce !== undefined && <Badge>nonce {nonce.toString()}</Badge>}
        {executed && <Badge tone="ok">executed</Badge>}
        {!executed && cancelled && <Badge tone="bad">cancelled for good</Badge>}
        {!executed && !cancelled && nonceState === 'stale' && (
          <Badge tone="bad">dead: nonce {nonce!.toString()} already used</Badge>
        )}
        {!closed && status && d.merged && (
          <StatusBadge
            status={status}
            frozenUntil={d.merged.frozenUntil}
            isConfiguration={!!d.schedule?.isConfiguration}
          />
        )}
        {!closed && nonceState === 'later' && (
          <Badge tone="warn">
            {(nonce! - currentNonce!).toString()} owner transaction(s) must execute first
          </Badge>
        )}
        {tracked && (
          <button
            type="button"
            className="link small"
            onClick={() => untrackOwnerTx(safe, hash)}
            title="Stop following it here (nothing changes on-chain)"
          >
            remove
          </button>
        )}
      </div>
      {!closed && <OwnerTxTimeline current={step} delay={delay} />}
      <div className="muted small mono">{hash}</div>
      {!closed && (
        <div className="row wrap align-end small">
          {!d.data && !d.schedule && (
            <span>
              Not found{getQueuedTx ? ' in Safe{Wallet}' : ''}: open the app inside Safe{'{Wallet}'} to read
              its signatures.
            </span>
          )}
          {d.data?.unusable && <Badge tone="bad">{d.data.unusable}</Badge>}
          {badGas && (
            <Badge tone="bad">
              safeTxGas {tx!.safeTxGas.toString()} / gasPrice {tx!.gasPrice.toString()}: V2 refuses them,
              propose it again
            </Badge>
          )}
          {step === 'sign' && d.data && !badGas && (
            <span>
              {d.data.count}/{threshold} signatures: sign it in Safe{'{Wallet}'}, do not execute.
            </span>
          )}
          {step === 'schedule' && signed && !badGas && d.route?.route !== 'denied' && (
            <AsyncButton variant="primary" disabled={!relayer} onClick={schedule}>
              Schedule{relayer ? ` with ${relayer.label}` : ''}
            </AsyncButton>
          )}
          {d.route?.route === 'denied' && <span className="error-text">{d.route.reason}</span>}
          {step === 'execute' && canExecute && executeButton}
          {step === 'execute' && !signed && d.schedule && (
            <span>
              Ready: execute it from the Safe{'{Wallet}'} queue (nonce {nonce?.toString()}).
            </span>
          )}
          {d.schedule && !executed && (
            <OwnerCancel
              engine={engine}
              model={model}
              txHash={hash}
              attachmentIds={d.schedule.attachmentIds}
              isConfiguration={d.schedule.isConfiguration}
              onChange={onChange}
            />
          )}
        </div>
      )}
    </li>
  )
}

/** A module's own schedule: countdown, execute and cancel as that module when its key is here. */
function ModuleEntryRow({
  entry,
  engine,
  model,
  ctx,
  onChange,
}: {
  entry: QueueEntry
  engine: V2Engine
  model: SafeV2Model
  ctx: LabelContext
  onChange: () => void
}) {
  const { safe } = useSandbox()
  const { deployment } = engine
  const now = BigInt(useNow())
  const roles = rolesStore.use()
  const live = useAsync(
    async () => {
      const [schedule, merged] = await Promise.all([
        readSchedule(publicClient, deployment, safe, entry.txHash),
        readMergedTimelock(deployment, safe, entry.actor, entry, model),
      ])
      return { schedule, merged }
    },
    `${entry.txHash}:${model.attachments.length}`,
    ROW_REFRESH_MS,
  )
  const data = live.data
  if (!data) return <li className="muted small">{entry.txHash.slice(0, 18)}… loading</li>
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
  const fn = selectorName(entry.data.slice(0, 10) as Hex) ?? entry.data.slice(0, 10)

  return (
    <li className="queue-entry">
      <div className="row wrap">
        <strong>{actorLabel(entry.actor, ctx.nameOf)}</strong>
        <span>
          {fn} on <AddressView address={entry.to} />
          {entry.value > 0n && ` · ${entry.value} wei`}
          {entry.operation === Operation.DELEGATECALL && ' · DELEGATECALL'}
        </span>
        <StatusBadge
          status={status}
          frozenUntil={merged.frozenUntil}
          isConfiguration={entry.isConfiguration}
        />
      </div>
      <div className="muted small">
        {entry.txHash} · delay {durationLabel(merged.delay)}
        {merged.window > 0n && `, window ${durationLabel(merged.window)}`} · cancellable by{' '}
        {actorLabel(entry.actor, ctx.nameOf)} itself
        {cancellers.length > 0 && `, ${listLabel(cancellers, ctx)}`}
      </div>
      <div className="row wrap align-end">
        {actorRole && status.status === 'ready' && (
          <AsyncButton
            variant="primary"
            onClick={async () => {
              await runSteps(
                safe,
                actorRole,
                [
                  {
                    label: `${fn} (scheduled)`,
                    tx: { to: entry.to, value: entry.value, data: entry.data, operation: entry.operation },
                  },
                ],
                'execute',
              )
              onChange()
            }}
            title={`Executes the scheduled call as ${actorRole.label}`}
          >
            Execute as {actorRole.label}
          </AsyncButton>
        )}
        {actorRole && roleKind(actorRole) === 'eoa' && (
          <AsyncButton
            variant="danger"
            onClick={async () => {
              await relay(actorRole, timelockCalls.cancel(deployment, safe, entry.txHash))
              onChange()
            }}
            title={`${actorRole.label} scheduled it, so it may cancel it`}
          >
            Cancel as {actorRole.label}
          </AsyncButton>
        )}
        {cancellerRole && (
          <AsyncButton
            variant="danger"
            onClick={async () => {
              await relay(cancellerRole, timelockCalls.cancel(deployment, safe, entry.txHash))
              onChange()
            }}
            title={`${cancellerRole.label} is a listed canceller`}
          >
            Cancel as {cancellerRole.label}
          </AsyncButton>
        )}
      </div>
    </li>
  )
}

/**
 * For power users: any owner transaction signed here by local signer keys at a chosen nonce, then
 * scheduled by the relayer. It is tracked like the others.
 */
export function ScheduleOwnerTx({
  engine,
  currentNonce,
  onScheduled,
}: {
  engine: V2Engine
  currentNonce?: bigint
  onScheduled: () => void
}) {
  const { safe, state } = useSandbox()
  const { deployment } = engine
  const relayer = useRelayer()
  const localOwners = useLocalOwners()
  const threshold = state?.threshold ?? 1
  const [to, setTo] = useState('')
  const [value, setValue] = useState('0')
  const [data, setData] = useState('0x')
  const [nonceOffset, setNonceOffset] = useState(0)
  const [gates, setGates] = useState<{ key: string; text: string; ok: boolean }>()
  const target = parseAddressInput(to, 'target')
  const calldata = parseHexInput(data)
  const nonce = currentNonce === undefined ? undefined : currentNonce + BigInt(nonceOffset)
  const previewKey = `${to}:${value}:${data}:${nonce}`
  const ready = target.ok && calldata.ok && nonce !== undefined

  const txAtNonce = () => {
    if (!target.ok || !calldata.ok || nonce === undefined) throw new Error('Fill in the call first')
    return safeTransaction(
      { to: target.value, value: parseEther(value || '0'), data: calldata.value, operation: Operation.CALL },
      nonce,
    )
  }

  const previewAtNonce = async () => {
    const r = await runPreview(publicClient, deployment, safe, OWNERS, txAtNonce(), {
      chainId: chain.id,
      ownerNonce: nonce,
    })
    setGates({
      key: previewKey,
      ok: r.ok && r.outcome.allowed,
      text: !r.ok
        ? `Preview failed: ${r.reason}`
        : r.outcome.allowed
          ? `Allowed at nonce ${nonce}`
          : `At nonce ${nonce}: ${r.outcome.deciding?.reasonText ?? 'denied'}`,
    })
  }

  const signAndSchedule = async () => {
    if (!relayer) throw new Error('Add a relayer in Roles first')
    if (localOwners.length < threshold) throw new Error(`Needs ${threshold} local signer key(s)`)
    const tx = txAtNonce()
    const hash = safeTxHash(chain.id, safe, tx)
    const sigs = []
    for (const o of localOwners.slice(0, threshold)) sigs.push(await signHashAsRole(o, hash))
    const signatures = sortOwnerSignatures(sigs)
    v2OwnerTxStore.set((all) => ({
      ...all,
      [hash.toLowerCase()]: { safe, engine: deployment.engine, tx, signatures },
    }))
    trackOwnerTx(safe, hash, 'Custom owner transaction')
    await relay(relayer, timelockCalls.schedule(deployment, safe, tx, signatures))
    onScheduled()
  }

  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="To">
          <input
            className="mono"
            value={to}
            onChange={(e) => setTo(e.target.value.trim())}
            placeholder="0x…"
          />
        </Field>
        <Field label="Value (ETH)">
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Calldata">
          <input className="mono" value={data} onChange={(e) => setData(e.target.value.trim())} />
        </Field>
        <Field
          label={`Nonce (current ${currentNonce ?? '…'})`}
          info="The signatures are bound to one Safe nonce. If another owner transaction executes first, it takes that nonce and this one can never execute: pick a later nonce to leave room."
        >
          <select value={nonceOffset} onChange={(e) => setNonceOffset(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((k) => (
              <option key={k} value={k}>
                {currentNonce === undefined ? `+${k}` : (currentNonce + BigInt(k)).toString()}
                {k === 0 ? ' (next)' : ` (${k} before it)`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row wrap align-end">
        <AsyncButton
          variant="primary"
          disabled={!ready || !relayer || localOwners.length < threshold}
          onClick={signAndSchedule}
          title={`Signs with ${threshold} local signer key(s), then the relayer schedules it`}
        >
          Sign here &amp; schedule
        </AsyncButton>
        <AsyncButton disabled={!ready} onClick={previewAtNonce}>
          Preview at this nonce
        </AsyncButton>
        {localOwners.length < threshold && (
          <span className="muted small">
            {localOwners.length}/{threshold} local signer keys: propose it in Safe{'{Wallet}'} and add it by
            hash instead.
          </span>
        )}
      </div>
      {gates?.key === previewKey && (
        <span className={gates.ok ? 'small' : 'small error-text'}>{gates.text}</span>
      )}
    </div>
  )
}

/** Follows an owner transaction proposed outside this app, by its Safe transaction hash. */
function TrackByHash() {
  const { safe } = useSandbox()
  const [hash, setHash] = useState('')
  const valid = HASH_PATTERN.test(hash)
  return (
    <form
      className="row wrap align-end"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        trackOwnerTx(safe, hash as Hex)
        setHash('')
      }}
    >
      <Field label="Add an owner transaction by its Safe transaction hash">
        <input
          className="mono"
          value={hash}
          onChange={(e) => setHash(e.target.value.trim())}
          placeholder="0x…"
        />
      </Field>
      <button type="submit" className="btn" disabled={!valid}>
        Add
      </button>
    </form>
  )
}

/** Freeze / lift per Timelock attachment, for its guardians and lifters. */
function FreezeControls({
  engine,
  model,
  ctx,
  maxFreeze,
  cooldown,
  onChange,
}: {
  engine: V2Engine
  model: SafeV2Model
  ctx: LabelContext
  maxFreeze?: bigint
  cooldown?: bigint
  onChange: () => void
}) {
  const { safe } = useSandbox()
  const { deployment } = engine
  const now = useNow()
  // Guardians must send the freeze themselves: any role that can send from here (a key or a 1-of-1 Safe).
  const roles = rolesStore.use().filter((r) => hasLocalKey(r) || roleKind(r) === 'safe')
  const timelocks = model.attachments.filter(
    (
      a,
    ): a is Attachment & {
      settings: {
        policy: 'timelock'
        settings: { guardians: readonly Address[]; lifters: readonly Address[] }
      }
    } =>
      a.settings?.policy === 'timelock' &&
      (a.settings.settings.guardians.length > 0 || a.settings.settings.lifters.length > 0),
  )
  if (timelocks.length === 0)
    return (
      <p className="muted small">
        No Timelock has a guardian: nothing can be frozen (Owners template, or a kill switch on an actor).
      </p>
    )
  return (
    <ul className="plain stack">
      {timelocks.map((a) => {
        const { guardians, lifters } = a.settings.settings
        const phase = freezePhase(a.freeze, BigInt(now))
        const guardian = roles.find((r) => guardians.some((g) => isAddressEqual(g, r.address)))
        const lifter = roles.find((r) => [...guardians, ...lifters].some((g) => isAddressEqual(g, r.address)))
        const freeze = timelockCalls.freeze(deployment, safe, [a.attachmentId])
        const lift = timelockCalls.lift(deployment, safe, a.attachmentId)
        return (
          <li key={a.attachmentId} className="row wrap">
            <strong>{actorLabel(a.scope.actor, ctx.nameOf)}</strong>
            <span className="small">{callPhrase(a.scope, ctx)}</span>
            <FreezeBadge a={a} now={now} />
            {phase === 'active' && <Badge tone="ok">active</Badge>}
            <span className="muted small">
              guardians {listLabel(guardians, ctx)}
              {lifters.length > 0 && ` · lifters ${listLabel(lifters, ctx)}`}
            </span>
            {phase === 'active' &&
              (guardian ? (
                <AsyncButton
                  variant="danger"
                  onClick={async () => {
                    await relay(guardian, freeze)
                    onChange()
                  }}
                  title={`Freezes it for ${maxFreeze === undefined ? 'F' : durationLabel(maxFreeze)}, then a cooldown of ${cooldown === undefined ? 'C' : durationLabel(cooldown)} with no new freeze`}
                >
                  Freeze as {guardian.label}
                </AsyncButton>
              ) : (
                <SendItYourself what="freeze" call={freeze} />
              ))}
            {phase === 'frozen' &&
              (lifter ? (
                <AsyncButton
                  onClick={async () => {
                    await relay(lifter, lift)
                    onChange()
                  }}
                  title="Ends the freeze now; the cooldown starts"
                >
                  Lift as {lifter.label}
                </AsyncButton>
              ) : (
                <SendItYourself what="lift" call={lift} />
              ))}
          </li>
        )
      })}
    </ul>
  )
}

/** No guardian key here: say so, and keep the raw call for a guardian wallet elsewhere. */
function SendItYourself({ what, call }: { what: 'freeze' | 'lift'; call: { to: Address; data: Hex } }) {
  return (
    <span className="small">
      <span className="muted">
        No {what === 'freeze' ? 'guardian' : 'guardian or lifter'} key in this browser.
      </span>{' '}
      <details className="inline-details">
        <summary>Send it from the guardian&apos;s wallet</summary>
        to {shortAddress(call.to)}, calldata <CopyButton value={call.data} />
      </details>
    </span>
  )
}

/**
 * One queue for everything TimelockPolicy delays. Owner transactions (tracked by this app or
 * scheduled on-chain) each get one row with their next step; module schedules follow; then
 * Freeze / Lift per attachment.
 */
export function Queue({
  engine,
  model,
  ctx,
  freezeLimits,
  onChange,
}: {
  engine: V2Engine
  model: SafeV2Model
  ctx: LabelContext
  freezeLimits?: { maxFreeze: bigint; cooldown: bigint }
  onChange: () => void
}) {
  const { safe } = useSandbox()
  const { deployment } = engine
  const tracked = v2TrackedStore.use()[safe.toLowerCase()] ?? []
  const nonce = useAsync(() => readSafeNonce(publicClient, safe), safe, NONCE_REFRESH_MS)
  const logs = useAsync(
    async () => {
      const latest = await publicClient.getBlockNumber()
      const fromBlock = deployment.fromBlock ?? (latest > DEFAULT_LOOKBACK ? latest - DEFAULT_LOOKBACK : 0n)
      return readTimelockLogs(publicClient, deployment, safe, { fromBlock, toBlock: latest })
    },
    `${deployment.policies.timelock}:${safe}`,
    QUEUE_REFRESH_MS,
  )
  const reload = () => {
    logs.reload()
    nonce.reload()
    onChange()
  }
  const queue = logs.data?.queue ?? []
  const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()
  const isTracked = (h: Hex) => tracked.some((t) => same(t.hash, h))
  const openOwners = queue.filter((e) => isOwnerEntry(e) && e.state === 'scheduled')
  const ownerHashes = [...openOwners.map((e) => e.txHash), ...tracked.map((t) => t.hash)].filter(
    (h, i, all) => all.findIndex((x) => same(x, h)) === i,
  )
  const openModules = queue.filter((e) => !isOwnerEntry(e) && e.state === 'scheduled')
  const closed = queue.filter((e) => e.state !== 'scheduled' && !isTracked(e.txHash)).slice(0, 8)

  return (
    <Card
      title={
        <span className="row">
          Queue
          <InfoTip>
            Owner transactions this app proposed or signed, and everything a Timelock delays. The owners sign
            in Safe{'{Wallet}'} as usual (sign only, do not execute); the relayer then schedules it and, after
            the delay, executes it with the same signatures. Signatures are bound to a Safe nonce: execute in
            nonce order.
          </InfoTip>
        </span>
      }
      actions={<span className="muted small">Safe nonce {nonce.data?.toString() ?? '…'}</span>}
    >
      <RelayerBar />
      {logs.error !== undefined && <Notice tone="bad">Could not read the queue: {String(logs.error)}</Notice>}
      <h3>Owner transactions</h3>
      {ownerHashes.length === 0 ? (
        <p className="muted">
          {logs.loading && !logs.data
            ? 'Scanning…'
            : 'None yet. Propose one from this app, or add it by hash.'}
        </p>
      ) : (
        <ul className="plain stack">
          {ownerHashes.map((h) => (
            <OwnerTxRow
              key={h.toLowerCase()}
              hash={h}
              entry={queue.find((e) => isOwnerEntry(e) && same(e.txHash, h))}
              tracked={tracked.find((t) => same(t.hash, h))}
              engine={engine}
              model={model}
              currentNonce={nonce.data}
              onChange={reload}
            />
          ))}
        </ul>
      )}
      <TrackByHash />
      {openModules.length > 0 && (
        <>
          <h3>Module schedules</h3>
          <ul className="plain stack">
            {openModules.map((e) => (
              <ModuleEntryRow
                key={e.txHash}
                entry={e}
                engine={engine}
                model={model}
                ctx={ctx}
                onChange={reload}
              />
            ))}
          </ul>
        </>
      )}
      {closed.length > 0 && (
        <details className="small">
          <summary>Recently closed ({closed.length})</summary>
          <ul className="plain">
            {closed.map((e) => (
              <li key={e.txHash}>
                {actorLabel(e.actor, ctx.nameOf)} ·{' '}
                {selectorName(e.data.slice(0, 10) as Hex) ?? e.data.slice(0, 10)} ·{' '}
                {cancelOutcome(e) === 'final' ? 'cancelled for good' : e.state}
                {e.cancelledBy &&
                  ` by ${isAddressEqual(e.cancelledBy, safe) ? 'the owners' : (ctx.nameOf?.(e.cancelledBy) ?? shortAddress(e.cancelledBy))}`}
                {cancelOutcome(e) === 'reschedulable' && ': the module may schedule it again'}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>
          <strong>Sign any owner transaction here</strong>{' '}
          <span className="muted small">(power users: custom call, chosen nonce, local signer keys)</span>
        </summary>
        <ScheduleOwnerTx engine={engine} currentNonce={nonce.data} onScheduled={reload} />
      </details>
      <h3>
        Freeze and lift
        {freezeLimits && (
          <span className="muted small">
            {' '}
            · a freeze lasts at most {durationLabel(freezeLimits.maxFreeze)}, then{' '}
            {durationLabel(freezeLimits.cooldown)} with no new freeze
          </span>
        )}
      </h3>
      <FreezeControls
        engine={engine}
        model={model}
        ctx={ctx}
        maxFreeze={freezeLimits?.maxFreeze}
        cooldown={freezeLimits?.cooldown}
        onChange={reload}
      />
      {logs.data && logs.data.freezes.length > 0 && (
        <details className="small">
          <summary>Freeze history ({logs.data.freezes.length})</summary>
          <ul className="plain">
            {logs.data.freezes.slice(0, 10).map((f, i) => (
              <li key={i}>
                {f.kind} {f.attachmentId.slice(0, 10)}… by {ctx.nameOf?.(f.by) ?? shortAddress(f.by)} · until{' '}
                {formatTime(Number(f.until) * 1000)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
