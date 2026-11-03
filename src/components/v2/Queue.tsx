import { type Address, type Hex, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
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
  readSafeNonce,
  readTimelockLogs,
  selectorName,
  timelockCalls,
} from '../../lib/v2'
import { hasLocalKey, roleKind, rolesStore, v2TrackedStore } from '../../store'
import { Term } from '../Term'
import { InfoTip } from '../Tooltip'
import { AsyncButton, Badge, Card, CopyButton, Notice } from '../ui'
import { FreezeBadge } from './OrgChart'
import { ModuleEntryRow, OwnerTxRow } from './QueueRows'
import { RelayerBar, relay } from './relayer'

export { useLocalOwners } from './QueueRows'

const QUEUE_REFRESH_MS = 30_000
const NONCE_REFRESH_MS = 10_000
/** Without a known deployment block, scan roughly the last three weeks of Sepolia. */
const DEFAULT_LOOKBACK = 150_000n

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
    <ul className="plain stack">
      <li className="muted small">
        A freeze stops new transactions of that actor. Allowances, operator rights and pre-signed orders stay
        usable: revoke them separately.
      </li>
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
          <li key={a.attachmentId} className="row wrap">
            <strong>{actorLabel(a.scope.actor, ctx.nameOf)}</strong>
            <span className="small">{callPhrase(a.scope, ctx)}</span>
            <FreezeBadge a={a} now={now} />
            {phase === 'active' && <Badge tone="ok">active</Badge>}
            <span className="muted small">
              guardians {listLabel(guardians, ctx)}
              {lifters.length > 0 && ` · lifters ${listLabel(lifters, ctx)}`}
            </span>
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
            in Safe{'{Wallet}'} (sign only, do not execute); the relayer schedules it, then executes it with
            the same signatures once the delay has passed.
          </InfoTip>
        </span>
      }
      actions={
        <span className="muted small">
          Safe <Term k="nonce">nonce</Term> {nonce.data?.toString() ?? '…'}
        </span>
      }
    >
      <RelayerBar />
      {logs.error !== undefined && (
        <Notice tone="bad" title="Could not read the queue">
          {String(logs.error)}
        </Notice>
      )}
      <h3>Owner transactions</h3>
      {ownerHashes.length === 0 ? (
        <p className="muted">
          {logs.loading && !logs.data
            ? 'Scanning…'
            : 'None yet. Propose one from the draft or the playground.'}
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
      <h3>
        Freeze and lift
        {freezeLimits && (
          <span className="muted small">
            {' '}
            · an actor is frozen at most {durationLabel(freezeLimits.maxFreeze)} at a time, whoever freezes,
            then {durationLabel(freezeLimits.cooldown)} with no new freeze
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
