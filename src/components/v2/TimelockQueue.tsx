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
  type LabelContext,
  OWNERS,
  Operation,
  type QueueEntry,
  type SafeTransaction,
  type SafeV2Model,
  actorLabel,
  isOwnerEntry,
  mergeTimelocks,
  ownerNonceState,
  readCancelState,
  readFreezeStatus,
  readMatchingAttachments,
  readSafeNonce,
  readSchedule,
  readTimelockConfiguredAt,
  readTimelockQueue,
  runPreview,
  safeTransaction,
  safeTxHash,
  scheduleStatus,
  selectorName,
  sortOwnerSignatures,
  timelockCalls,
  timelockCancelDigest,
  timelockSettingsOf,
} from '../../lib/v2'
import { parseAddressInput, parseHexInput } from '../../lib/validation'
import { type Role, logActivity, roleKind, rolesStore, v2OwnerTxStore } from '../../store'
import { InfoTip } from '../Tooltip'
import { AddressView, AsyncButton, Badge, Card, Field, Notice } from '../ui'
import { useLabelContext } from './useV2'

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

/** Local EOA roles: any of them can relay a schedule / cancel (anyone may), paying the gas. */
function useRelayers() {
  return rolesStore.use().filter((r) => roleKind(r) === 'eoa')
}

function RelayerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const relayers = useRelayers()
  return (
    <Field
      label="Relay with (pays gas)"
      info="Schedules and cancels are direct calls to the TimelockPolicy: anyone may send them."
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
  return rolesStore
    .use()
    .filter((r) => roleKind(r) === 'eoa' && (state?.owners ?? []).some((o) => isAddressEqual(o, r.address)))
}

function NonceExplainer() {
  return (
    <Notice tone="warn">
      <strong>Owner schedules are bound to the Safe nonce.</strong> An owner transaction is scheduled by its
      Safe transaction hash, which includes the nonce it will execute at. Any other owner transaction executed
      first uses that nonce, and the schedule can never execute: configuration requests and applies included
      (they skip the Timelock but still use a nonce). Schedule at a later nonce to leave room for them, and
      execute in nonce order.
    </Notice>
  )
}

