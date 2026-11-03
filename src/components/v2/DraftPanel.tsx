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
  changeNote,
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
import { Card, Notice, Tag } from '../ui'
import { LintPanel, findingKey } from './LintPanel'
import { OwnerAction } from './OwnerAction'
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

/** Once installed: `engine.configure(draft)` as one owner transaction, judged like any other. */
function ConfigureActions({
  call,
  ownersDelay,
  blocked,
  onDone,
}: {
  call: OwnerCall
  ownersDelay: number
  blocked: boolean
  onDone: () => void
}) {
  return (
    <div className="stack">
      <h3>Apply</h3>
      {ownersDelay === 0 && (
        <Notice tone="warn">
          No owners&apos; Timelock covers configuration changes: this one applies as soon as the signers
          execute it.
        </Notice>
      )}
      {blocked ? (
        <p className="muted small">Fix or confirm the points above to apply the draft.</p>
      ) : (
        <OwnerAction
          call={call}
          delayLabel={ownersDelay > 0 ? durationLabel(ownersDelay) : undefined}
          onDone={onDone}
        />
      )}
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
}: {
  deployment: V2Deployment
  current: readonly Attachment[]
  draft: Change[]
  setDraft: (next: Change[]) => void
  findings: readonly LintFinding[]
  ctx: LabelContext
  /** The Safe's current fallback handler, once read. */
  handler?: Address
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
      title={
        <span className="row">
          Draft ({draft.length})
          <InfoTip>
            The changes you are preparing, applied together in one owner transaction. They run in this order:
            removals first, then Timelocks on any call before narrower rules, so a delay is always in place
            before what it protects.
          </InfoTip>
        </span>
      }
      actions={!empty && <ConfirmIconButton title="Clear the draft" onConfirm={clear} />}
    >
      {empty ? (
        <p className="muted">
          Empty. Add rules from the scope builder, or × a chip on the chart to remove one.
        </p>
      ) : (
        <ol className="draft-list">
          {ordered.map((c, i) => {
            const attached = current.some((a) => a.attachmentId === changeAttachmentId(c))
            const note = changeNote(c, deployment, attached)
            return (
              <li key={`${changeAttachmentId(c)}:${c.detach}`} className="draft-item">
                <Tag tone={c.detach ? 'bad' : attached ? 'info' : 'ok'} fixed>
                  {c.detach ? 'remove' : attached ? 'change' : 'add'}
                </Tag>
                <span>
                  {describeChange(c, deployment, ctx, attached, false)}
                  {note && <span className="draft-note">Note: {note}.</span>}
                  {problems
                    .filter((p) => p.index === i)
                    .map((p) => (
                      <span key={p.message} className="error-text draft-note">
                        {p.message}
                      </span>
                    ))}
                </span>
                <ConfirmIconButton
                  title="Remove from the draft"
                  onConfirm={() => setDraft(draft.filter((d) => d !== c))}
                />
              </li>
            )
          })}
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

      {v2Installed ? (
        !empty && (
          <ConfigureActions
            call={configureCall(deployment.engine, ordered)}
            ownersDelay={ownersDelay}
            blocked={blocked}
            onDone={clear}
          />
        )
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
