import { type Address, type Hex, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { describeError } from '../../lib/errors'
import { formatTime, shortAddress } from '../../lib/format'
import {
  type Attachment,
  type LabelContext,
  type SafeV2Model,
  actorLabel,
  actorWindowPhase,
  callPhrase,
  cancelOutcome,
  durationLabel,
  freezePhase,
  isOwnerEntry,
  listLabel,
  readActorWindow,
  selectorName,
  timelockCalls,
} from '../../lib/v2'
import { hasLocalKey, relayStore, roleKind, rolesStore, v2TrackedStore } from '../../store'
import { Term } from '../Term'
import { InfoTip } from '../Tooltip'
import { GearIcon } from '../icons'
import { AsyncButton, Badge, CopyButton, Notice } from '../ui'
import { FreezeBadge } from './OrgChart'
import { QueueGroup } from './QueueItem'
import { ModuleEntryRow, OwnerTxRow } from './QueueRows'
import { RelayerBar, relay, useRelayer } from './relayer'
import { countNeedingAction, isTrackedClosed, useSafeNonce, useTimelockLogs } from './useQueueData'
import { useLabelContext, useV2 } from './useV2'

export { useLocalOwners } from './QueueRows'

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
  // Freezes are bounded per actor, whoever the guardian: one window per actor (F), then C.
  const actors = [...new Set(timelocks.map((a) => a.scope.actor))]
  const windows = useAsync(
    async () =>
      new Map(
        await Promise.all(
          actors.map(
            async (actor) => [actor, await readActorWindow(publicClient, deployment, safe, actor)] as const,
          ),
        ),
      ),
    `${safe}:${actors.join(',')}:${model.attachments.map((a) => a.freeze?.frozenUntil ?? 0n).join(',')}`,
    30_000,
  )
  if (timelocks.length === 0)
    return (
      <p className="muted small">
        No Timelock has a guardian, so nothing can be frozen. Add one with the template Delay + freeze, or a
        kill switch on an actor.
      </p>
    )
  return (
    <ul className="plain qi-list">
      {timelocks.map((a) => {
        const { guardians, lifters } = a.settings.settings
        const phase = freezePhase(a.freeze, BigInt(now))
        const guardian = roles.find((r) => guardians.some((g) => isAddressEqual(g, r.address)))
        const lifter = roles.find((r) => [...guardians, ...lifters].some((g) => isAddressEqual(g, r.address)))
        const freeze = timelockCalls.freeze(deployment, safe, [a.attachmentId])
        const lift = timelockCalls.lift(deployment, safe, a.attachmentId)
        const window = actorWindowPhase(windows.data?.get(a.scope.actor), BigInt(now))
        const who = actorLabel(a.scope.actor, ctx.nameOf)
        return (
          <li key={a.attachmentId} className="row wrap guardian-line">
            <strong>{who}</strong>
            <span className="small">{callPhrase(a.scope, ctx)}</span>
            <FreezeBadge a={a} now={now} />
            {phase === 'active' && <Badge tone="ok">active</Badge>}
            <InfoTip>
              Guardians {listLabel(guardians, ctx)}
              {lifters.length > 0 && `; lifters ${listLabel(lifters, ctx)}`}
            </InfoTip>
            <span className="queue-end" />
            {phase === 'active' && window.phase === 'cooling' && (
              <span className="muted small">
                {who} cools down until {formatTime(Number(window.until) * 1000)}: no freeze of its rules
                before
              </span>
            )}
            {phase === 'active' &&
              window.phase !== 'cooling' &&
              (guardian ? (
                <AsyncButton
                  variant="danger"
                  onClick={async () => {
                    await relay(guardian, freeze)
                    onChange()
                  }}
                  title={
                    window.phase === 'open'
                      ? `Joins ${who}'s open freeze window: frozen until ${formatTime(Number(window.until) * 1000)}, not longer. Stops new transactions; allowances and pre-signed orders stay usable.`
                      : `Stops new transactions of ${who} for ${maxFreeze === undefined ? 'F' : durationLabel(maxFreeze)}, then a cooldown of ${cooldown === undefined ? 'C' : durationLabel(cooldown)} with no new freeze of its rules. Allowances, operator rights and pre-signed orders stay usable: revoke them separately.`
                  }
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
/** Relayer and auto-schedule, folded behind a gear at the top right of the queue. */
function QueueSettings({ nonce }: { nonce?: bigint }) {
  const relayer = useRelayer()
  const { autoSchedule } = relayStore.use()
  return (
    <div className="row queue-settings">
      <span className="muted small">
        <Term k="nonce">Nonce</Term> {nonce?.toString() ?? '…'}
      </span>
      <details className="popover">
        <summary className="muted small" title="Relayer and auto-schedule">
          <GearIcon /> {relayer ? relayer.label : 'No relayer'}
          {autoSchedule && relayer ? ' · auto' : ''}
        </summary>
        <div className="popover-body">
          <RelayerBar />
          <p className="muted small">
            The owners sign in Safe{'{Wallet}'} (sign only, do not execute). The relayer schedules it, then
            executes it with the same signatures once the delay has passed.
          </p>
        </div>
      </details>
    </div>
  )
}

/**
 * One queue for everything TimelockPolicy delays, Safe{Wallet} style: Next (the owner transaction
 * at the current nonce), Queued (later nonces), module schedules, then the guardians' freeze and
 * lift. Closed items leave for History, in the Activity tab.
 */
function Queue({
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
  const nonce = useSafeNonce(safe)
  const logs = useTimelockLogs(deployment, safe)
  const reload = () => {
    logs.reload()
    nonce.reload()
    onChange()
  }
  const current = nonce.data
  const queue = logs.data?.queue ?? []
  const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()
  const entryOf = (h: Hex) => queue.find((e) => isOwnerEntry(e) && same(e.txHash, h))
  const trackedOf = (h: Hex) => tracked.find((t) => same(t.hash, h))
  const openOwners = queue.filter(
    (e) => isOwnerEntry(e) && e.state === 'scheduled' && (current === undefined || e.nonce >= current),
  )
  const owners = [
    ...openOwners.map((e) => ({ hash: e.txHash, nonce: e.nonce as bigint | undefined })),
    ...tracked
      .filter(
        (t) =>
          !isTrackedClosed(t, current) &&
          entryOf(t.hash)?.state !== 'executed' &&
          entryOf(t.hash)?.state !== 'cancelled',
      )
      .map((t) => ({ hash: t.hash, nonce: t.nonce })),
  ]
    .filter((o, i, all) => all.findIndex((x) => same(x.hash, o.hash)) === i)
    // Unknown nonces last; equal nonces (competing transactions) keep their order.
    .sort((a, b) =>
      a.nonce === b.nonce
        ? 0
        : a.nonce === undefined
          ? 1
          : b.nonce === undefined
            ? -1
            : a.nonce < b.nonce
              ? -1
              : 1,
    )
  const next = owners.filter((o) => current !== undefined && o.nonce === current)
  const queued = owners.filter((o) => !next.includes(o))
  const modules = queue.filter((e) => !isOwnerEntry(e) && e.state === 'scheduled')
  const row = (o: { hash: Hex }) => (
    <OwnerTxRow
      key={o.hash.toLowerCase()}
      hash={o.hash}
      entry={entryOf(o.hash)}
      tracked={trackedOf(o.hash)}
      engine={engine}
      model={model}
      currentNonce={current}
      onChange={reload}
    />
  )

  return (
    <div className="stack">
      <QueueSettings nonce={current} />
      {logs.error !== undefined && (
        <Notice tone="bad" title="Could not read the queue">
          {describeError(logs.error)}
        </Notice>
      )}
      {owners.length === 0 && modules.length === 0 ? (
        <p className="muted">
          {logs.loading && !logs.data
            ? 'Scanning…'
            : 'Nothing waits. Propose an owner transaction from the draft or the playground.'}
        </p>
      ) : (
        <ul className="plain qi-list">
          {next.length > 0 && <QueueGroup>Next</QueueGroup>}
          {next.map(row)}
          {queued.length > 0 && <QueueGroup>Queued</QueueGroup>}
          {queued.map(row)}
          {modules.length > 0 && <QueueGroup>Module schedules</QueueGroup>}
          {modules.map((e) => (
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
      )}
      <Guardians engine={engine} model={model} ctx={ctx} freezeLimits={freezeLimits} onChange={reload} />
    </div>
  )
}

/** Freeze and lift, one line per Timelock attachment with guardians; nothing when there is none. */
function Guardians({
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
  return (
    <section className="queue-guardians">
      <h3 className="row">
        Guardians
        <InfoTip>
          A freeze stops new transactions of that actor. Allowances, operator rights and pre-signed orders
          stay usable: revoke them separately.
          {freezeLimits &&
            ` An actor is frozen at most ${durationLabel(freezeLimits.maxFreeze)} at a time, whoever freezes, then ${durationLabel(freezeLimits.cooldown)} with no new freeze.`}
        </InfoTip>
      </h3>
      <FreezeControls
        engine={engine}
        model={model}
        ctx={ctx}
        maxFreeze={freezeLimits?.maxFreeze}
        cooldown={freezeLimits?.cooldown}
        onChange={onChange}
      />
    </section>
  )
}

/**
 * History of the Timelock, for the Activity tab: schedules that closed (executed, cancelled) and
 * freezes, wherever they were sent from.
 */
export function TimelockHistory() {
  const { safe, v2 } = useSandbox()
  const ctx = useLabelContext(v2)
  const logs = useTimelockLogs(v2!.deployment, safe)
  const closed = (logs.data?.queue ?? []).filter((e) => e.state !== 'scheduled')
  const freezes = logs.data?.freezes ?? []
  const name = (a: Address) => (isAddressEqual(a, safe) ? 'the owners' : (ctx.nameOf?.(a) ?? shortAddress(a)))
  if (closed.length === 0 && freezes.length === 0) return null
  return (
    <details className="small timelock-history">
      <summary>
        Timelock history ({closed.length} closed, {freezes.length} freeze events)
      </summary>
      <ul className="plain">
        {closed.map((e) => (
          <li key={e.txHash}>
            {isOwnerEntry(e) ? `Owners, nonce ${e.nonce}` : actorLabel(e.actor, ctx.nameOf)} ·{' '}
            {selectorName(e.data.slice(0, 10) as Hex) ?? e.data.slice(0, 10)} ·{' '}
            {cancelOutcome(e) === 'final' ? 'cancelled for good' : e.state}
            {e.cancelledBy && ` by ${name(e.cancelledBy)}`}
            {cancelOutcome(e) === 'reschedulable' && ': the module may schedule it again'}
          </li>
        ))}
        {freezes.map((f, i) => (
          <li key={`f${i}`}>
            {f.kind} {f.attachmentId.slice(0, 10)}… by {name(f.by)} · until{' '}
            {formatTime(Number(f.until) * 1000)}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** The dock's Queue tab: the queue of the installed V2 engine, else why there is none. */
export function QueuePanel() {
  const { v2, v2Installed } = useSandbox()
  if (!v2 || !v2Installed)
    return (
      <p className="muted">
        The queue lists owner transactions and Timelock schedules once Policy Engine V2 is installed on this
        Safe.
      </p>
    )
  return <InstalledQueue />
}

function InstalledQueue() {
  const view = useV2()
  if (view.error !== undefined && !view.model)
    return (
      <Notice tone="bad" title="Could not read the V2 engine">
        {describeError(view.error)}
      </Notice>
    )
  if (!view.model) return <p className="muted">Loading…</p>
  return (
    <Queue
      engine={view.engine}
      model={view.model}
      ctx={view.ctx}
      freezeLimits={view.freezeLimits}
      onChange={view.reload}
    />
  )
}

/** How many queue items wait on someone; rendered only when V2 is installed. */
export function QueueCount() {
  const { safe, v2 } = useSandbox()
  const tracked = v2TrackedStore.use()[safe.toLowerCase()] ?? []
  const now = BigInt(useNow(10_000))
  const logs = useTimelockLogs(v2!.deployment, safe)
  const nonce = useSafeNonce(safe)
  const count = countNeedingAction(logs.data?.queue ?? [], tracked, now, nonce.data)
  return count > 0 ? <Badge tone="warn">{count}</Badge> : null
}