/** Live state of one open schedule: countdown, freeze clearing, owner nonce, actions. */
function EntryRow({
  entry,
  engine,
  model,
  currentNonce,
  ctx,
}: {
  entry: QueueEntry
  engine: V2Engine
  model: SafeV2Model
  currentNonce?: bigint
  ctx: LabelContext
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
      const call = { to: entry.to, value: entry.value, data: entry.data, operation: entry.operation }
      const [schedule, matches, freeze, cancel] = await Promise.all([
        readSchedule(publicClient, deployment, safe, entry.txHash),
        readMatchingAttachments(
          publicClient,
          deployment.engine,
          safe,
          entry.actor,
          call,
          deployment.policies.timelock,
        ),
        readFreezeStatus(publicClient, deployment.engine, safe, entry.actor),
        owners ? readCancelState(publicClient, deployment, safe) : undefined,
      ])
      const ids = [...new Set(matches.map((m) => m.attachment.attachmentId))]
      const configuredAt = await readTimelockConfiguredAt(publicClient, deployment, safe, ids)
      return { schedule, matches, freeze, cancel, configuredAt }
    },
    `${entry.txHash}:${model.attachments.length}`,
    15_000,
  )
  const data = live.data
  if (!data) return <li className="muted small">{entry.txHash} …</li>
  if (!data.schedule) return null
  const ids = new Set(data.matches.map((m) => m.attachment.attachmentId))
  const matched = model.attachments.filter((a: Attachment) => ids.has(a.attachmentId))
  const merged = mergeTimelocks(timelockSettingsOf(matched))
  const status = scheduleStatus(data.schedule, {
    now,
    delay: merged.delay,
    window: merged.window,
    clearOnFreeze: merged.clearOnFreeze,
    freezeEpoch: data.freeze.epoch,
    configuredAt: data.configuredAt,
  })
  const nonceState =
    owners && currentNonce !== undefined ? ownerNonceState(entry.nonce, currentNonce) : undefined
  const relayRole = roles.find((r) => r.address === relayer)
  const cancellerRole = roles.find((r) => data.schedule!.cancellers.some((c) => isAddressEqual(c, r.address)))
  const actorRole = roles.find((r) => isAddressEqual(r.address, entry.actor))
  const fn = selectorName(entry.data.slice(0, 10) as Hex) ?? entry.data.slice(0, 10)

  const cancelAsOwners = async () => {
    if (!relayRole || !data.cancel) return
    const required = Number(data.cancel.requiredSignatures)
    const digest = timelockCancelDigest(
      chain.id,
      deployment.policies.timelock,
      deployment.engine,
      safe,
      entry.txHash,
      data.cancel.cancelCount,
    )
    const signers = localOwners.slice(0, required)
    if (signers.length < required)
      throw new Error(`Needs ${required} owner signatures; ${signers.length} local owner key(s)`)
    const sigs = []
    for (const s of signers) sigs.push(await signHashAsRole(s, digest))
    await relay(
      relayRole,
      timelockCalls.cancelAsOwners(deployment, safe, entry.txHash, sortOwnerSignatures(sigs)),
    )
    live.reload()
  }

  return (
    <li className="queue-entry">
      <div className="row wrap">
        <strong>{actorLabel(entry.actor, ctx.nameOf)}</strong>
        <span>
          {fn} on <AddressView address={entry.to} />
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
        {status.status === 'expired' && <Badge tone="bad">expired: schedule again</Badge>}
        {status.status === 'cleared' && <Badge tone="bad">cleared by a freeze: schedule again</Badge>}
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
        {entry.txHash} · cancellable by{' '}
        {owners
          ? `the owners (${data.cancel?.requiredSignatures ?? '?'} signature(s) now)`
          : `${actorLabel(entry.actor, ctx.nameOf)} itself and the listed cancellers`}
        {data.schedule.cancellers.length > 0 &&
          `, ${data.schedule.cancellers.map((c) => ctx.nameOf?.(c) ?? shortAddress(c)).join(', ')}`}
      </div>
      <div className="row wrap align-end">
        {owners && <RelayerSelect value={relayer} onChange={setRelayer} />}
        {owners && stored && status.status === 'ready' && nonceState === 'next' && (
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
              live.reload()
            }}
            title="execTransaction with the signatures collected when scheduling"
          >
            Execute
          </AsyncButton>
        )}
        {owners && !stored && status.status === 'ready' && nonceState === 'next' && (
          <span className="small">
            Ready: execute it in the Safe{'{Wallet}'} queue (nonce {entry.nonce.toString()}).
          </span>
        )}
        {!owners && actorRole && status.status === 'ready' && (
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
              live.reload()
            }}
            title={`Executes the scheduled call as ${actorRole.label}`}
          >
            Execute as {actorRole.label}
          </AsyncButton>
        )}
        {owners && state && (
          <AsyncButton
            variant="danger"
            disabled={!relayRole || localOwners.length === 0}
            onClick={cancelAsOwners}
            title={`Owners cancel: ${data.cancel?.requiredSignatures ?? '?'} signature(s) over the Cancel digest, from local owner keys. The count rises with each cancel (capped at the threshold) and resets when an owners' schedule executes: a single owner gets one cancel per executed transaction, enough to make each of them wait the delay twice`}
          >
            Cancel as owners
          </AsyncButton>
        )}
        {!owners && actorRole && !cancellerRole && (
          <AsyncButton
            variant="danger"
            onClick={async () => {
              await relay(actorRole, timelockCalls.cancel(deployment, safe, entry.txHash))
              live.reload()
            }}
            title={`${actorRole.label} scheduled it, so it may cancel it (SPEC §8.2)`}
          >
            Cancel as {actorRole.label}
          </AsyncButton>
        )}
        {cancellerRole && (
          <AsyncButton
            variant="danger"
            onClick={async () => {
              await relay(cancellerRole, timelockCalls.cancel(deployment, safe, entry.txHash))
              live.reload()
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
  onScheduled,
}: {
  engine: V2Engine
  currentNonce?: bigint
  onScheduled: () => void
}) {
  const { safe, state, getQueuedTx } = useSandbox()
  const { deployment } = engine
  const roles = rolesStore.use()
  const localOwners = useLocalOwners()
  const [source, setSource] = useState<'queue' | 'local'>(getQueuedTx ? 'queue' : 'local')
  const [hashInput, setHashInput] = useState('')
  const [relayer, setRelayer] = useState('')
  const [to, setTo] = useState('')
  const [value, setValue] = useState('0')
  const [data, setData] = useState('0x')
  const [nonceOffset, setNonceOffset] = useState(1)
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
  const ctx = useLabelContext(engine)
  const [gates, setGates] = useState<{ key: string; text: string; ok: boolean }>()
  const previewKey = `${to}:${value}:${data}:${nonce}`

  // Review L-5: preview at the nonce the transaction is scheduled at, not the current one.
  const previewAtNonce = async () => {
    if (!target.ok || !calldata.ok || nonce === undefined) return
    const call = {
      to: target.value,
      value: parseEther(value || '0'),
      data: calldata.value,
      operation: Operation.CALL,
    }
    const r = await runPreview(publicClient, deployment, safe, OWNERS, call, ctx, nonce)
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
    await relay(relayRole, timelockCalls.scheduleOwnerTx(deployment, safe, tx, signatures))
    onScheduled()
  }

  const scheduleQueued = async () => {
    const q = queued.data!
    if (q.signatures.length < threshold)
      throw new Error(`${q.signatures.length} of ${threshold} signatures so far`)
    const tx: SafeTransaction = {
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
    }
    await schedule(tx, sortOwnerSignatures(q.signatures))
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
            Propose the transaction in Safe{'{Wallet}'} (pick a later nonce there if configuration changes are
            pending), collect the owners&apos; signatures, then paste its Safe transaction hash: the same
            signatures schedule it. Execute it from the Safe{'{Wallet}'} queue once ready.
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
              info="current + 1 leaves room for one configuration transaction (request or apply) before it."
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
              title="Runs the engine's preview as the owners at the chosen nonce (eth_call with the Safe nonce overridden): a schedule at that nonce counts"
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

/**
 * The Timelock queue per actor (SPEC §8.2): countdowns, freeze clearing, owner nonces, and
 * Schedule / Execute / Cancel with the signatures each needs. Module schedules are made from the
 * playground (the module itself must send them).
 */
export function TimelockQueue({
  engine,
  model,
  ctx,
}: {
  engine: V2Engine
  model: SafeV2Model
  ctx: LabelContext
}) {
  const { safe } = useSandbox()
  const { deployment } = engine
  const nonce = useAsync(() => readSafeNonce(publicClient, safe), safe, NONCE_REFRESH_MS)
  const queue = useAsync(
    async () => {
      const latest = await publicClient.getBlockNumber()
      const fromBlock = engine.fromBlock ?? (latest > DEFAULT_LOOKBACK ? latest - DEFAULT_LOOKBACK : 0n)
      return readTimelockQueue(publicClient, deployment, safe, { fromBlock, toBlock: latest })
    },
    `${deployment.policies.timelock}:${safe}`,
    QUEUE_REFRESH_MS,
  )
  const open = (queue.data ?? []).filter((e) => e.state === 'scheduled')
  const distinct = [...new Set(open.map((e) => e.actor))]
  const actors = [
    ...distinct.filter((a) => isAddressEqual(a, OWNERS)),
    ...distinct.filter((a) => !isAddressEqual(a, OWNERS)),
  ]
  const closed = (queue.data ?? []).filter((e) => e.state !== 'scheduled').slice(0, 5)
  return (
    <Card
      title={
        <span className="row">
          Timelock queue
          <InfoTip>
            A transaction under a Timelock must be scheduled, then executed after the delay (the longest
            matched delay, re-read at execution). A freeze clears the owners&apos; queue (schedule again after
            it); Recovery&apos;s survives. Module schedules are made from the playground, by the module
            itself.
          </InfoTip>
        </span>
      }
      actions={<span className="muted small">Safe nonce {nonce.data?.toString() ?? '…'}</span>}
    >
      <NonceExplainer />
      {queue.error !== undefined && (
        <Notice tone="bad">Could not read the queue: {String(queue.error)}</Notice>
      )}
      {actors.length === 0 ? (
        <p className="muted">{queue.loading && !queue.data ? 'Scanning…' : 'Nothing scheduled.'}</p>
      ) : (
        actors.map((actor) => (
          <div key={actor}>
            <h3>{actorLabel(actor, ctx.nameOf)}</h3>
            <ul className="plain stack">
              {open
                .filter((e) => isAddressEqual(e.actor, actor))
                .map((e) => (
                  <EntryRow
                    key={e.txHash}
                    entry={e}
                    engine={engine}
                    model={model}
                    currentNonce={nonce.data}
                    ctx={ctx}
                  />
                ))}
            </ul>
          </div>
        ))
      )}
      {closed.length > 0 && (
        <details className="small">
          <summary>Recently closed ({closed.length})</summary>
          <ul className="plain">
            {closed.map((e) => (
              <li key={e.txHash}>
                {actorLabel(e.actor, ctx.nameOf)} ·{' '}
                {selectorName(e.data.slice(0, 10) as Hex) ?? e.data.slice(0, 10)} · {e.state}
                {e.cancelledBy && ` by ${ctx.nameOf?.(e.cancelledBy) ?? shortAddress(e.cancelledBy)}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <h3>Schedule an owner transaction</h3>
      <ScheduleOwnerTx engine={engine} currentNonce={nonce.data} onScheduled={queue.reload} />
    </Card>
  )
}
