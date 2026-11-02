import { useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { EXPLORER } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useNow } from '../../hooks/useNow'
import { formatDuration, formatTime } from '../../lib/format'
import { sendCallAsRole, simulateCallAsRole } from '../../lib/roleExec'
import {
  ANY,
  type ChangeSet,
  type EngineInfo,
  FreezeRole,
  type FreezeView,
  type LabelContext,
  type PreviewOutcome,
  type SafeV2Model,
  type V2Deployment,
  actorLabel,
  engineCalls,
  mergeRole,
  recoveryActors,
  recoveryStillPasses,
  roleChange,
  runPreview,
  swapOwnerCall,
} from '../../lib/v2'
import { parseAddressInput } from '../../lib/validation'
import { logActivity, rolesStore } from '../../store'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { InfoTip } from '../Tooltip'
import { AddressView, AsyncButton, Badge, Card, CopyButton, Field, Notice } from '../ui'

function Phase({ freeze, now }: { freeze: FreezeView; now: number }) {
  const at = (s: bigint) => formatTime(Number(s) * 1000)
  const left = (s: bigint) => formatDuration(Math.max(0, Number(s) - now))
  if (freeze.phase === 'frozen')
    return (
      <Badge tone="bad">
        Frozen until {at(freeze.until)} ({left(freeze.until)})
      </Badge>
    )
  if (freeze.phase === 'cooldown')
    return (
      <Badge tone="warn">
        Cooling down until {at(freeze.until)} ({left(freeze.until)}): cannot be frozen again
      </Badge>
    )
  return <Badge tone="ok">Active</Badge>
}

/** Guardians and lifters, with × to queue a removal and a form to queue an addition. */
function RoleMembers({
  model,
  draft,
  setDraft,
}: {
  model: SafeV2Model
  draft: ChangeSet
  setDraft: (next: ChangeSet) => void
}) {
  const [input, setInput] = useState('')
  const [role, setRole] = useState<FreezeRole>(FreezeRole.GUARDIAN)
  const parsed = parseAddressInput(input, 'address')
  const queue = (r: FreezeRole, account: Address, enabled: boolean) =>
    setDraft({ ...draft, roles: mergeRole(draft.roles, roleChange(r, account, enabled)) })
  const list = (r: FreezeRole, members: readonly Address[]) =>
    members.length === 0 ? (
      <span className="muted">none</span>
    ) : (
      members.map((m) => (
        <span key={m} className="row">
          <AddressView address={m} />
          <ConfirmIconButton
            title="Queue the removal of this member in the draft"
            onConfirm={() => queue(r, m, false)}
          />
        </span>
      ))
    )
  return (
    <div className="kv-list">
      <span className="field-label">
        Guardians
        <InfoTip>Freeze instantly (Safe-wide or one actor), at most MAX_FREEZE; may lift.</InfoTip>
      </span>
      <span className="kv-value row wrap">{list(FreezeRole.GUARDIAN, model.roles.guardians)}</span>
      <span className="field-label">
        Lifters
        <InfoTip>May only lift a freeze early (e.g. the recovery key). Owners never can.</InfoTip>
      </span>
      <span className="kv-value row wrap">{list(FreezeRole.LIFTER, model.roles.lifters)}</span>
      <span className="field-label">Add</span>
      <span className="kv-value row wrap">
        <select value={role} onChange={(e) => setRole(Number(e.target.value) as FreezeRole)}>
          <option value={FreezeRole.GUARDIAN}>guardian</option>
          <option value={FreezeRole.LIFTER}>lifter</option>
        </select>
        <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" />
        <button
          type="button"
          className="btn"
          disabled={!parsed.ok}
          onClick={() => {
            if (parsed.ok) queue(role, parsed.value, true)
            setInput('')
          }}
        >
          Add to draft
        </button>
      </span>
    </div>
  )
}

