import { useState } from 'react'
import { type Address, type Hex, isAddressEqual, parseEther } from 'viem'
import { chain, publicClient } from '../../config/client'
import { EXPLORER, type V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { formatDuration, formatTime, shortAddress } from '../../lib/format'
import { execOwnerTxAsRole, sendCallAsRole, signHashAsRole, simulateCallAsRole } from '../../lib/roleExec'
import { runSteps } from '../../lib/runner'
import {
  type Attachment,
  Kind,
  type LabelContext,
  OWNERS,
  Operation,
  type OwnerCall,
  type QueueEntry,
  type SafeTransaction,
  type SafeV2Model,
  actorLabel,
  callPhrase,
  durationLabel,
  freezePhase,
  isOwnerEntry,
  listLabel,
  mergeTimelocks,
  ownerNonceState,
  policyGuardAbi,
  readCancelDigest,
  readConfiguredAt,
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
import { type Role, logActivity, roleKind, rolesStore, v2OwnerTxStore } from '../../store'
import { InfoTip } from '../Tooltip'
import { AddressView, AsyncButton, Badge, Card, CopyButton, Field, Notice } from '../ui'
import { FreezeBadge } from './OrgChart'

const QUEUE_REFRESH_MS = 30_000
const NONCE_REFRESH_MS = 10_000
/** Without a known deployment block, scan roughly the last three weeks of Sepolia. */
const DEFAULT_LOOKBACK = 150_000n

type Call = { to: Address; data: Hex; description: string }

/** Simulates then sends a direct call as `role`, logs it and waits for the receipt. */
async function relay(role: Role, call: Call): Promise<Hex> {
  const denied = await simulateCallAsRole(role, call)
  if (denied) throw new Error(denied)
  const hash = await sendCallAsRole(role, call)
  logActivity({
    role: role.address,
    mode: 'execute',
    label: call.description,
    status: 'sent',
    txHash: hash,
    link: `${EXPLORER}/tx/${hash}`,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Reverted on-chain (${shortAddress(hash)})`)
  return hash
}

const useEoaRoles = () => rolesStore.use().filter((r) => roleKind(r) === 'eoa')

function RelayerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const relayers = useEoaRoles()
  return (
    <Field
      label="Relay with (pays gas)"
      info="Schedules and owner cancels are direct calls to the TimelockPolicy: anyone may send them."
    >
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {relayers.map((r) => (
          <option key={r.address} value={r.address}>
            {r.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** Owners local to this browser: EOA roles that are owners of the Safe. */
function useLocalOwners(): Role[] {
  const { state } = useSandbox()
  return useEoaRoles().filter((r) => (state?.owners ?? []).some((o) => isAddressEqual(o, r.address)))
}

const STATUS_TEXT = {
  frozen: 'frozen',
  void: 'void (scheduled before a freeze ended): schedule again',
  expired: 'expired: schedule again',
} as const

/** Live state of one open schedule: countdown, freeze, void / expired, owner nonce, actions. */
function EntryRow({
  entry,
  engine,
  model,
  currentNonce,
  ctx,
  onChange,
}: {
  entry: QueueEntry
  engine: V2Engine
  model: SafeV2Model
  currentNonce?: bigint
  ctx: LabelContext
  onChange: () => void
}) {
  const { safe, state } = useSandbox()
  const { deployment } = engine
  const now = BigInt(useNow())
  const roles = rolesStore.use()
  const localOwners = useLocalOwners()
  const stored = v2OwnerTxStore.use()[entry.txHash.toLowerCase()]
  const [relayer, setRelayer] = useState('')
  const owners = isOwnerEntry(entry)
  const live = useAsync(
    async () => {
      const [schedule, [, found]] = await Promise.all([
        readSchedule(publicClient, deployment, safe, entry.txHash),
        publicClient.readContract({
          address: deployment.engine,
          abi: policyGuardAbi,
          functionName: 'matches',
          args: [safe, entry.actor, entry.to, entry.value, entry.data, entry.operation],
        }),
      ])
      const ids = [
        ...new Set(
          found
            .filter((m) => m.kind === Kind.POLICY && isAddressEqual(m.policy, deployment.policies.timelock))
            .map((m) => m.attachmentId),
        ),
      ]
      const configuredAt = await Promise.all(
        ids.map((id) => readConfiguredAt(publicClient, deployment, safe, id)),
      )
      return { schedule, ids, configuredAt }
    },
    `${entry.txHash}:${model.attachments.length}`,
    15_000,
  )
  const data = live.data
  if (!data) return <li className="muted small">{entry.txHash.slice(0, 18)}… loading</li>
  if (!data.schedule) return null
  const matched = data.ids.flatMap((id, i) => {
    const a = model.attachments.find((x) => x.attachmentId === id)
    return a?.settings?.policy === 'timelock'
      ? [
          {
            attachmentId: id,
            settings: a.settings.settings,
            configuredAt: data.configuredAt[i],
            freeze: a.freeze,
          },
        ]
      : []
  })
  const merged = mergeTimelocks(matched)
  const status = scheduleStatus(data.schedule, merged, now)
  const nonceState =
    owners && currentNonce !== undefined ? ownerNonceState(entry.nonce, currentNonce) : undefined
  const relayRole = roles.find((r) => r.address === relayer)
  const scheduledIds = new Set(data.schedule.attachmentIds)
  const cancellers = model.attachments
    .filter((a) => scheduledIds.has(a.attachmentId) && a.settings?.policy === 'timelock')
    .flatMap((a) => (a.settings?.policy === 'timelock' ? a.settings.settings.cancellers : []))
  const cancellerRole = roles.find(
    (r) => roleKind(r) === 'eoa' && cancellers.some((c) => isAddressEqual(c, r.address)),
  )
  const actorRole = roles.find((r) => isAddressEqual(r.address, entry.actor))
  const fn = selectorName(entry.data.slice(0, 10) as Hex) ?? entry.data.slice(0, 10)
  const executable = status.status === 'ready' && (!owners || nonceState === 'next')

  const cancelAsOwners = async () => {
    if (!relayRole) throw new Error('Pick a relayer')
    const threshold = state?.threshold ?? 1
    const signers = localOwners.slice(0, threshold)
    if (signers.length < threshold)
      throw new Error(`Needs ${threshold} owner signatures; ${signers.length} local owner key(s)`)
    const digest = await readCancelDigest(publicClient, deployment, safe, entry.txHash)
    const sigs = []
    for (const s of signers) sigs.push(await signHashAsRole(s, digest))
    await relay(
      relayRole,
      timelockCalls.cancelAsOwners(deployment, safe, entry.txHash, sortOwnerSignatures(sigs)),
    )
    onChange()
  }

  return (
    <li className="queue-entry">
      <div className="row wrap">
        <strong>{actorLabel(entry.actor, ctx.nameOf)}</strong>
        <span>
          {entry.isConfiguration ? <Badge tone="warn">configuration change</Badge> : null} {fn} on{' '}
          <AddressView address={entry.to} />
          {entry.value > 0n && ` · ${entry.value} wei`}
          {entry.operation === Operation.DELEGATECALL && ' · DELEGATECALL'}
        </span>
        {owners && <Badge>nonce {entry.nonce.toString()}</Badge>}
        {status.status === 'waiting' && (
          <Badge tone="warn">
            ready in {formatDuration(status.readyAt - now)} ({formatTime(Number(status.readyAt) * 1000)})
          </Badge>
        )}
        {status.status === 'ready' && (
          <Badge tone="ok">
            ready{status.expiresAt !== undefined && ` · expires in ${formatDuration(status.expiresAt - now)}`}
          </Badge>
        )}
        {status.status === 'frozen' && (
          <Badge tone="bad">
            frozen until {formatTime(Number(merged.frozenUntil) * 1000)}
            {!entry.isConfiguration && ': then void'}
          </Badge>
        )}
        {(status.status === 'void' || status.status === 'expired') && (
          <Badge tone="bad">{STATUS_TEXT[status.status]}</Badge>
        )}
        {nonceState === 'stale' && (
          <Badge tone="bad">dead: nonce {entry.nonce.toString()} already used</Badge>
        )}
        {nonceState === 'later' && (
          <Badge tone="warn">
            {(entry.nonce - currentNonce!).toString()} owner transaction(s) must execute first
          </Badge>
        )}
      </div>
      <div className="muted small">
        {entry.txHash} · delay {durationLabel(merged.delay)}
        {merged.window > 0n && `, window ${durationLabel(merged.window)}`} · cancellable by{' '}
        {owners
          ? `the owners (${state?.threshold ?? '?'} signatures)`
          : `${actorLabel(entry.actor, ctx.nameOf)} itself`}
        {cancellers.length > 0 && `, ${listLabel(cancellers, ctx)}`}
      </div>
      <div className="row wrap align-end">
        {owners && <RelayerSelect value={relayer} onChange={setRelayer} />}
        {owners && stored && executable && (
          <AsyncButton
            variant="primary"
            disabled={!relayRole}
            onClick={async () => {
              const hash = await execOwnerTxAsRole(relayRole!, safe, stored.tx, stored.signatures)
              logActivity({
                role: relayRole!.address,
                mode: 'execute',
                label: `execute owner tx #${entry.nonce}`,
                status: 'sent',
                txHash: hash,
                link: `${EXPLORER}/tx/${hash}`,
              })
              await publicClient.waitForTransactionReceipt({ hash })
              onChange()
            }}
            title="execTransaction with the signatures collected when scheduling"
          >
            Execute
          </AsyncButton>
        )}
        {owners && !stored && executable && (
          <span className="small">
            Ready: execute it from the Safe{'{Wallet}'} queue (nonce {entry.nonce.toString()}).
          </span>
        )}
        {!owners && actorRole && executable && (
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
        {owners && (
          <AsyncButton
            variant="danger"
            disabled={!relayRole || localOwners.length === 0}
            onClick={cancelAsOwners}
            title="threshold owner signatures over the policy's Cancel digest (bound to this schedule), from local owner keys"
          >
            Cancel as owners
          </AsyncButton>
        )}
        {!owners && actorRole && roleKind(actorRole) === 'eoa' && (
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
 * Schedules an owner transaction: from the Safe{Wallet} queue (its signatures are read through the
 * Safe Apps SDK) or signed here by local owner keys at a chosen nonce.
 */
function ScheduleOwnerTx({
  engine,
  currentNonce,
  prefill,
  onScheduled,
}: {
  engine: V2Engine
  currentNonce?: bigint
  prefill?: OwnerCall
  onScheduled: () => void
}) {
  const { safe, state, getQueuedTx } = useSandbox()
  const { deployment } = engine
  const roles = rolesStore.use()
  const localOwners = useLocalOwners()
  const [source, setSource] = useState<'queue' | 'local'>(getQueuedTx && !prefill ? 'queue' : 'local')
  const [hashInput, setHashInput] = useState('')
  const [relayer, setRelayer] = useState('')
  const [to, setTo] = useState<string>(prefill?.to ?? '')
  const [value, setValue] = useState('0')
  const [data, setData] = useState<string>(prefill?.data ?? '0x')
  const [nonceOffset, setNonceOffset] = useState(0)
  const [signers, setSigners] = useState<string[]>([])
  const queued = useAsync(
    async () =>
      getQueuedTx && /^0x[0-9a-fA-F]{64}$/.test(hashInput.trim()) ? getQueuedTx(hashInput.trim()) : undefined,
    hashInput.trim(),
  )
  const relayRole = roles.find((r) => r.address === relayer)
  const threshold = state?.threshold ?? 1
  const target = parseAddressInput(to, 'target')
  const calldata = parseHexInput(data)
  const nonce = currentNonce === undefined ? undefined : currentNonce + BigInt(nonceOffset)
  const [gates, setGates] = useState<{ key: string; text: string; ok: boolean }>()
  const previewKey = `${to}:${value}:${data}:${nonce}`

  const previewAtNonce = async () => {
    if (!target.ok || !calldata.ok || nonce === undefined) return
    const call = {
      to: target.value,
      value: parseEther(value || '0'),
      data: calldata.value,
      operation: Operation.CALL,
    }
    const r = await runPreview(publicClient, deployment, safe, OWNERS, call, {
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

  const schedule = async (tx: SafeTransaction, signatures: Hex) => {
    if (!relayRole) throw new Error('Pick a relayer')
    await relay(relayRole, timelockCalls.schedule(deployment, safe, tx, signatures))
    onScheduled()
  }

  const scheduleQueued = async () => {
    const q = queued.data!
    if (q.signatures.length < threshold)
      throw new Error(`${q.signatures.length} of ${threshold} signatures so far`)
    await schedule(
      {
        to: q.to,
        value: q.value,
        data: q.data,
        operation: q.operation as SafeTransaction['operation'],
        safeTxGas: q.safeTxGas,
        baseGas: q.baseGas,
        gasPrice: q.gasPrice,
        gasToken: q.gasToken,
        refundReceiver: q.refundReceiver,
        nonce: q.nonce,
      },
      sortOwnerSignatures(q.signatures),
    )
  }

  const signAndSchedule = async () => {
    if (!target.ok || !calldata.ok || nonce === undefined) return
    const tx = safeTransaction(
      { to: target.value, value: parseEther(value || '0'), data: calldata.value, operation: Operation.CALL },
      nonce,
    )
    const hash = safeTxHash(chain.id, safe, tx)
    const chosen = localOwners.filter((o) => signers.includes(o.address))
    if (chosen.length < threshold) throw new Error(`Pick ${threshold} owner key(s)`)
    const sigs = []
    for (const o of chosen) sigs.push(await signHashAsRole(o, hash))
    const signatures = sortOwnerSignatures(sigs)
    await schedule(tx, signatures)
    v2OwnerTxStore.set((all) => ({
      ...all,
      [hash.toLowerCase()]: { safe, engine: deployment.engine, tx, signatures },
    }))
  }

  return (
    <div className="stack">
      <div className="tabs" role="group" aria-label="Source">
        {getQueuedTx && (
          <button
            type="button"
            className={source === 'queue' ? 'tab active' : 'tab'}
            onClick={() => setSource('queue')}
          >
            From the Safe{'{Wallet}'} queue
          </button>
        )}
        <button
          type="button"
          className={source === 'local' ? 'tab active' : 'tab'}
          onClick={() => setSource('local')}
        >
          Sign here with local owner keys
        </button>
      </div>
      {source === 'queue' ? (
        <div className="stack">
          <p className="small muted">
            Propose the transaction in Safe{'{Wallet}'}, collect the owners&apos; signatures, then paste its
            Safe transaction hash: the same signatures schedule it. Execute it from the Safe{'{Wallet}'} queue
            once ready.
          </p>
          <Field label="Safe transaction hash">
            <input
              className="mono"
              value={hashInput}
              onChange={(e) => setHashInput(e.target.value)}
              placeholder="0x…"
            />
          </Field>
          {queued.error !== undefined && <span className="error-text">{String(queued.error)}</span>}
          {queued.data && (
            <div className="small">
              {selectorName(queued.data.data.slice(0, 10) as Hex) ?? queued.data.data.slice(0, 10)} on{' '}
              <AddressView address={queued.data.to} /> · nonce {queued.data.nonce.toString()} ·{' '}
              {queued.data.signatures.length}/{threshold} signatures
              {currentNonce !== undefined && queued.data.nonce < currentNonce && (
                <Badge tone="bad">nonce already used</Badge>
              )}
              {(queued.data.safeTxGas !== 0n || queued.data.gasPrice !== 0n) && (
                <Badge tone="bad">safeTxGas / gasPrice must be 0 under V2</Badge>
              )}
            </div>
          )}
          <div className="row wrap align-end">
            <RelayerSelect value={relayer} onChange={setRelayer} />
            <AsyncButton variant="primary" disabled={!queued.data || !relayRole} onClick={scheduleQueued}>
              Schedule
            </AsyncButton>
          </div>
        </div>
      ) : (
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
              info="A later nonce leaves room for owner transactions that execute first (each one uses a nonce)."
            >
              <select value={nonceOffset} onChange={(e) => setNonceOffset(Number(e.target.value))}>
                {[0, 1, 2, 3, 4].map((k) => (
                  <option key={k} value={k}>
                    {currentNonce === undefined ? `+${k}` : (currentNonce + BigInt(k)).toString()}
                    {k === 0 ? ' (next)' : ` (leaves ${k} before it)`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="field">
            <span className="field-label">Sign with ({threshold} needed)</span>
            {localOwners.length === 0 ? (
              <span className="muted small">No local role is an owner of this Safe.</span>
            ) : (
              <div className="checklist">
                {localOwners.map((o) => (
                  <label key={o.address} className="row">
                    <input
                      type="checkbox"
                      checked={signers.includes(o.address)}
                      onChange={(e) =>
                        setSigners((list) =>
                          e.target.checked ? [...list, o.address] : list.filter((a) => a !== o.address),
                        )
                      }
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="row wrap align-end">
            <RelayerSelect value={relayer} onChange={setRelayer} />
            <AsyncButton
              variant="primary"
              disabled={!target.ok || !calldata.ok || !relayRole || signers.length < threshold}
              onClick={signAndSchedule}
            >
              Sign &amp; schedule
            </AsyncButton>
            <AsyncButton
              disabled={!target.ok || !calldata.ok || nonce === undefined}
              onClick={previewAtNonce}
              title="matches + each policy's check as the owners, with the Safe tx hash at the chosen nonce"
            >
              Preview gates at this nonce
            </AsyncButton>
          </div>
          {gates?.key === previewKey && (
            <span className={gates.ok ? 'small' : 'small error-text'}>{gates.text}</span>
          )}
        </div>
      )}
    </div>
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
  const roles = useEoaRoles()
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
                <span className="small">
                  freeze calldata (send from a guardian to {shortAddress(freeze.to)}){' '}
                  <CopyButton value={freeze.data} />
                </span>
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
                <span className="small">
                  lift calldata <CopyButton value={lift.data} />
                </span>
              ))}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One queue for everything TimelockPolicy delays: owner and module schedules, configuration
 * changes included, with countdown, frozen / void / expired state and the owner nonce; Schedule,
 * Execute, Cancel; and Freeze / Lift per attachment.
 */
export function Queue({
  engine,
  model,
  ctx,
  freezeLimits,
  prefill,
  onChange,
}: {
  engine: V2Engine
  model: SafeV2Model
  ctx: LabelContext
  freezeLimits?: { maxFreeze: bigint; cooldown: bigint }
  prefill?: OwnerCall
  onChange: () => void
}) {
  const { safe } = useSandbox()
  const { deployment } = engine
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
  const open = queue.filter((e) => e.state === 'scheduled')
  const ownersFirst = [...open.filter(isOwnerEntry), ...open.filter((e) => !isOwnerEntry(e))]
  const closed = queue.filter((e) => e.state !== 'scheduled').slice(0, 8)
  return (
    <Card
      title={
        <span className="row">
          Queue
          <InfoTip>
            A transaction under a Timelock is scheduled, then executed after the delay (the longest matched
            delay, from the schedule or the latest re-configuration). A freeze blocks it; a schedule made
            before the freeze ended is void (except configuration changes). Module schedules are made from the
            playground, by the module itself.
          </InfoTip>
        </span>
      }
      actions={<span className="muted small">Safe nonce {nonce.data?.toString() ?? '…'}</span>}
    >
      <Notice tone="warn">
        <strong>Owner schedules are bound to the Safe nonce.</strong> Any other owner transaction executed
        first, a configure included, uses that nonce and the schedule can never execute. Schedule at a later
        nonce to leave room, and execute in nonce order.
      </Notice>
      {logs.error !== undefined && <Notice tone="bad">Could not read the queue: {String(logs.error)}</Notice>}
      {ownersFirst.length === 0 ? (
        <p className="muted">{logs.loading && !logs.data ? 'Scanning…' : 'Nothing scheduled.'}</p>
      ) : (
        <ul className="plain stack">
          {ownersFirst.map((e) => (
            <EntryRow
              key={e.txHash}
              entry={e}
              engine={engine}
              model={model}
              currentNonce={nonce.data}
              ctx={ctx}
              onChange={reload}
            />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <details className="small">
          <summary>Recently closed ({closed.length})</summary>
          <ul className="plain">
            {closed.map((e) => (
              <li key={e.txHash}>
                {actorLabel(e.actor, ctx.nameOf)} ·{' '}
                {selectorName(e.data.slice(0, 10) as Hex) ?? e.data.slice(0, 10)} · {e.state}
                {e.cancelledBy &&
                  ` by ${isAddressEqual(e.cancelledBy, safe) ? 'the owners' : (ctx.nameOf?.(e.cancelledBy) ?? shortAddress(e.cancelledBy))}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <h3>Schedule an owner transaction</h3>
      <ScheduleOwnerTx
        key={prefill?.data ?? 'none'}
        engine={engine}
        currentNonce={nonce.data}
        prefill={prefill}
        onScheduled={reload}
      />
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
