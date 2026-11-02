import { useState } from 'react'
import type { Address } from 'viem'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { formatDuration } from '../../lib/format'
import { isModuleEnabled, safeTxs } from '../../lib/safe'
import {
  type ChangeSet,
  type EngineInfo,
  type LabelContext,
  type LintFinding,
  type SafeV2Model,
  type V2Deployment,
  changeSetRoot,
  describeChange,
  describeRoleChange,
  emptyChangeSet,
  engineCalls,
  installCalls,
  readRootValidFrom,
  rootStatus,
  supportsV2,
  validateChangeSet,
} from '../../lib/v2'
import { rolesStore, v2PendingStore } from '../../store'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { ProposeButton } from '../ProposeButton'
import { InfoTip } from '../Tooltip'
import { Card, Notice } from '../ui'
import { LintPanel, findingKey } from './LintPanel'
import { toSafeTxs } from './ownerCalls'

const ROOT_REFRESH_MS = 5_000

/** Before V2 is installed: one batch (or four steps) that configures, sets the handler and both guards. */
function InstallActions({
  deployment,
  draft,
  blocked,
  onDone,
}: {
  deployment: V2Deployment
  draft: ChangeSet
  blocked: boolean
  onDone: () => void
}) {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  const [stepByStep, setStepByStep] = useState(false)
  const [enable, setEnable] = useState<Address[]>([])
  if (!state) return null
  if (!supportsV2(state.version))
    return (
      <Notice tone="bad">
        Safe {state.version} cannot run V2: the module guard (and so any check of module transactions) needs
        Safe 1.5.0. Use a 1.5.0 Safe.
      </Notice>
    )
  const [configure, handler, moduleGuard, guard] = installCalls(safe, deployment, draft)
  const enableTxs = enable.map((m) => safeTxs.enableModule(safe, m))
  const batch = [...toSafeTxs([configure!, handler!]), ...enableTxs, ...toSafeTxs([moduleGuard!, guard!])]
  const disabledRoles = roles.filter((r) => !isModuleEnabled(state, r.address))
  return (
    <div className="stack">
      {draft.changes.length === 0 && (
        <Notice tone="warn">
          Installing with an empty configuration denies every owner and module transaction except
          configuration changes (deny by default). Start from the Owners template.
        </Notice>
      )}
      {disabledRoles.length > 0 && (
        <div className="field">
          <span className="field-label">
            Also enable these roles as modules in the install batch
            <InfoTip>
              Once V2 guards the owners, enableModule is an owner transaction like any other (Allow +
              Timelock). Enabling now avoids the wait; a new module can still do nothing until something is
              attached to it.
            </InfoTip>
          </span>
          <div className="checklist">
            {disabledRoles.map((r) => (
              <label key={r.address} className="row">
                <input
                  type="checkbox"
                  checked={enable.includes(r.address)}
                  onChange={(e) =>
                    setEnable((list) =>
                      e.target.checked ? [...list, r.address] : list.filter((a) => a !== r.address),
                    )
                  }
                />
                <strong>{r.label}</strong> <span className="mono muted">{r.address}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <label className="row small">
        <input type="checkbox" checked={stepByStep} onChange={(e) => setStepByStep(e.target.checked)} />
        Step by step (one owner transaction each, in this order)
      </label>
      {stepByStep ? (
        <ol className="stack">
          <li>
            <ProposeButton
              label="1 · Configure"
              txs={toSafeTxs([configure!])}
              preview={false}
              title={configure!.description}
            />
          </li>
          <li>
            <ProposeButton
              label="2 · Fallback handler"
              txs={toSafeTxs([handler!])}
              preview={false}
              title={handler!.description}
            />
          </li>
          {enableTxs.length > 0 && (
            <li>
              <ProposeButton label="3 · Enable modules" txs={enableTxs} preview={false} />
            </li>
          )}
          <li>
            <ProposeButton
              label="Module guard"
              txs={toSafeTxs([moduleGuard!])}
              preview={false}
              title={moduleGuard!.description}
            />
          </li>
          <li>
            <ProposeButton
              label="Guard (last)"
              txs={toSafeTxs([guard!])}
              preview={false}
              title={guard!.description}
              info="Last: once the transaction guard is set, every owner transaction is checked, so the steps above would need an Allow and wait the owners' Timelock. configureImmediately only works before either guard is set."
              onProposed={onDone}
            />
          </li>
        </ol>
      ) : (
        <ProposeButton
          label="Propose install batch"
          txs={blocked ? [] : batch}
          info="One owner transaction, batched by Safe{Wallet} through MultiSendCallOnly: configureImmediately first (refused once a guard is set), the PolicyFallbackHandler, the module guard, the guard last. No unguarded window."
          onProposed={onDone}
        />
      )}
    </div>
  )
}

/** Once installed: request the draft's root, wait DELAY, then apply the same set (two owner transactions). */
function ConfigureActions({
  deployment,
  info,
  model,
  draft,
  blocked,
  onDone,
}: {
  deployment: V2Deployment
  info: EngineInfo
  model: SafeV2Model
  draft: ChangeSet
  blocked: boolean
  onDone: () => void
}) {
  const { safe } = useSandbox()
  const now = BigInt(useNow())
  const root = changeSetRoot(draft)
  const validFrom = useAsync(
    () => readRootValidFrom(publicClient, deployment.engine, safe, root),
    `${deployment.engine}:${safe}:${root}`,
    ROOT_REFRESH_MS,
  )
  const status = validFrom.data === undefined ? 'none' : rootStatus(validFrom.data, info.expiry, now)
  const remember = () =>
    v2PendingStore.set((list) => [
      ...list.filter((p) => p.root !== root),
      { root, safe, engine: deployment.engine, set: draft, createdAt: Date.now() },
    ])
  const nonceNote =
    'A configuration call skips every policy (no Timelock) but is still an owner transaction: it uses the next Safe nonce, so an owner schedule waiting at that nonce can never execute (Timelock queue).'
  return (
    <div className="stack">
      {status === 'pending' && (
        <Notice>
          Already requested: applicable in {formatDuration(validFrom.data! - now)} (engine DELAY{' '}
          {formatDuration(info.delay)}).
        </Notice>
      )}
      {status === 'ready' && model.freeze.phase === 'frozen' && (
        <Notice tone="bad">
          The Safe is frozen: applying is refused (ConfigFrozen) until the freeze ends or is lifted.
        </Notice>
      )}
      <div className="row wrap">
        {(status === 'none' || status === 'expired') && (
          <ProposeButton
            label="Propose configuration request"
            txs={blocked ? [] : toSafeTxs([engineCalls.requestConfiguration(deployment.engine, root)])}
            info={`requestConfiguration(root): the set applies after DELAY (${formatDuration(info.delay)}), never sooner, whatever the owners' Timelock. ${nonceNote}`}
            onProposed={() => {
              remember()
              onDone()
            }}
          />
        )}
        {status === 'ready' && (
          <ProposeButton
            label="Propose apply"
            txs={blocked ? [] : toSafeTxs([engineCalls.applyConfiguration(deployment.engine, draft)])}
            info={`applyConfiguration with this exact set. ${nonceNote}`}
            onProposed={() => {
              v2PendingStore.set((list) => list.filter((p) => p.root !== root))
              onDone()
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The draft (attachment and role changes), what the engine would refuse, the lint findings over the
 * result, and the next owner transaction: install, request or apply.
 */
export function DraftPanel({
  deployment,
  info,
  model,
  draft,
  setDraft,
  findings,
  ctx,
}: {
  deployment: V2Deployment
  info: EngineInfo | undefined
  model: SafeV2Model
  draft: ChangeSet
  setDraft: (next: ChangeSet) => void
  findings: readonly LintFinding[]
  ctx: LabelContext
}) {
  const { v2Installed } = useSandbox()
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const problems = info
    ? validateChangeSet(model.attachments, draft, { deployment, delay: info.delay, roles: model.roles })
    : []
  const unconfirmed = findings.filter((f) => f.severity === 'block' && !confirmed.has(findingKey(f)))
  const empty = draft.changes.length === 0 && draft.roles.length === 0
  const blocked = empty || problems.length > 0 || unconfirmed.length > 0
  const clear = () => setDraft(emptyChangeSet())
  const remove = (i: number) => setDraft({ ...draft, changes: draft.changes.filter((_, j) => j !== i) })
  const removeRole = (i: number) => setDraft({ ...draft, roles: draft.roles.filter((_, j) => j !== i) })

  return (
    <Card
      title={`Draft (${draft.changes.length + draft.roles.length})`}
      actions={!empty && <ConfirmIconButton title="Clear the draft" onConfirm={clear} />}
    >
      {empty ? (
        <p className="muted">Add attachments from the scope builder, or × a chip to queue a detach.</p>
      ) : (
        <ol className="stack draft-list">
          {draft.changes.map((c, i) => {
            const own = problems.filter((p) => !p.role && p.index === i)
            return (
              <li key={`c${i}`} className="row wrap">
                <span>{describeChange(c, deployment, ctx)}</span>
                <ConfirmIconButton title="Remove from the draft" onConfirm={() => remove(i)} />
                {own.map((p) => (
                  <span key={p.message} className="error-text">
                    {p.message}
                  </span>
                ))}
              </li>
            )
          })}
          {draft.roles.map((r, i) => (
            <li key={`r${i}`} className="row wrap">
              <span>{describeRoleChange(r, ctx)}</span>
              <ConfirmIconButton title="Remove from the draft" onConfirm={() => removeRole(i)} />
              {problems
                .filter((p) => p.role && p.index === i)
                .map((p) => (
                  <span key={p.message} className="error-text">
                    {p.message}
                  </span>
                ))}
            </li>
          ))}
        </ol>
      )}

      <LintPanel
        findings={findings}
        confirmed={confirmed}
        onConfirm={(key, value) =>
          setConfirmed((set) => {
            const next = new Set(set)
            if (value) next.add(key)
            else next.delete(key)
            return next
          })
        }
      />

      {problems.length > 0 && (
        <Notice tone="bad">The engine would refuse this draft: fix the changes marked in red.</Notice>
      )}

      {info &&
        (v2Installed ? (
          <ConfigureActions
            deployment={deployment}
            info={info}
            model={model}
            draft={draft}
            blocked={blocked}
            onDone={clear}
          />
        ) : (
          <InstallActions deployment={deployment} draft={draft} blocked={blocked && !empty} onDone={clear} />
        ))}
    </Card>
  )
}
