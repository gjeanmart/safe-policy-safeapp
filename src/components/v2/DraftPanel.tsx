import { useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useSandbox } from '../../context'
import { isModuleEnabled, safeTxs } from '../../lib/safe'
import {
  type Attachment,
  type Change,
  type LabelContext,
  type LintFinding,
  OWNERS,
  type OwnerCall,
  SAFE_HANDLERS,
  type V2Deployment,
  changeAttachmentId,
  configureCall,
  configureCoverIds,
  describeChange,
  durationLabel,
  installCalls,
  sortForApply,
  supportsV2,
  validateChanges,
} from '../../lib/v2'
import { rolesStore } from '../../store'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { ProposeButton } from '../ProposeButton'
import { InfoTip } from '../Tooltip'
import { Card, CopyButton, Notice } from '../ui'
import { LintPanel, findingKey } from './LintPanel'
import { toSafeTxs } from './ownerCalls'

/**
 * Before V2 is installed: `[configure, setFallbackHandler, setModuleGuard, setGuard]` in one batch
 * (leftovers detached first; the handler switch can be opted out of).
 */
function InstallActions({
  deployment,
  draft,
  leftovers,
  handler,
  blocked,
  onDone,
}: {
  deployment: V2Deployment
  draft: readonly Change[]
  leftovers: readonly Attachment[]
  /** The Safe's current fallback handler, once read. */
  handler?: Address
  blocked: boolean
  onDone: () => void
}) {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  const [enable, setEnable] = useState<Address[]>([])
  const [keepHandler, setKeepHandler] = useState(false)
  if (!state) return null
  if (!supportsV2(state.version))
    return (
      <Notice tone="bad">
        Safe {state.version} cannot run V2: the module guard (the check of every module transaction) needs
        Safe 1.5.0. Use a 1.5.0 Safe.
      </Notice>
    )
  const [configure, ...admin] = installCalls(safe, deployment, draft, leftovers, {
    fallbackHandler: keepHandler ? null : SAFE_HANDLERS.tokenCallback,
    currentHandler: handler,
  })
  const enableTxs = enable.map((m) => safeTxs.enableModule(safe, m))
  const batch = [...toSafeTxs([configure!]), ...enableTxs, ...toSafeTxs(admin)]
  const hasTokenHandler = handler !== undefined && isAddressEqual(handler, SAFE_HANDLERS.tokenCallback)
  const disabledRoles = roles.filter((r) => !isModuleEnabled(state, r.address))
  return (
    <div className="stack">
      {draft.length === 0 && (
        <Notice tone="warn">
          Installing with an empty configuration denies every owner and module transaction except
          engine.configure (deny by default). Start from the Owners template.
        </Notice>
      )}
      {leftovers.length > 0 && (
        <Notice tone="warn">
          This Safe has {leftovers.length} attachment{leftovers.length === 1 ? '' : 's'} from an earlier
          install (shown on the chart). The install batch detaches the ones the draft does not keep, in the
          same configure.
        </Notice>
      )}
      {disabledRoles.length > 0 && (
        <div className="field">
          <span className="field-label">
            Also enable these roles as modules in the install batch
            <InfoTip>
              Once V2 guards the owners, enableModule is an owner transaction like any other (Allow, then the
              owners&apos; Timelock). A new module can still do nothing until something is attached to it.
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
      {!hasTokenHandler && (
        <label className="row">
          <input type="checkbox" checked={keepHandler} onChange={(e) => setKeepHandler(e.target.checked)} />
          Keep the current fallback handler (do not switch to TokenCallbackHandler)
          <InfoTip>
            By default the install batch sets Safe&apos;s TokenCallbackHandler ({SAFE_HANDLERS.tokenCallback}
            ): it receives ERC-721 / ERC-1155 but does not implement ERC-1271. Keeping an ERC-1271 handler
            (CompatibilityFallbackHandler) lets the owners&apos; off-chain signatures (Permit, Permit2, CoW
            orders) move funds with no policy running: the owners&apos; Timelock, the guardians&apos; freeze
            and recovery no longer bound a key compromise. Only keep it if this Safe must sign messages
            off-chain.
          </InfoTip>
        </label>
      )}
      {keepHandler && !hasTokenHandler && (
        <Notice tone="warn">
          The fallback handler stays as it is: if it implements ERC-1271, off-chain owner signatures bypass
          every policy.
        </Notice>
      )}
      <ProposeButton
        label="Propose install batch"
        txs={blocked ? [] : batch}
        info={`One owner transaction, batched by Safe{Wallet} through MultiSendCallOnly: configure (before any guard, so nothing checks it), ${keepHandler || hasTokenHandler ? '' : 'setFallbackHandler(TokenCallbackHandler), '}then setModuleGuard and setGuard.`}
        onProposed={onDone}
      />
    </div>
  )
}

/** Once installed: `engine.configure(draft)` as one owner transaction, delayed by the owners' Timelock. */
function ConfigureActions({
  deployment,
  call,
  ownersDelay,
  blocked,
  onDone,
  onSchedule,
}: {
  deployment: V2Deployment
  call: OwnerCall
  ownersDelay: number
  blocked: boolean
  onDone: () => void
  onSchedule: (call: OwnerCall) => void
}) {
  return (
    <div className="stack">
      {ownersDelay > 0 ? (
        <Notice>
          The owners&apos; Timelock covers engine.configure: this change must be <strong>scheduled</strong>{' '}
          and waits {durationLabel(ownersDelay)} (frozen while a guardian freezes the owners; a configure
          schedule is never voided by a freeze). Propose it in Safe{'{Wallet}'}, collect the signatures, then
          schedule it in the queue below; or sign it here with local owner keys. Keep safeTxGas and gasPrice
          at 0 in Safe{'{Wallet}'} (V2 refuses any other value).
        </Notice>
      ) : (
        <Notice tone="warn">
          No owners&apos; Timelock covers engine.configure: this change applies as soon as the owners execute
          it.
        </Notice>
      )}
      <div className="row wrap">
        <ProposeButton
          label="Propose configure"
          txs={blocked ? [] : toSafeTxs([call])}
          info="engine.configure(changes): an ordinary owner transaction, alone (never inside a batch), judged by the owners' policies like any other call. It uses the next Safe nonce: an owner schedule waiting at that nonce dies."
          onProposed={onDone}
        />
        {ownersDelay > 0 && (
          <button type="button" className="btn" disabled={blocked} onClick={() => onSchedule(call)}>
            Schedule with local owner keys…
          </button>
        )}
        <span className="small muted">
          to {deployment.engine.slice(0, 10)}… · calldata <CopyButton value={call.data} />
        </span>
      </div>
    </div>
  )
}

/**
 * The draft, what the engine would refuse, the lint findings over the result, and the next owner
 * transaction: install or configure.
 */
export function DraftPanel({
  deployment,
  current,
  draft,
  setDraft,
  findings,
  ctx,
  handler,
  onSchedule,
}: {
  deployment: V2Deployment
  current: readonly Attachment[]
  draft: Change[]
  setDraft: (next: Change[]) => void
  findings: readonly LintFinding[]
  ctx: LabelContext
  /** The Safe's current fallback handler, once read. */
  handler?: Address
  onSchedule: (call: OwnerCall) => void
}) {
  const { safe, v2Installed } = useSandbox()
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const ordered = sortForApply(deployment, draft)
  // Before install, leftovers the draft does not touch are detached by the install batch.
  const touched = new Set(draft.map(changeAttachmentId))
  const base = v2Installed ? current : current.filter((a) => touched.has(a.attachmentId))
  const problems = validateChanges(base, ordered, { deployment, safe })
  const unconfirmed = findings.filter((f) => f.severity === 'block' && !confirmed.has(findingKey(f)))
  const empty = draft.length === 0
  const blocked = empty || problems.length > 0 || unconfirmed.length > 0
  const clear = () => setDraft([])
  const covers = new Set(configureCoverIds(deployment, OWNERS))
  const ownersDelay = Math.max(
    0,
    ...current
      .filter((a) => covers.has(a.attachmentId))
      .map((a) => (a.settings?.policy === 'timelock' ? a.settings.settings.delay : 0)),
  )

  return (
    <Card
      title={`Draft (${draft.length})`}
      actions={!empty && <ConfirmIconButton title="Clear the draft" onConfirm={clear} />}
    >
      {empty ? (
        <p className="muted">Add rules from the scope builder, or × a chip to queue a detach.</p>
      ) : (
        <ol className="stack draft-list">
          {ordered.map((c, i) => (
            <li key={`${changeAttachmentId(c)}:${c.detach}`} className="row wrap">
              <span>
                {describeChange(
                  c,
                  deployment,
                  ctx,
                  current.some((a) => a.attachmentId === changeAttachmentId(c)),
                )}
              </span>
              <ConfirmIconButton
                title="Remove from the draft"
                onConfirm={() => setDraft(draft.filter((d) => d !== c))}
              />
              {problems
                .filter((p) => p.index === i)
                .map((p) => (
                  <span key={p.message} className="error-text">
                    {p.message}
                  </span>
                ))}
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">
        Applied in this order: detaches first, Timelocks on any call before narrower ones.
      </p>

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

      {v2Installed ? (
        <ConfigureActions
          deployment={deployment}
          call={configureCall(deployment.engine, ordered)}
          ownersDelay={ownersDelay}
          blocked={blocked}
          onDone={clear}
          onSchedule={onSchedule}
        />
      ) : (
        <InstallActions
          deployment={deployment}
          draft={draft}
          leftovers={current}
          handler={handler}
          blocked={blocked && !(empty && problems.length === 0 && unconfirmed.length === 0)}
          onDone={clear}
        />
      )}
    </Card>
  )
}