/** Freeze / lift as a local role that is a guardian or lifter; the calldata for anyone else. */
function FreezeActions({ deployment, model }: { deployment: V2Deployment; model: SafeV2Model }) {
  const { safe, state, reloadState } = useSandbox()
  const roles = rolesStore.use()
  const [actor, setActor] = useState<Address>(ANY)
  const [sent, setSent] = useState<string>()
  const members = [...model.roles.guardians, ...model.roles.lifters]
  const local = roles.filter((r) => members.some((m) => isAddressEqual(m, r.address)))
  const [who, setWho] = useState<string>(local[0]?.address ?? '')
  const role = local.find((r) => r.address === who)
  const isGuardian = role ? model.roles.guardians.some((g) => isAddressEqual(g, role.address)) : false
  const modules = state?.modules ?? []
  const freezeCall =
    actor === ANY
      ? engineCalls.freeze(deployment.engine, [safe])
      : engineCalls.freezeActor(deployment.engine, safe, actor)
  const liftCall = engineCalls.lift(deployment.engine, safe, actor)

  const act = async (call: typeof freezeCall) => {
    if (!role) return
    const denied = await simulateCallAsRole(role, call)
    if (denied) throw new Error(denied)
    const hash = await sendCallAsRole(role, call)
    setSent(hash)
    logActivity({
      role: role.address,
      mode: 'execute',
      label: call.description,
      status: 'sent',
      txHash: hash,
      link: `${EXPLORER}/tx/${hash}`,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    reloadState()
  }

  return (
    <div className="stack">
      <div className="row wrap align-end">
        <Field label="Target">
          <select value={actor} onChange={(e) => setActor(e.target.value as Address)}>
            <option value={ANY}>The whole Safe (Safe-wide)</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                Only {roles.find((r) => isAddressEqual(r.address, m))?.label ?? m} (kill switch)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Act as">
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {local.length === 0 && <option value="">no local guardian or lifter</option>}
            {local.map((r) => (
              <option key={r.address} value={r.address}>
                {r.label} (
                {model.roles.guardians.some((g) => isAddressEqual(g, r.address)) ? 'guardian' : 'lifter'})
              </option>
            ))}
          </select>
        </Field>
        <AsyncButton
          variant="danger"
          disabled={!role || !isGuardian}
          onClick={() => act(freezeCall)}
          title="Only a guardian may freeze"
        >
          Freeze
        </AsyncButton>
        <AsyncButton
          disabled={!role}
          onClick={() => act(liftCall)}
          title="Guardian or lifter: ends the freeze and starts the cooldown"
        >
          Lift
        </AsyncButton>
      </div>
      {sent && <span className="muted small">Sent {sent}</span>}
      <details className="small">
        <summary>Calldata for a guardian elsewhere (a hardware wallet, another Safe)</summary>
        <div>
          to <AddressView address={deployment.engine} /> · {freezeCall.description}
        </div>
        <div className="row">
          <code className="calldata">{freezeCall.data}</code>
          <CopyButton value={freezeCall.data} />
        </div>
        <div>{liftCall.description}</div>
        <div className="row">
          <code className="calldata">{liftCall.data}</code>
          <CopyButton value={liftCall.data} />
        </div>
      </details>
    </div>
  )
}

/** "Freeze, then recover": Recovery's swapOwner must only need its schedule, never be stopped by a Freeze. */
function RecoveryCheck({
  deployment,
  model,
  ctx,
}: {
  deployment: V2Deployment
  model: SafeV2Model
  ctx: LabelContext
}) {
  const { safe, state } = useSandbox()
  const [results, setResults] = useState<{ actor: Address; outcome?: PreviewOutcome; error?: string }[]>()
  const recovery = recoveryActors(safe, model.attachments)
  if (recovery.length === 0 || !state || state.owners.length === 0) return null
  const check = async () => {
    const call = swapOwnerCall(
      safe,
      state.owners,
      state.owners[0]!,
      '0x000000000000000000000000000000000000dEaD',
    )
    setResults(
      await Promise.all(
        recovery.map(async (actor) => {
          const result = await runPreview(publicClient, deployment, safe, actor, call, ctx)
          return result.ok ? { actor, outcome: result.outcome } : { actor, error: result.reason }
        }),
      ),
    )
  }
  return (
    <div className="stack">
      <div className="row">
        <AsyncButton
          onClick={check}
          title="Previews swapOwner(Owner 1 → 0x…dEaD) as each recovery actor, on the live configuration"
        >
          Check recovery still passes
        </AsyncButton>
      </div>
      {results?.map((r) => (
        <div key={r.actor} className="row wrap small">
          <strong>{actorLabel(r.actor, ctx.nameOf)}</strong>
          {r.error ? (
            <span className="error-text">{r.error}</span>
          ) : recoveryStillPasses(r.outcome!) ? (
            <Badge tone="ok">passes{r.outcome!.allowed ? '' : ' after its timelock (schedule first)'}</Badge>
          ) : (
            <Badge tone="bad">blocked: {r.outcome!.deciding?.reasonText}</Badge>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The engine's freeze (SPEC §7.1): Safe-wide and per actor, Active / Frozen until / Cooling down
 * until; guardians and lifters; Freeze and Lift as a local role; the recovery check.
 */
export function FreezePanel({
  deployment,
  info,
  model,
  draft,
  setDraft,
  ctx,
}: {
  deployment: V2Deployment
  info: EngineInfo | undefined
  model: SafeV2Model
  draft: ChangeSet
  setDraft: (next: ChangeSet) => void
  ctx: LabelContext
}) {
  const { v2Installed } = useSandbox()
  const now = useNow()
  const actorFreezes = model.actors.filter((a) => a.freeze && a.freeze.phase !== 'none')
  return (
    <Card
      title={
        <span className="row">
          Freeze
          <InfoTip>
            A guardian freezes at once, for at most {info ? formatDuration(info.maxFreeze) : 'MAX_FREEZE'},
            then a {info ? formatDuration(info.freezeCooldown) : 'cooldown'} cooldown during which it cannot
            freeze again. The Safe-wide freeze blocks applyConfiguration (requests and invalidations still
            work); everything else is by placement: a Freeze attached at an actor denies its transactions
            while frozen.
          </InfoTip>
        </span>
      }
    >
      <div className="kv-list">
        <span className="field-label">Safe-wide</span>
        <span className="kv-value">
          <Phase freeze={model.freeze} now={now} />
        </span>
        {actorFreezes.map((a) => (
          <span key={a.actor} className="contents">
            <span className="field-label">{actorLabel(a.actor, ctx.nameOf)}</span>
            <span className="kv-value">
              <Phase freeze={a.freeze!} now={now} />
            </span>
          </span>
        ))}
      </div>
      <h3>Roles</h3>
      <RoleMembers model={model} draft={draft} setDraft={setDraft} />
      {v2Installed && (
        <>
          <h3>Act</h3>
          <FreezeActions deployment={deployment} model={model} />
          <h3>Freeze, then recover</h3>
          <RecoveryCheck deployment={deployment} model={model} ctx={ctx} />
        </>
      )}
      {!v2Installed && (
        <Notice>Install V2 to freeze and lift; roles can already go into the install batch.</Notice>
      )}
    </Card>
  )
}
